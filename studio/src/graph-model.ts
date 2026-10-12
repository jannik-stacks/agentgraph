import type { Config } from '../../src/config.ts';
import type { Mode } from '../../src/schema.ts';

export const nodeKinds = ['trigger', 'job', 'bot', 'skill', 'check', 'note', 'script'] as const;
export const edgeKinds = [
  'triggers',
  'needs',
  'runs-as',
  'uses-skill',
  'gates',
  'loops-back',
  'fans-out',
  'reads-notes',
] as const;

export type NodeKind = (typeof nodeKinds)[number];
export type EdgeKind = (typeof edgeKinds)[number];
export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

export type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  badges?: { text: string; tone?: Tone }[];
  detail?: {
    summary?: string;
    fields?: [name: string, value: string][];
    sections?: { title: string; body: string }[];
  };
  source?: { root: string; path: string };
};

export type GraphEdge = { from: string; to: string; kind: EdgeKind; label?: string };
export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[] };

const modeTone: Record<Mode, Tone> = { shadow: 'neutral', warn: 'warn', block: 'danger' };
const list = (items: readonly string[]) => (items.length ? items.join(', ') : '-');
const json = (value: unknown) => JSON.stringify(value);
const keys = <K extends string>(record: Partial<Record<K, unknown>>) => Object.keys(record) as K[];

/** Builds the studio graph from a compiled hub config. */
export const graphModel = (config: Config): GraphModel => {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const persona of Object.values(config.personas))
    nodes.push({
      id: `bot:${persona.name}`,
      kind: 'bot',
      source: { root: 'hub', path: persona.path },
      label: persona.name,
      badges: [{ text: persona.executor, tone: 'info' }, ...(persona.model ? [{ text: persona.model }] : [])],
      detail: {
        summary: `can write: ${list(persona['can-write'])}`,
        fields: [
          ['path', persona.path],
          ['executor', persona.executor],
          ['model', persona.model ?? 'default'],
          ['tools', list(persona.tools)],
          ['can write', list(persona['can-write'])],
          ['max turns', String(persona['max-turns'])],
          ['timeout', `${persona['timeout-minutes']} min`],
          ...(persona.budget ? [['budget', json(persona.budget)] as [string, string]] : []),
        ],
      },
    });

  for (const workflow of Object.values(config.workflows)) {
    const wf = workflow.name;
    const triggerId = (trigger: string) => `trigger:${wf}:${trigger}`;
    const jobId = (job: string) => `job:${wf}:${job}`;

    for (const [trigger, filter = {}] of Object.entries(workflow.on))
      nodes.push({
        id: triggerId(trigger),
        kind: 'trigger',
        source: { root: 'hub', path: workflow.path },
        label: filter.command ?? trigger,
        detail: {
          summary: filter.command ? trigger : `${wf}${filter.types ? `: ${list(filter.types)}` : ''}`,
          fields: [
            ['workflow', wf],
            ['event', trigger],
            ...Object.entries(filter).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : json(v)]),
          ],
        },
      });

    for (const [id, job] of Object.entries(workflow.jobs)) {
      const prompt = workflow.prompts[id];
      const outputs = keys(job['safe-outputs']);
      nodes.push({
        id: jobId(id),
        kind: job.persona ? 'job' : 'script',
        source: { root: 'hub', path: workflow.path },
        label: id,
        badges: [{ text: job.mode, tone: modeTone[job.mode] }],
        detail: {
          summary: outputs.length
            ? list(outputs)
            : list(job.steps.map(step => step.name ?? ('run' in step ? step.run : step.uses))),
          fields: [
            ['workflow', wf],
            ['mode', job.mode],
            ['bot', job.persona ?? '-'],
            ['needs', list(job.needs)],
            ['on', job.on ? list(keys(job.on)) : 'all workflow triggers'],
            ['runs on', job['runs-on']],
            ...Object.entries(job['safe-outputs']).map(([kind, output]): [string, string] => [
              kind,
              [`max ${output.max}`, output.paths && `paths ${list(output.paths)}`, output.environment]
                .filter(Boolean)
                .join(', '),
            ]),
            ...(job.environment ? [['environment', job.environment] as [string, string]] : []),
            ...(job['timeout-minutes'] ? [['timeout', `${job['timeout-minutes']} min`] as [string, string]] : []),
            ...(job.budget ? [['budget', json(job.budget)] as [string, string]] : []),
          ],
          sections: prompt === undefined ? [] : [{ title: `## ${id}`, body: prompt }],
        },
      });

      if (prompt !== undefined) {
        nodes.push({
          id: `skill:${wf}:${id}`,
          kind: 'skill',
          source: { root: 'hub', path: workflow.path },
          label: `## ${id}`,
          detail: { summary: prompt.split('\n')[0] ?? '', sections: [{ title: `## ${id}`, body: prompt }] },
        });
        edges.push({ from: jobId(id), to: `skill:${wf}:${id}`, kind: 'uses-skill' });
      }
      if (job.on || !job.needs.length)
        for (const trigger of keys(job.on ?? workflow.on))
          edges.push({ from: triggerId(trigger), to: jobId(id), kind: 'triggers' });
      for (const need of job.needs) edges.push({ from: jobId(need), to: jobId(id), kind: 'needs' });
      if (job.persona && job.persona in config.personas)
        edges.push({ from: jobId(id), to: `bot:${job.persona}`, kind: 'runs-as' });
    }
  }
  return { nodes, edges };
};
