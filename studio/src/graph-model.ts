import { hubFile, type Config } from '../../src/config.ts';
import { hubGraph, type HubGraph } from '../../src/graph.ts';
import { Harness, Mode } from '../../src/schema.ts';

type HubNode = HubGraph['nodes'][number];
export type NodeKind = HubNode['kind'];
export type EdgeKind = HubGraph['edges'][number]['kind'];
export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

export type GraphNode = Omit<HubNode, 'badges' | 'detail'> & {
  badges?: { text: string; tone?: Tone }[];
  detail?: {
    summary?: string;
    fields?: [name: string, value: string][];
    sections?: { title: string; body: string }[];
  };
  source?: { root: string; path: string };
  data?: Record<string, unknown>;
};

export type GraphEdge = HubGraph['edges'][number];
export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[] };

export const modeTone: Record<Mode, Tone> = { shadow: 'neutral', warn: 'warn', block: 'danger' };
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
      return Array.isArray(d.can) ? `can: ${show(d.can)}` : undefined;
    case 'bot':
      return `can: ${show(d.can)}`;
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
      return 'read-only hub tool, served over MCP';
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

/** The core hub graph with display details: toned badges, summaries, fields, long text as sections, source files and the raw detail as `data`. */
export const graphModel = (config: Config): GraphModel => {
  const { nodes, edges } = hubGraph(config);
  return {
    edges,
    nodes: nodes.map(({ badges, detail = {}, ...node }) => {
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
      };
    }),
  };
};
