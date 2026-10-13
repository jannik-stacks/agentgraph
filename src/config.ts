import { parse } from 'yaml';
import { z } from 'zod';
import { parseMarkdown } from './markdown.ts';
import { matchGlob } from './outputs.ts';
import {
  Bot,
  Check,
  Hub,
  HubTool,
  hubGlobs,
  humanOnly,
  Note,
  NoteKind,
  Skill,
  Workflow,
  type Harness,
  type Job,
  type Preload,
  type ProposalKind,
  type Return,
} from './schema.ts';

export type SourceFile = { path: string; source: string };

/** A validated definition file: its frontmatter plus the name it is referenced by, its path and its body. */
export type Defined<T> = T & { name: string; path: string; body: string };

export type Config = {
  hub: Hub;
  bots: Record<string, Defined<Bot>>;
  skills: Record<string, Defined<Skill>>;
  checks: Record<string, Defined<Check>>;
  workflows: Record<string, Defined<Workflow>>;
  notes: (Defined<Note> & { kind: NoteKind })[];
};

export type ConfigError = { path: string; message: string };
export type Compiled = { ok: true; config: Config; warnings: ConfigError[] } | { ok: false; errors: ConfigError[] };

const schemas = { bots: Bot, skills: Skill, checks: Check, workflows: Workflow } as const;
const definition = /(?:^|\/)(bots|skills|checks|workflows)\/([^/]+)\.md$/;
const noteFile = /(?:^|\/)notes\/([^/]+)\/([^/]+)\.md$/;
export const hubFile = 'hub.yaml';
const placeholders = new Set(['issue', 'parent', 'base', 'slug', 'job', 'workflow']);

const quoted = (names: string[]) => names.map(n => `"${n}"`).join(', ');

/**
 * Validates a hub's Markdown files into one config. Fails closed: any error rejects the whole set.
 * Files are routed by directory: `bots/`, `skills/`, `checks/`, `workflows/` and `notes/<kind>/`, plus an optional
 * top-level `hub.yaml`.
 */
export const compile = (files: SourceFile[]): Compiled => {
  const errors: ConfigError[] = [];
  const config: Config = { hub: Hub.parse({}), bots: {}, skills: {}, checks: {}, workflows: {}, notes: [] };

  for (const file of files) {
    const fail = (message: string) => errors.push({ path: file.path, message });
    if (file.path === hubFile) {
      try {
        const parsed = Hub.safeParse(parse(file.source) ?? {});
        if (parsed.success) config.hub = parsed.data;
        else fail(z.prettifyError(parsed.error));
      } catch (e) {
        fail((e as Error).message);
      }
      continue;
    }
    const def = definition.exec(file.path);
    const note = def ? undefined : noteFile.exec(file.path);
    if (!def && !note) continue;
    let doc;
    try {
      doc = parseMarkdown(file.source);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }

    if (note) {
      const [, kind = '', slug = ''] = note;
      const parsedKind = NoteKind.safeParse(kind);
      if (!parsedKind.success) {
        fail(`unknown note kind "${kind}", expected one of ${quoted(NoteKind.options)}`);
        continue;
      }
      const parsed = Note.safeParse(doc.data);
      if (!parsed.success) fail(z.prettifyError(parsed.error));
      else config.notes.push({ ...parsed.data, kind: parsedKind.data, name: slug, path: file.path, body: doc.body });
      continue;
    }

    const [, dir, stem = ''] = def as RegExpExecArray;
    const group = dir as keyof typeof schemas;
    const parsed = schemas[group].safeParse(doc.data);
    if (!parsed.success) {
      fail(z.prettifyError(parsed.error));
      continue;
    }
    const name = ('name' in parsed.data && parsed.data.name) || stem;
    const target = config[group] as Record<string, unknown>;
    if (name in target) fail(`duplicate ${group.slice(0, -1)} "${name}"`);
    target[name] = { ...parsed.data, name, path: file.path, body: doc.body };
  }

  if (!errors.length) errors.push(...references(config));
  return errors.length ? { ok: false, errors } : { ok: true, config, warnings: warnings(config) };
};

/** The tool names each harness's allowlist understands, besides the bothub read tools. */
export const harnessToolNames: Record<Harness, readonly string[]> = {
  opencode: ['read', 'edit', 'write', 'bash', 'grep', 'glob', 'list', 'webfetch', 'websearch', 'todowrite', 'task'],
  pi: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
};

/** Why a tool entry means nothing to the bot's harness: an unknown name, or a pattern pi cannot take. */
const toolProblem = (harness: Harness, tool: string) => {
  if (HubTool.safeParse(tool).success) return;
  const [, name = tool, pattern] = /^([^(]+)\((.*)\)$/.exec(tool) ?? [];
  const known = harnessToolNames[harness];
  if (!known.includes(name))
    return `lists tool "${tool}", which ${harness} does not have (one of ${known.join(', ')}, or a hub tool)`;
  if (pattern !== undefined && harness !== 'opencode') return `lists tool "${tool}", but ${harness} takes no patterns`;
};

const references = (config: Config): ConfigError[] => {
  const errors: ConfigError[] = [];
  const at = (path: string) => (message: string) => errors.push({ path, message });
  const { bots, skills, checks } = config;

  for (const bot of Object.values(bots)) {
    const fail = at(bot.path);
    for (const problem of returnProblems(bot.returns)) fail(problem);
    for (const skill of bot.skills ?? []) if (!(skill in skills)) fail(`offers unknown skill "${skill}"`);
    for (const tool of bot.tools) {
      const problem = toolProblem(bot.harness, tool);
      if (problem) fail(problem);
    }
  }

  for (const check of Object.values(checks)) {
    const fail = at(check.path);
    const prompt = check.body.trim();
    if (check.type === 'script' && typeof check.over === 'object' && 'run' in check.over)
      fail('runs its own command, so "over: { run }" needs type bot or decide');
    if (check.type === 'decide' && !prompt) fail('has no question: a decide check asks its body');
    if (check.type !== 'bot') continue;
    if (!(check.bot in bots)) fail(`uses unknown bot "${check.bot}"`);
    if (check.skill && !(check.skill in skills)) fail(`uses unknown skill "${check.skill}"`);
    if (!check.skill && !prompt) fail('has no prompt: give the bot a body or a skill');
  }

  for (const note of config.notes)
    if (note.check && !(note.check in checks)) at(note.path)(`refers to unknown check "${note.check}"`);

  for (const workflow of Object.values(config.workflows)) {
    const fail = at(workflow.path);
    for (const [id, job] of Object.entries(workflow.jobs))
      for (const message of checkJob(id, job, workflow, config)) fail(message);
    const cycle = findCycle(workflow.jobs);
    if (cycle) fail(`needs cycle: ${cycle.join(' -> ')}`);
  }
  return errors;
};

/** Harnesses that report what a run cost; `usd-per-run` is enforced only on these. */
const costReporting: readonly Harness[] = [];

/** Fields that compile but that the runner does not act on, or that make a job do nothing it asked for. */
const warnings = ({ bots, checks, workflows }: Config): ConfigError[] => {
  const found: ConfigError[] = [];
  for (const bot of Object.values(bots)) {
    const warn = (message: string) => found.push({ path: bot.path, message });
    if (bot.budget?.['usd-per-run'] !== undefined && !costReporting.includes(bot.harness))
      warn(`"usd-per-run" is declared, not enforced: harness "${bot.harness}" reports no cost`);
    if (bot.harness === 'pi') {
      if (bot['max-turns'] !== undefined)
        warn('"max-turns" is declared, not enforced: pi has no turn limit, only the run timeout stops it');
      const served = hubTools(bot);
      if (served.length) warn(`lists hub tools (${served.join(', ')}) that pi runs do not get`);
      if (bot.preload?.some(recallOf)) warn('preloads recall, which pi runs do not get');
    }
  }
  for (const check of Object.values(checks))
    if (check.type === 'decide' && check.mode !== 'shadow' && check.threshold === undefined)
      found.push({
        path: check.path,
        message: `decides in ${check.mode} mode without a "threshold"; tune one in shadow mode first`,
      });
  const jobs = Object.values(workflows).flatMap(workflow => Object.values(workflow.jobs));
  const used = new Set(
    jobs.flatMap(job => [...(job.requires ?? []), ...((job.type === 'bot' && job.until?.checks) || [])])
  );
  for (const check of Object.values(checks))
    if (!used.has(check.name))
      found.push({ path: check.path, message: 'no job lists it in "until" or "requires", so it never runs' });
  for (const workflow of Object.values(workflows))
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const warn = (message: string) => found.push({ path: workflow.path, message: `job "${id}" ${message}` });
      if (job.type === 'bot' && job.until && job.until.checks.every(name => checks[name]?.mode === 'shadow'))
        warn('loops until checks that are all in shadow mode, so it never repeats');
    }
  return found;
};

const checkJob = (id: string, job: Job, workflow: Workflow, { hub, bots, skills, checks }: Config): string[] => {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`job "${id}" ${message}`);
  for (const need of job.needs) if (!(need in workflow.jobs)) fail(`needs unknown job "${need}"`);
  for (const trigger of Object.keys(job.on ?? {}))
    if (!(trigger in workflow.on)) fail(`triggers on "${trigger}", which the workflow does not listen to`);
  if (job.branch && !job.branch.startsWith('bothub/')) fail(`branch "${job.branch}" must start with "bothub/"`);
  for (const [field, template] of [
    ['branch', job.branch],
    ['into', job.into],
  ] as const)
    for (const [, key = ''] of template?.matchAll(/\{([^}]*)\}/g) ?? [])
      if (!placeholders.has(key)) fail(`${field} uses unknown placeholder "{${key}}"`);
  if (job.branch && job.into && `${job.branch}/`.startsWith(`${job.into}/`))
    fail(`branch "${job.branch}" sits inside "${job.into}", and git cannot hold both; try "${job.into}-…"`);
  for (const check of job.requires ?? []) if (!(check in checks)) fail(`requires unknown check "${check}"`);
  for (const problem of returnProblems(job.returns ?? [])) fail(problem);
  const bot = job.type === 'bot' ? bots[job.bot] : undefined;
  const returns = job.returns ?? bot?.returns ?? [];
  if (returns.includes('merge') && !job.into && hub.merge['default-branch'] === 'human')
    fail('returns "merge" without "into", so it would merge into the default branch, which only a human does');
  if (job.type === 'script') {
    if (typeof job.over === 'object' && 'run' in job.over)
      fail('runs its own command, so "over: { run }" needs type bot');
    return errors;
  }
  if (!(job.skill in skills)) fail(`uses unknown skill "${job.skill}"`);
  for (const check of job.until?.checks ?? []) if (!(check in checks)) fail(`waits for unknown check "${check}"`);
  if (!bot) {
    fail(`uses unknown bot "${job.bot}"`);
    return errors;
  }
  for (const entry of job.returns ?? [])
    if (!narrows(bot.returns, entry)) fail(`returns "${entry}", which bot "${bot.name}" does not return`);
  for (const tool of job.tools ?? [])
    if (!hubTools(bot).includes(tool)) fail(`grants tool "${tool}", which bot "${bot.name}" does not have`);
  return errors;
};

const findCycle = (jobs: Record<string, { needs: string[] }>): string[] | undefined => {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): string[] | undefined => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, 'visiting');
    for (const need of jobs[id]?.needs ?? []) {
      const found = visit(need, [...trail, id]);
      if (found) return found;
    }
    state.set(id, 'done');
  };
  for (const id of Object.keys(jobs)) {
    const found = visit(id, []);
    if (found) return found;
  }
};

/** Job ids in dependency order, so every job comes after the jobs it needs. */
export const jobOrder = (workflow: Pick<Workflow, 'jobs'>): string[] => {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const need of workflow.jobs[id]?.needs ?? []) visit(need);
    order.push(id);
  };
  Object.keys(workflow.jobs).forEach(visit);
  return order;
};

const reachesHumanOnly = (glob: string) => {
  const prefix = glob.split(/[*?{[]/)[0] ?? '';
  return (
    ['hub.yaml', 'bots/a.md', 'workflows/a.md'].some(path => matchGlob(glob, path)) ||
    humanOnly.some(path => prefix.startsWith(path.replace('**', '')))
  );
};

/** Why `returns` entries are unusable: a `hub(...)` glob that leaves the hub or reaches a file only a human changes. */
const returnProblems = (returns: Return[]) =>
  returns.flatMap(entry =>
    (hubGlobs(entry) ?? []).flatMap(glob => {
      if (glob.startsWith('/') || glob.split('/').includes('..'))
        return [`returns "${entry}": "${glob}" leaves the hub`];
      if (reachesHumanOnly(glob))
        return [`returns "${entry}": "${glob}" reaches ${humanOnly.join(', ')}, which only a human changes`];
      return [];
    })
  );

/** Whether a job's `returns` entry is within the bot's: the same kind, or hub globs a bot glob covers. */
const narrows = (bot: Return[], entry: Return) => {
  const globs = hubGlobs(entry);
  if (!globs) return bot.includes(entry);
  const allowed = returnGlobs(bot);
  return globs.every(glob => allowed.some(outer => outer === glob || matchGlob(outer, glob)));
};

/** The proposal kind of each `returns` entry: `hub` for `hub(<globs>)`. */
export const returnKinds = (returns: Return[]): ProposalKind[] => [
  ...new Set(returns.map(entry => (hubGlobs(entry) ? 'hub' : (entry as ProposalKind)))),
];

/** The hub globs every `hub(<globs>)` entry of `returns` names. */
export const returnGlobs = (returns: Return[]) => returns.flatMap(entry => hubGlobs(entry) ?? []);

/** What a bot may return in a job: the bot's `returns`, narrowed to the job's when it has them. */
export const effectiveReturns = (bot: Pick<Bot, 'returns'>, job: Pick<Extract<Job, { type: 'bot' }>, 'returns'>) =>
  job.returns ? job.returns.filter(entry => narrows(bot.returns, entry)) : bot.returns;

/** The hub tools among a bot's `tools`. */
export const hubTools = (bot: Pick<Bot, 'tools'>): HubTool[] =>
  bot.tools.filter((tool): tool is HubTool => HubTool.safeParse(tool).success);

/** A bot's harness tools, without the hub tools. */
export const harnessTools = (bot: Pick<Bot, 'tools'>) => bot.tools.filter(tool => !HubTool.safeParse(tool).success);

/** The read tools a run gets: the job's `tools` when it has them, otherwise the bot's. */
export const effectiveTools = (bot: Pick<Bot, 'tools'>, job: Pick<Extract<Job, { type: 'bot' }>, 'tools'>) =>
  job.tools ?? hubTools(bot);

/** What a run starts with: the job's `preload`, then the bot's, then recall alone. */
export const effectivePreload = (
  bot: Pick<Bot, 'preload'>,
  job: Pick<Extract<Job, { type: 'bot' }>, 'preload'>
): Preload[] => job.preload ?? bot.preload ?? ['recall'];

/** The recall settings among `preload`, when it has recall. */
export const recallOf = (preload: Preload) =>
  preload === 'recall' ? {} : typeof preload === 'object' ? preload.recall : undefined;
