import { parse } from 'yaml';
import { z } from 'zod';
import { supports as harnessSupports } from './harnesses/supports.ts';
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
  type Load,
  type LoadEntry,
  type Preload,
  type Step,
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
const placeholders = new Set(['issue', 'parent', 'base', 'slug', 'step', 'workflow']);

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
    const name = stem;
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
  claude: ['read', 'grep', 'glob', 'edit', 'write', 'bash', 'webfetch', 'websearch'],
};

/** Why a tool entry means nothing to the bot's harness: an unknown name, or a pattern pi cannot take. */
const toolProblem = (harness: Harness, tool: string) => {
  if (HubTool.safeParse(tool).success) return;
  const [, name = tool, pattern] = /^([^(]+)\((.*)\)$/.exec(tool) ?? [];
  const known = harnessToolNames[harness];
  if (!known.includes(name))
    return `lists tool "${tool}", which ${harness} does not have (one of ${known.join(', ')}, or a hub tool)`;
  if (pattern !== undefined && harness === 'pi') return `lists tool "${tool}", but ${harness} takes no patterns`;
};

const references = (config: Config): ConfigError[] => {
  const errors: ConfigError[] = [];
  const at = (path: string) => (message: string) => errors.push({ path, message });
  const { bots, skills, checks } = config;

  for (const bot of Object.values(bots)) {
    const fail = at(bot.path);
    for (const problem of returnProblems(bot.returns)) fail(problem);
    for (const skill of bot.skills ?? []) if (!(skill in skills)) fail(`offers unknown skill "${skill}"`);
    const supports = harnessSupports[bot.harness];
    if (effectiveRun(config.hub, bot).context === 'resume' && !supports.includes('resume'))
      fail(`sets context "resume", which ${bot.harness} cannot honor`);
    for (const entry of bot.loads ?? config.hub.loads ?? [])
      if (!supports.includes(entry.split('/')[0] as Load)) fail(`loads "${entry}", which ${bot.harness} cannot honor`);
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
    for (const [id, step] of Object.entries(workflow.steps))
      for (const message of checkStep(id, step, workflow, config)) fail(message);
    const walked = stepOrder(workflow);
    if (walked.loop) fail(`steps loop back to "${walked.loop}" through "next"; a step repeats only by "tries"`);
    for (const id of Object.keys(workflow.steps))
      if (!walked.order.includes(id)) fail(`step "${id}" is never reached: no step's "next" leads to it`);
  }
  return errors;
};

/** Fields that compile but that the runner does not act on. */
const warnings = ({ bots, checks, workflows }: Config): ConfigError[] => {
  const found: ConfigError[] = [];
  for (const bot of Object.values(bots)) {
    const warn = (message: string) => found.push({ path: bot.path, message });
    const { harness } = bot;
    if (harness === 'opencode') continue;
    const served = hubTools(bot);
    if (served.length) warn(`lists hub tools (${served.join(', ')}) that ${harness} runs do not get`);
    if (bot.preload?.some(recallOf)) warn(`preloads recall, which ${harness} runs do not get`);
    if (bot.decider) warn(`asks decider questions, which ${harness} runs do not get`);
  }
  for (const check of Object.values(checks))
    if (check.type === 'decide' && check.mode !== 'log' && check.threshold === undefined)
      found.push({
        path: check.path,
        message: `decides in ${check.mode} mode without a "threshold"; tune one in log mode first`,
      });
  const steps = Object.values(workflows).flatMap(workflow => Object.values(workflow.steps));
  const used = new Set(steps.flatMap(step => [...(step.requires ?? []), ...(step.checks ?? [])]));
  for (const check of Object.values(checks))
    if (!used.has(check.name))
      found.push({ path: check.path, message: 'no step lists it in "checks" or "requires", so it never runs' });
  for (const workflow of Object.values(workflows))
    for (const [id, step] of Object.entries(workflow.steps))
      if (step.checks?.every(name => checks[name]?.mode === 'log'))
        found.push({
          path: workflow.path,
          message: `step "${id}" has only checks in log mode, so a failing check never sends it back`,
        });
  return found;
};

const checkStep = (id: string, step: Step, workflow: Workflow, { hub, bots, skills, checks }: Config): string[] => {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`step "${id}" ${message}`);
  if (step.next && step.next !== end && !(step.next in workflow.steps))
    fail(`goes next to unknown step "${step.next}"`);
  if (step.wait) {
    const back = backOf(workflow, id);
    if (!back) fail('waits first, so there is no step to go back to');
    else if (!(back in workflow.steps)) fail(`goes back to unknown step "${back}"`);
    return errors;
  }
  if (step.branch && !step.branch.startsWith('bothub/')) fail(`branch "${step.branch}" must start with "bothub/"`);
  for (const [field, template] of [
    ['branch', step.branch],
    ['into', step.into],
  ] as const)
    for (const [, key = ''] of template?.matchAll(/\{([^}]*)\}/g) ?? [])
      if (!placeholders.has(key)) fail(`${field} uses unknown placeholder "{${key}}"`);
  if (step.branch && step.into && `${step.branch}/`.startsWith(`${step.into}/`))
    fail(`branch "${step.branch}" sits inside "${step.into}", and git cannot hold both; try "${step.into}-…"`);
  for (const check of step.requires ?? []) if (!(check in checks)) fail(`requires unknown check "${check}"`);
  for (const problem of returnProblems(step.returns ?? [])) fail(problem);
  const bot = step.bot === undefined ? undefined : bots[step.bot];
  const returns = step.returns ?? bot?.returns ?? [];
  if (returns.includes('merge') && !step.into && hub.merge['default-branch'] === 'human')
    fail('returns "merge" without "into", so it would merge into the default branch, which only a human does');
  if (step.run !== undefined) {
    if (typeof step.over === 'object' && 'run' in step.over)
      fail('runs its own command, so "over: { run }" needs a bot step');
    return errors;
  }
  const skill = skillOf(id, step);
  if (!(skill in skills)) fail(`uses unknown skill "${skill}"`);
  for (const check of step.checks ?? []) if (!(check in checks)) fail(`checks unknown check "${check}"`);
  if (!bot) {
    fail(`uses unknown bot "${step.bot}"`);
    return errors;
  }
  for (const entry of step.returns ?? [])
    if (!narrows(bot.returns, entry)) fail(`returns "${entry}", which bot "${bot.name}" does not return`);
  return errors;
};

/** The `next` that ends a workflow. */
export const end = 'end';

/** The step after `id`: its `next`, or the step written after it; nothing at the end. */
export const nextOf = (workflow: Pick<Workflow, 'steps'>, id: string): string | undefined => {
  const ids = Object.keys(workflow.steps);
  const next = workflow.steps[id]?.next ?? ids[ids.indexOf(id) + 1];
  return next === end ? undefined : next;
};

/** Where a wait step goes when a human answers: its `back`, or the step written before it. */
export const backOf = (workflow: Pick<Workflow, 'steps'>, id: string): string | undefined => {
  const ids = Object.keys(workflow.steps);
  return workflow.steps[id]?.back ?? ids[ids.indexOf(id) - 1];
};

/** The steps that lead to `id`. */
export const stepsBefore = (workflow: Pick<Workflow, 'steps'>, id: string) =>
  Object.keys(workflow.steps).filter(other => nextOf(workflow, other) === id);

/** The steps a workflow runs, from its first along `next`, and the step it would loop back to, if any. */
export const stepOrder = (workflow: Pick<Workflow, 'steps'>): { order: string[]; loop?: string } => {
  const order: string[] = [];
  for (let id = Object.keys(workflow.steps)[0]; id !== undefined && id in workflow.steps; id = nextOf(workflow, id)) {
    if (order.includes(id)) return { order, loop: id };
    order.push(id);
  }
  return { order };
};

/** The skill a bot step runs: its `skill`, or its own name. */
export const skillOf = (id: string, step: Pick<Step, 'skill'>) => step.skill ?? id;

/** How many attempts a bot step gets in all. */
export const triesOf = (step: Pick<Step, 'tries'>) => step.tries ?? 3;

/** The limits that apply to `bot`: the hub's, with the bot's own over them. */
export const limitsOf = ({ limits }: Pick<Hub, 'limits'>, bot: string | undefined) => {
  const { bots, ...hub } = limits;
  return { ...hub, ...(bot === undefined ? {} : bots[bot]) };
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

/** Whether a step's `returns` entry is within the bot's: the same kind, or hub globs a bot glob covers. */
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

/** What a bot may return in a step: the bot's `returns`, narrowed to the step's when it has them. */
export const effectiveReturns = (bot: Pick<Bot, 'returns'>, step: Pick<Step, 'returns'>) =>
  step.returns ? step.returns.filter(entry => narrows(bot.returns, entry)) : bot.returns;

/** The hub tools among a bot's `tools`. */
export const hubTools = (bot: Pick<Bot, 'tools'>): HubTool[] =>
  bot.tools.filter((tool): tool is HubTool => HubTool.safeParse(tool).success);

/** A bot's harness tools, without the hub tools. */
export const harnessTools = (bot: Pick<Bot, 'tools'>) => bot.tools.filter(tool => !HubTool.safeParse(tool).success);

/** What a bot's runs load from the repo, start with and recall: the bot's own setting over the hub's. */
export const effectiveRun = (
  hub: Pick<Hub, 'loads' | 'context' | 'history'>,
  bot: Pick<Bot, 'loads' | 'context' | 'history'>
): { loads: LoadEntry[] } & Pick<Bot, 'context' | 'history'> => ({
  ...hub,
  ...bot,
  loads: bot.loads ?? hub.loads ?? ['instructions', 'skills'],
});

/** The recall settings among `preload`, when it has recall. */
export const recallOf = (preload: Preload) =>
  preload === 'recall' ? {} : typeof preload === 'object' && 'recall' in preload ? preload.recall : undefined;
