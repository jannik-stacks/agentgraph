import { hubTools, type Config } from './config.ts';
import { fanOut } from './over.ts';
import { NoteKind, ruleKinds, type HubTool, type Over, type Preload } from './schema.ts';

/** A node and edge model of a hub, for rendering. Ids are prefixed by kind, like `job:issue/implement`. */
export type HubGraph = {
  nodes: {
    id: string;
    kind: 'trigger' | 'job' | 'bot' | 'skill' | 'check' | 'note' | 'script' | 'issues' | 'tool';
    label: string;
    badges?: string[];
    detail?: Record<string, unknown>;
  }[];
  edges: {
    from: string;
    to: string;
    kind:
      | 'triggers'
      | 'needs'
      | 'runs-as'
      | 'uses-skill'
      | 'gates'
      | 'loops-back'
      | 'fans-out'
      | 'reads-notes'
      | 'preloads'
      | 'calls';
    label?: string;
  }[];
};

const badges = (...items: (string | false | undefined)[]) => items.filter((item): item is string => Boolean(item));

/**
 * Builds the hub graph: triggers start jobs, jobs (or scripts) need jobs, run as bots with skills and loop back
 * from their `until` checks; bots and skills read notes, one node per note kind. Context reaches a run two ways,
 * both drawn from where they are declared: `preload` edges into the issue tracker and the rule notes, and `calls`
 * edges to the read tools a run may call.
 */
export const hubGraph = (config: Config): HubGraph => {
  const graph: HubGraph = { nodes: [], edges: [] };
  const node = (n: HubGraph['nodes'][number]) => graph.nodes.push(n);
  const edge = (e: HubGraph['edges'][number]) => graph.edges.push(e);
  const reads = new Set<NoteKind>();
  const readNotes = (from: string, kinds: NoteKind[] = [], kind: 'reads-notes' | 'preloads' = 'reads-notes') =>
    kinds.forEach(note => {
      reads.add(note);
      edge({ from, to: `note:${note}`, kind });
    });
  const tools = new Set<HubTool>();
  let tracker = false;
  const preloads = (from: string, preload: Preload[] | undefined) => {
    const items = preload?.filter(item => item !== 'notes') ?? [];
    if (items.length) {
      tracker = true;
      edge({ from, to: 'issues:issues', kind: 'preloads', label: items.join(', ') });
    }
    if (preload?.includes('notes')) readNotes(from, [...ruleKinds], 'preloads');
  };
  const calls = (from: string, granted: HubTool[]) =>
    granted.forEach(tool => {
      tools.add(tool);
      if (tool.startsWith('issues_')) tracker = true;
      edge({ from, to: `tool:${tool}`, kind: 'calls' });
    });
  const runsAs = (from: string, bot: string, over: Over) => {
    const each = fanOut(over);
    edge({ from, to: `bot:${bot}`, ...(each ? { kind: 'fans-out', label: `for each ${each}` } : { kind: 'runs-as' }) });
  };

  for (const workflow of Object.values(config.workflows)) {
    const jobId = (id: string) => `${workflow.jobs[id]?.type === 'script' ? 'script' : 'job'}:${workflow.name}/${id}`;
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
        kind: job.type === 'script' ? 'script' : 'job',
        label: id,
        badges: badges(job.mode, job.type === 'bot' && job.branch, job.environment && `environment ${job.environment}`),
        detail: { workflow: workflow.name, ...rest },
      });
      for (const trigger of Object.keys(on ?? (needs.length ? {} : workflow.on)))
        edge({ from: `trigger:${workflow.name}/${trigger}`, to: self, kind: 'triggers' });
      for (const need of needs) edge({ from: jobId(need), to: self, kind: 'needs' });
      if (job.type !== 'bot') continue;
      runsAs(self, job.bot, job.over);
      edge({ from: self, to: `skill:${job.skill}`, kind: 'uses-skill' });
      preloads(self, job.preload);
      calls(self, job.tools ?? []);
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
    preloads(`bot:${name}`, bot.preload);
    calls(`bot:${name}`, hubTools(bot));
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
      badges: badges(check.mode, check.type === 'bot' ? check.bot : check.type),
      detail: { ...rest, ...(body && { [check.type === 'decide' ? 'question' : 'prompt']: body }) },
    });
    if (check.type !== 'bot') continue;
    runsAs(`check:${name}`, check.bot, check.over);
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

  if (tracker)
    node({
      id: 'issues:issues',
      kind: 'issues',
      label: 'issues',
      badges: [config.hub.issues],
      detail: { ...config.hub },
    });
  for (const tool of tools) node({ id: `tool:${tool}`, kind: 'tool', label: tool, badges: ['read'] });
  return graph;
};
