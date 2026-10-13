import { hubFile, type Config } from '../../src/config.ts';
import { hubGraph, type HubGraph } from '../../src/graph.ts';
import { runContext } from '../../src/preload.ts';
import { Harness, Mode } from '../../src/schema.ts';

type HubNode = HubGraph['nodes'][number];
export type NodeKind = HubNode['kind'];
export type EdgeKind = HubGraph['edges'][number]['kind'];
export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

type RunContext = ReturnType<typeof runContext>;

/**
 * What one step, a job or a check, hands the bot it casts: what it looks at and sees first, the tools it uses, what
 * it returns (a check returns a verdict), and the tracker.
 */
export type StepContext = RunContext & {
  step: string;
  bot: string;
  skill?: string;
  verdict?: true;
  issues?: Config['hub']['issues'];
};

export type GraphNode = Omit<HubNode, 'badges' | 'detail'> & {
  badges?: { text: string; tone?: Tone }[];
  detail?: {
    summary?: string;
    fields?: [name: string, value: string][];
    sections?: { title: string; body: string }[];
  };
  source?: { root: string; path: string };
  data?: Record<string, unknown>;
  context?: StepContext[];
  stack?: { owner: string; members: string[]; facets: { key: string; counts: [value: string, count: number][] }[] };
};

export type GraphEdge = HubGraph['edges'][number];
export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[] };

export const modeTone: Record<Mode, Tone> = { log: 'neutral', warn: 'warn', block: 'danger' };
const tone = (text: string): Tone | undefined => {
  const mode = Mode.safeParse(text);
  if (mode.success) return modeTone[mode.data];
  if (Harness.safeParse(text).success) return 'info';
};

const show = (value: unknown) =>
  Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value.join(', ') || '-'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

const prose = new Set(['role', 'prompt', 'run']);
const isSection = ([key, value]: [string, unknown]) =>
  typeof value === 'string'
    ? prose.has(key) || value.includes('\n')
    : Array.isArray(value) && value.some(item => typeof item === 'object');
const sectionBody = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map(item => (typeof item === 'object' && item ? Object.values(item).filter(Boolean).join(', ') : String(item)))
        .join('\n')
    : String(value);

const summary = (node: HubNode): string | undefined => {
  const d = node.detail ?? {};
  const first = (value: unknown) => (typeof value === 'string' ? value.split('\n')[0] : undefined);
  switch (node.kind) {
    case 'trigger':
      return show(d.workflow);
    case 'job':
      return Array.isArray(d.returns) ? `returns: ${show(d.returns)}` : undefined;
    case 'bot':
      return `returns: ${show(d.returns)}`;
    case 'skill':
      return first(d.description);
    case 'check':
      return first(d.description) ?? first(d.run);
    case 'script':
      return first(d.run);
    case 'note':
      return Array.isArray(d.notes) ? `${d.notes.length} notes` : undefined;
    case 'issues':
      return typeof d.issues === 'string' ? `${d.issues} issue tracker` : undefined;
    case 'tool':
      return 'read-only hub tool';
  }
};

const sourcePath = (node: HubNode, config: Config): string | undefined => {
  const [, ref = ''] = /^[a-z]+:(.*)$/.exec(node.id) ?? [];
  switch (node.kind) {
    case 'bot':
      return config.bots[ref]?.path;
    case 'skill':
      return config.skills[ref]?.path;
    case 'check':
      return config.checks[ref]?.path;
    case 'trigger':
    case 'job':
    case 'script':
      return config.workflows[String(node.detail?.workflow)]?.path;
    case 'note':
      return;
    case 'issues':
      return hubFile;
    case 'tool':
      return;
  }
};

/** Folds the per-check `loops-back` edges into one self-loop per job. */
export const retryLoops = (model: GraphModel): GraphModel => {
  const loops = new Map<string, { checks: string[]; label?: string | undefined }>();
  for (const edge of model.edges) {
    if (edge.kind !== 'loops-back') continue;
    const loop = loops.get(edge.to) ?? { checks: [], label: edge.label };
    loop.checks.push(model.nodes.find(n => n.id === edge.from)?.label ?? edge.from);
    loops.set(edge.to, loop);
  }
  if (!loops.size) return model;
  return {
    nodes: model.nodes,
    edges: [
      ...model.edges.filter(edge => edge.kind !== 'loops-back'),
      ...[...loops].map(([job, { checks, label }]) => ({
        from: job,
        to: job,
        kind: 'loops-back' as const,
        label: [`${checks.length > 1 ? 'any check' : checks[0]} fails${label ? ',' : ''}`, label]
          .filter(Boolean)
          .join(' '),
      })),
    ],
  };
};

/** The context each step and each bot it casts would start with, by node id. */
const contexts = (config: Config) => {
  const found = new Map<string, StepContext[]>();
  const add = (id: string, context: StepContext) => found.set(id, [...(found.get(id) ?? []), context]);
  const cast = (
    step: string,
    botName: string,
    skillName: string | undefined,
    run: NonNullable<Parameters<typeof runContext>[0]['step']>,
    verdict = false
  ) => {
    const bot = config.bots[botName];
    if (!bot) return;
    const skill = skillName ? config.skills[skillName] : undefined;
    const context = runContext({ bot, step: run });
    const tracker =
      context.preload.some(p => p === 'issue' || p === 'links') || context.hubTools.some(t => t.startsWith('issues_'));
    const entry: StepContext = {
      ...context,
      step,
      bot: `bot:${bot.name}`,
      ...(skill && { skill: `skill:${skill.name}` }),
      ...(verdict && { verdict, returns: [] }),
      ...(tracker && { issues: config.hub.issues }),
    };
    add(step, entry);
    add(entry.bot, entry);
  };
  for (const workflow of Object.values(config.workflows))
    for (const [id, job] of Object.entries(workflow.jobs))
      if (job.type === 'bot') cast(`job:${workflow.name}/${id}`, job.bot, job.skill, job);
  for (const check of Object.values(config.checks))
    if (check.type === 'bot')
      cast(`check:${check.name}`, check.bot, check.skill, { over: check.over, tools: undefined }, true);
  return found;
};

/** What the canvas draws: the flow alone, or the flow with the bots and skills its steps cast. */
export type Layer = 'flow' | 'cast';

const flowEdges = new Set<EdgeKind>(['triggers', 'needs', 'gates', 'loops-back']);
const castEdges = new Set<EdgeKind>(['runs-as', 'fans-out', 'uses-skill']);
const contextKinds = new Set<NodeKind>(['note', 'tool', 'issues']);

/**
 * The part of the model a layer draws. The flow holds triggers, jobs and the checks that gate them, linked by what
 * starts, orders and gates them. The cast layer adds bots, skills and loose checks with one edge per cast. Notes,
 * tools and the issue tracker are context, never nodes.
 */
export const layerModel = (model: GraphModel, layer: Layer): GraphModel => {
  const gating = new Set(model.edges.filter(e => e.kind === 'gates').map(e => e.from));
  const inFlow = (node: GraphNode) =>
    node.kind === 'trigger' || node.kind === 'job' || node.kind === 'script' || gating.has(node.id);
  const nodes = model.nodes.filter(node =>
    layer === 'flow' ? inFlow(node) : inFlow(node) || !contextKinds.has(node.kind)
  );
  const shown = new Set(nodes.map(node => node.id));
  return {
    nodes,
    edges: model.edges.filter(
      edge =>
        shown.has(edge.from) &&
        shown.has(edge.to) &&
        (flowEdges.has(edge.kind) || (layer === 'cast' && castEdges.has(edge.kind)))
    ),
  };
};

/** The core hub graph with display details: toned badges, summaries, fields, long text as sections, source files, the raw detail as `data` and each step's context. */
export const graphModel = (config: Config): GraphModel => {
  const { nodes, edges } = hubGraph(config);
  const context = contexts(config);
  return {
    edges,
    nodes: nodes.map(({ badges, detail = {}, ...node }) => {
      const steps = context.get(node.id);
      const entries = Object.entries(detail).filter(([, value]) => value !== undefined);
      const path = sourcePath({ ...node, detail }, config);
      const s = summary({ ...node, detail });
      return {
        ...node,
        ...(badges && {
          badges: badges.map(text => {
            const t = tone(text);
            return { text, ...(t && { tone: t }) };
          }),
        }),
        detail: {
          ...(s && { summary: s }),
          fields: entries
            .filter(entry => !isSection(entry))
            .map(([key, value]): [string, string] => [key, show(value)]),
          sections: entries.filter(isSection).map(([title, value]) => ({ title, body: sectionBody(value) })),
        },
        ...(path && { source: { root: 'hub', path } }),
        data: Object.fromEntries(entries),
        ...(steps && { context: steps }),
      };
    }),
  };
};
