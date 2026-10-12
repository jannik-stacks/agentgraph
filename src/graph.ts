import type { Config } from './config.ts';
import { NoteKind } from './schema.ts';

/** A node and edge model of a hub, for rendering. Ids are prefixed by kind, like `job:issue/implement`. */
export type HubGraph = {
  nodes: {
    id: string;
    kind: 'trigger' | 'job' | 'bot' | 'skill' | 'check' | 'note' | 'script';
    label: string;
    badges?: string[];
    detail?: Record<string, unknown>;
  }[];
  edges: {
    from: string;
    to: string;
    kind: 'triggers' | 'needs' | 'runs-as' | 'uses-skill' | 'gates' | 'loops-back' | 'fans-out' | 'reads-notes';
    label?: string;
  }[];
};

const badges = (...items: (string | false | undefined)[]) => items.filter((item): item is string => Boolean(item));

/**
 * Builds the hub graph: triggers start jobs, jobs (or scripts) need jobs, run as bots with skills and loop back
 * from their `until` checks; bots and skills read notes, one node per note kind.
 */
export const hubGraph = (config: Config): HubGraph => {
  const graph: HubGraph = { nodes: [], edges: [] };
  const node = (n: HubGraph['nodes'][number]) => graph.nodes.push(n);
  const edge = (e: HubGraph['edges'][number]) => graph.edges.push(e);
  const reads = new Set<NoteKind>();
  const readNotes = (from: string, kinds: NoteKind[] = []) =>
    kinds.forEach(kind => {
      reads.add(kind);
      edge({ from, to: `note:${kind}`, kind: 'reads-notes' });
    });
  const runsAs = (from: string, bot: string, forEach: string | undefined) =>
    edge({
      from,
      to: `bot:${bot}`,
      ...(forEach ? { kind: 'fans-out', label: `for each ${forEach}` } : { kind: 'runs-as' }),
    });

  for (const workflow of Object.values(config.workflows)) {
    const jobId = (id: string) => `${workflow.jobs[id]?.run ? 'script' : 'job'}:${workflow.name}/${id}`;
    for (const [trigger, filter] of Object.entries(workflow.on))
      node({
        id: `trigger:${workflow.name}/${trigger}`,
        kind: 'trigger',
        label: trigger,
        badges: badges(filter?.command, ...(filter?.types ?? [])),
        detail: { workflow: workflow.name, ...filter },
      });

    for (const [id, job] of Object.entries(workflow.jobs)) {
      const self = jobId(id);
      const { on, needs, ...rest } = job;
      node({
        id: self,
        kind: job.run ? 'script' : 'job',
        label: id,
        badges: badges(job.mode, job.branch, job.environment && `environment ${job.environment}`),
        detail: { workflow: workflow.name, ...rest },
      });
      for (const trigger of Object.keys(on ?? (needs.length ? {} : workflow.on)))
        edge({ from: `trigger:${workflow.name}/${trigger}`, to: self, kind: 'triggers' });
      for (const need of needs) edge({ from: jobId(need), to: self, kind: 'needs' });
      if (job.bot) runsAs(self, job.bot, job['for-each']);
      if (job.skill) edge({ from: self, to: `skill:${job.skill}`, kind: 'uses-skill' });
      for (const check of job.until?.checks ?? []) {
        edge({ from: `check:${check}`, to: self, kind: 'gates' });
        edge({ from: `check:${check}`, to: self, kind: 'loops-back', label: `max ${job.until?.max}` });
      }
    }
  }

  for (const bot of Object.values(config.bots)) {
    const { name, path: _, body, ...rest } = bot;
    node({
      id: `bot:${name}`,
      kind: 'bot',
      label: name,
      badges: badges(bot.harness, bot.model),
      detail: { ...rest, role: body },
    });
    readNotes(`bot:${name}`, bot.notes);
  }

  for (const skill of Object.values(config.skills)) {
    const { name, path: _, body, ...rest } = skill;
    node({ id: `skill:${name}`, kind: 'skill', label: name, detail: { ...rest, prompt: body } });
    readNotes(`skill:${name}`, skill.notes);
  }

  for (const check of Object.values(config.checks)) {
    const { name, path: _, body, ...rest } = check;
    node({
      id: `check:${name}`,
      kind: 'check',
      label: name,
      badges: badges(check.mode, check.run ? 'script' : check.bot),
      detail: { ...rest, ...(body && { prompt: body }) },
    });
    if (check.bot) runsAs(`check:${name}`, check.bot, check['for-each']);
    if (check.skill) edge({ from: `check:${name}`, to: `skill:${check.skill}`, kind: 'uses-skill' });
  }

  for (const kind of NoteKind.options) {
    const notes = config.notes.filter(n => n.kind === kind);
    if (!notes.length && !reads.has(kind)) continue;
    node({
      id: `note:${kind}`,
      kind: 'note',
      label: kind,
      badges: [String(notes.length)],
      detail: { notes: notes.map(({ name, title, status, check }) => ({ slug: name, title, status, check })) },
    });
  }
  return graph;
};
