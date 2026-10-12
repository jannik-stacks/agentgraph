import { parse } from 'yaml';
import { z } from 'zod';
import { parseMarkdown } from './markdown.ts';
import { Bot, Check, Hub, HubTool, Note, NoteKind, Skill, Workflow, type Job, type Preload } from './schema.ts';

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
export type Compiled = { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

const schemas = { bots: Bot, skills: Skill, checks: Check, workflows: Workflow } as const;
const definition = /(?:^|\/)(bots|skills|checks|workflows)\/([^/]+)\.md$/;
const noteFile = /(?:^|\/)notes\/([^/]+)\/([^/]+)\.md$/;
export const hubFile = 'hub.yaml';
const placeholders = new Set(['issue', 'slug', 'job', 'workflow']);

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
  return errors.length ? { ok: false, errors } : { ok: true, config };
};

const references = (config: Config): ConfigError[] => {
  const errors: ConfigError[] = [];
  const at = (path: string) => (message: string) => errors.push({ path, message });
  const { bots, skills, checks } = config;

  for (const bot of Object.values(bots)) {
    const fail = at(bot.path);
    for (const skill of bot.skills ?? []) if (!(skill in skills)) fail(`offers unknown skill "${skill}"`);
  }

  for (const check of Object.values(checks)) {
    const fail = at(check.path);
    if (!check.run === !check.bot) fail('needs either "run" or "bot"');
    if (check.bot && !(check.bot in bots)) fail(`uses unknown bot "${check.bot}"`);
    if (check.bot && !check.skill) fail(`runs bot "${check.bot}" but has no skill`);
    if (check.skill && !check.bot) fail('has a skill but no bot');
    if (check.skill && !(check.skill in skills)) fail(`uses unknown skill "${check.skill}"`);
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

const checkJob = (id: string, job: Job, workflow: Workflow, { bots, skills, checks }: Config): string[] => {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`job "${id}" ${message}`);
  for (const need of job.needs) if (!(need in workflow.jobs)) fail(`needs unknown job "${need}"`);
  for (const trigger of Object.keys(job.on ?? {}))
    if (!(trigger in workflow.on)) fail(`triggers on "${trigger}", which the workflow does not listen to`);
  if (!job.run === !job.bot) fail('needs either "bot" and "skill", or "run"');
  if (job.bot && !job.skill) fail(`runs bot "${job.bot}" but has no skill`);
  if (job.skill && !job.bot) fail('has a skill but no bot');
  if (job.skill && !(job.skill in skills)) fail(`uses unknown skill "${job.skill}"`);
  if (job.until && !job.bot) fail('loops "until" checks pass but has no bot');
  for (const check of job.until?.checks ?? []) if (!(check in checks)) fail(`waits for unknown check "${check}"`);
  if (job.branch) {
    if (!job.branch.startsWith('bothub/')) fail(`branch "${job.branch}" must start with "bothub/"`);
    for (const [, key = ''] of job.branch.matchAll(/\{([^}]*)\}/g))
      if (!placeholders.has(key)) fail(`branch uses unknown placeholder "{${key}}"`);
  }
  if (!job.bot && (job.preload || job.tools)) fail('has "preload" or "tools" but no bot');
  if (!job.bot) return errors;
  const bot = bots[job.bot];
  if (!bot) {
    fail(`uses unknown bot "${job.bot}"`);
    return errors;
  }
  for (const kind of job.can ?? [])
    if (!bot.can.includes(kind)) fail(`allows "${kind}", which bot "${bot.name}" cannot do`);
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

/** What a bot may propose in a job: the bot's `can`, narrowed by the job's `can` when it has one. */
export const effectiveCan = (bot: Pick<Bot, 'can'>, job: Pick<Job, 'can'>) =>
  job.can ? bot.can.filter(kind => job.can?.includes(kind)) : bot.can;

/** The bothub read tools among a bot's `tools`. */
export const hubTools = (bot: Pick<Bot, 'tools'>): HubTool[] =>
  bot.tools.filter((tool): tool is HubTool => HubTool.safeParse(tool).success);

/** A bot's harness tools, without the bothub read tools. */
export const harnessTools = (bot: Pick<Bot, 'tools'>) => bot.tools.filter(tool => !HubTool.safeParse(tool).success);

/** The read tools a run gets: the job's `tools` when it has them, otherwise the bot's. */
export const effectiveTools = (bot: Pick<Bot, 'tools'>, job: Pick<Job, 'tools'>) => job.tools ?? hubTools(bot);

/** What is rendered into a run before it starts: the job's `preload`, then the bot's, then the notes alone. */
export const effectivePreload = (bot: Pick<Bot, 'preload'>, job: Pick<Job, 'preload'>): Preload[] =>
  job.preload ?? bot.preload ?? ['notes'];
