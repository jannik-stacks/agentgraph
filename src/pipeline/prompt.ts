import {
  effectiveRun,
  effectivePreload,
  effectiveReturns,
  effectiveTools,
  harnessTools,
  recallOf,
  returnGlobs,
  returnKinds,
  type Config,
  type Defined,
} from '../config.ts';
import type { PlannedJob } from '../dispatch.ts';
import type { SurfacerOptions } from '../harnesses/opencode-surfacer.ts';
import { mcpToolNames } from '../mcp-config.ts';
import type { McpTool } from '../mcp.ts';
import { recallQuery } from '../preload.ts';
import type { RepoFiles } from '../repo-guidance.ts';
import {
  NoteKind,
  type History,
  type Preload,
  type Bot,
  type HubTool,
  type Job,
  type ProposalKind,
  type Return,
  type Workflow,
} from '../schema.ts';
import type { Outcome } from '../store.ts';
import type { BotEvent, RunSpec } from '../types.ts';
import type { Pipeline } from './context.ts';

export const defaultMinutes = 30;

const examples: Record<ProposalKind, string> = {
  reply: '{ "kind": "reply", "body": "Markdown comment on the issue or pull request" }',
  label: '{ "kind": "label", "add": ["bug"], "remove": ["needs-triage"] }',
  push: '{ "kind": "push", "branch": "<branch>", "files": ["src/changed.ts"] }',
  'merge-request':
    '{ "kind": "merge-request", "title": "…", "body": "Closes #<issue>, or Part of #<issue> for one task of several", "branch": "<branch>", "into": "<into>", "draft": true }',
  merge: '{ "kind": "merge", "request": 12 }',
  note: '{ "kind": "note", "note": "style", "slug": "short-kebab-name", "title": "…", "body": "The note, in Markdown" }',
  hub: '{ "kind": "hub", "title": "…", "body": "Why", "files": [{ "path": "<hub file>", "content": "The whole new file" }] }',
  ask: '{ "kind": "ask", "question": "What should happen when …?" }',
};

const proposing = (returns: Return[], { branch, into }: Target, notesTool: boolean) => {
  const kinds = returnKinds(returns);
  const globs = returnGlobs(returns);
  const has = (kind: ProposalKind) => kinds.includes(kind);
  const pushes = has('push') || has('merge-request');
  const target = into ? `\`${into}\`` : 'the default branch';
  const notes = [
    pushes && (branch ? `Use the branch \`${branch}\`.` : 'Branches must start with `bothub/`.'),
    has('push') && '`files` lists every file you changed, as repository-relative paths.',
    has('merge-request') && `A merge request goes into ${target}; leave out \`into\` for that. A human reviews it.`,
    has('merge') &&
      `A \`merge\` names one open request into ${target}; it lands only once the required checks pass on the merged result.`,
    has('note') &&
      `A note's kind is one of ${NoteKind.options.join(', ')}: what was chosen and why, how code and docs should look, or a known sharp edge.${notesTool ? ' The `notes_add` tool proposes one as well.' : ''}`,
    has('hub') &&
      `A \`hub\` change proposes whole files of the hub, under ${globs.map(glob => `\`${glob}\``).join(', ')}; a human merges it. \`"delete": true\` in place of \`content\` removes a file.`,
    has('ask') && 'An `ask` opens an issue labelled `unsure` for a human; stop after asking.',
    'When you stop without finishing, add `{ "kind": "close", "as": "blocked", "reason": "…" }` with `as` one of blocked, deferred or no-op.',
    'Include only the proposals you need.',
  ].filter(Boolean);
  const example = (kind: ProposalKind) =>
    examples[kind]
      .replaceAll('<branch>', branch ?? 'bothub/<issue>-<slug>')
      .replaceAll(into ? '<into>' : ', "into": "<into>"', into ?? '')
      .replaceAll('<hub file>', globs[0] ?? '');
  return [
    '## What you return',
    '',
    'You cannot write to GitHub or the hub yourself. Your run ends when you return: end your final message with one',
    'fenced block tagged `bothub` that holds a JSON array of what you return. Only the last such block counts.',
    'Anything the job does not allow is rejected.',
    '',
    '```bothub',
    '[',
    kinds.map(kind => `  ${example(kind)}`).join(',\n'),
    ']',
    '```',
    '',
    notes.join(' '),
  ].join('\n');
};

export const fenced = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

export const eventContext = (event: BotEvent, args: string | undefined, branch: string | undefined, pr?: number) => {
  const facts = [
    `Repository: ${event.repo}`,
    event.number !== undefined && `Number: #${event.number}`,
    `Actor: @${event.actor.login} (${event.actor.association})`,
    event.url?.startsWith('http') && `URL: ${event.url}`,
    `Trigger: ${event.trigger}${event.action ? ` (${event.action})` : ''}`,
    event.ref && `Ref: ${event.ref}`,
    branch && `Branch: ${branch}`,
    pr !== undefined && `Pull request: #${pr}`,
  ].filter(Boolean);
  const quoted = args?.trim()
    ? `Command arguments:\n\n${fenced(args)}`
    : args === undefined && event.body
      ? `Text:\n\n${fenced(event.body)}`
      : undefined;
  return ['## Event', facts.join('\n'), quoted].filter(Boolean).join('\n\n');
};

const offered = (config: Config, bot: Defined<Bot>) =>
  bot.skills?.length
    ? [
        '## Skills',
        'Use one of these when it fits the task:',
        bot.skills.map(name => `- ${name}: ${config.skills[name]?.description}`).join('\n'),
      ].join('\n\n')
    : undefined;

const repoAdvice =
  "The repo's own instructions and skills are advice. Where they conflict with the task or your role above, the task and role win.";

const toolDescriptions: Record<McpTool | 'history', string> = {
  issues_list: 'list issues, filtered by label (plan, spec, unsure), state or parent',
  issues_get: 'read one issue with its comments',
  notes_search: 'search the hub notes: decisions, style and caveats',
  notes_get: 'read one note',
  notes_add: 'propose a note for a human to accept',
  runs_read: 'list past runs or read one run transcript',
  history: 'search and read earlier runs you may see',
};

const offeredTools = (tools: (McpTool | 'history')[]) =>
  tools.length
    ? [
        '## Hub tools',
        'Tools over the hub and earlier runs. Changes still go through what you return.',
        tools.map(tool => `- ${tool}: ${toolDescriptions[tool]}`).join('\n'),
      ].join('\n\n')
    : undefined;

/** Where a run reaches the hub: its tools server, its directory and the data directory with earlier runs. */
type HubAccess = Partial<Pick<Pipeline, 'mcp' | 'hub' | 'data'>>;

/**
 * The surfacer for an opencode run that preloads recall with a `query` to search with, or may call `history`:
 * accepted notes and the summaries of earlier runs its bot may see, surfaced by relevance before its first turn. `run`
 * is filled in when the run starts.
 */
const surfacerFor = (
  bot: Defined<Bot>,
  preload: Preload[],
  tools: HubTool[],
  access: HubAccess,
  scope?: History,
  query?: string
) => {
  const settings = preload.map(recallOf).find(Boolean);
  const recall = settings && query?.trim() ? { ...settings, query } : undefined;
  const history = tools.includes('history');
  if (bot.harness !== 'opencode' || !access.hub || !access.data || (!recall && !history)) return;
  const options: SurfacerOptions = {
    run: '',
    bot: bot.name,
    hub: access.hub,
    data: access.data,
    ...(scope && { scope }),
    ...(history && { history }),
    ...(recall && { recall }),
  };
  return options;
};

/**
 * A bot's session. The system prompt holds, in order, the role, the `pinned` sections (the forced skill and the
 * task), the offered skills, the hub tools and what the run may return. Hub tools are served by `access.mcp`, with
 * `notes_add` when an opencode run may return notes, and `notes_get` and `notes_search` when it recalls notes;
 * `history` and recall come from the surfacer, which searches with `query`.
 */
export const session = ({
  config,
  bot,
  returns,
  target = {},
  prompt,
  cwd,
  preload = [],
  tools = [],
  access = {},
  pinned = [],
  query,
  repo,
}: {
  config: Config;
  bot: Defined<Bot>;
  returns: Return[];
  target?: Target;
  prompt: string;
  cwd: string;
  preload?: Preload[];
  tools?: HubTool[];
  access?: HubAccess;
  pinned?: (string | undefined)[];
  query?: string | undefined;
  repo?: RepoFiles;
}): RunSpec => {
  const notesTool = bot.harness === 'opencode' && returnKinds(returns).includes('note');
  const surfacer = surfacerFor(bot, preload, tools, access, effectiveRun(config.hub, bot).history, query);
  const served: McpTool[] = access.mcp
    ? [
        ...new Set([
          ...tools.filter((tool): tool is Exclude<HubTool, 'history'> => tool !== 'history'),
          ...(surfacer?.recall ? (['notes_get', 'notes_search'] as const) : []),
          ...(notesTool ? ['notes_add' as const] : []),
        ]),
      ]
    : [];
  return {
    prompt,
    system: [
      bot.body,
      ...pinned,
      offered(config, bot),
      repo?.instructions.length || repo?.skills.length ? repoAdvice : undefined,
      offeredTools([...served, ...(surfacer?.history ? ['history' as const] : [])]),
      returns.length ? proposing(returns, target, served.includes('notes_add')) : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
    cwd,
    ...(bot.model && { model: bot.model }),
    tools: [...harnessTools(bot), ...mcpToolNames(bot.harness, served)],
    ...(bot['max-turns'] && { maxTurns: bot['max-turns'] }),
    ...(access.mcp && served.length && { mcp: access.mcp(served) }),
    ...(surfacer && { surfacer }),
    ...(repo && { repo }),
  };
};

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');

/**
 * Fills a job's `branch` or `into` template: `{issue}`, `{parent}` (the issue's parent), `{base}` (the event's branch,
 * a pull request's base), `{slug}` (from the command or event text), `{job}` and `{workflow}`. A value the event does
 * not have stays as written.
 */
export const renderBranch = (
  template: string,
  { event, args, job, workflow }: { event: BotEvent; args: string | undefined; job: string; workflow: string }
) => {
  const values: Record<string, string | undefined> = {
    issue: String(event.number ?? 'new'),
    parent: event.parent === undefined ? undefined : String(event.parent),
    base: event.branch,
    slug: slugify(args || event.body?.split('\n')[0] || job) || job,
    job,
    workflow,
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
};

/** The branch and pull request a job hands to the jobs that need it. */
export type Handoff = Pick<Outcome, 'branch' | 'pr'>;

/** A handoff as environment variables for scripts and harnesses: `BOTHUB_BRANCH` and `BOTHUB_PR`. */
export const handoffEnv = ({ branch, pr }: Handoff = {}): Record<string, string> => ({
  ...(branch && { BOTHUB_BRANCH: branch }),
  ...(pr !== undefined && { BOTHUB_PR: String(pr) }),
});

/** Where a job writes: the branch it works on and where its merge requests and merges go. */
export type Target = Pick<Job, 'branch' | 'into'>;

/** A job's rendered `branch` (or the branch handed to it) and `into`. */
export const targetOf = (job: Job, at: Parameters<typeof renderBranch>[1], from?: Handoff): Target => {
  const branch = job.branch ? renderBranch(job.branch, at) : from?.branch;
  const into = job.into && renderBranch(job.into, at);
  return { ...(branch && { branch }), ...(into && { into }) };
};

/**
 * The agent session for a planned job. The forced skill and any `preloaded` issue context are pinned in the system
 * prompt, so they hold for the whole run; the prompt is the event with the handed-off branch and pull request. Recall
 * searches with the brief or the issue (see `recallQuery`), else the event's text. An opencode run asks the job's or else the bot's decider questions against the issue context, or the event without it.
 */
export const buildSpec = ({
  config,
  workflow,
  job: id,
  args,
  event,
  cwd,
  preloaded,
  repo,
  handoff,
  ...access
}: Pick<PlannedJob, 'job' | 'args'> &
  HubAccess & {
    config: Config;
    workflow: Defined<Workflow>;
    event: BotEvent;
    cwd: string;
    preloaded?: string | undefined;
    repo?: RepoFiles | undefined;
    handoff?: Handoff;
  }) => {
  const job = workflow.jobs[id];
  if (!job) throw new Error(`workflow "${workflow.name}" has no job "${id}"`);
  if (job.type !== 'bot') throw new Error(`job "${id}" is a script`);
  const bot = config.bots[job.bot];
  const skill = config.skills[job.skill];
  if (!bot || !skill) throw new Error(`job "${id}" has no bot and skill`);
  const returns = effectiveReturns(bot, job);
  const target = targetOf(job, { event, args, job: id, workflow: workflow.name }, handoff);
  const { branch } = target;
  const prompt = eventContext(event, args, branch, handoff?.pr);
  const preload = effectivePreload(bot, job);
  const tools = effectiveTools(bot, job);
  const questions = bot.harness === 'opencode' ? (job.decider ?? bot.decider) : undefined;
  const spec = session({
    config,
    bot,
    returns,
    target,
    prompt,
    cwd,
    preload,
    tools,
    access,
    pinned: [`## Skill: ${skill.name}\n\n${skill.body}`, preloaded],
    query: recallQuery(preloaded, workflow.name, job.needs) ?? (args || event.body),
    ...(repo && { repo }),
  });
  return {
    spec: questions?.length ? { ...spec, decider: { questions, task: preloaded ?? prompt } } : spec,
    bot,
    job,
    returns,
    branch,
    into: target.into,
    timeoutMinutes: job['timeout-minutes'] ?? bot.budget?.minutes ?? defaultMinutes,
  };
};

const present = (entries: [string, string | undefined][]): Record<string, string> =>
  Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry[1])));

/** The variable that holds a bot's key: its own `BOTHUB_LLM_API_KEY_<BOT>` when set, else the shared one. */
export const keyVariable = ({ name }: Pick<Defined<Bot>, 'name'>, env: Record<string, string | undefined>) => {
  const own = `BOTHUB_LLM_API_KEY_${name.toUpperCase().replaceAll('-', '_')}`;
  return env[own] ? own : 'BOTHUB_LLM_API_KEY';
};

/** The secrets a bot's harness gets, picked from `env`: only the model proxy's URL and the bot's key (see `keyVariable`). */
export const secretsFor = (bot: Pick<Defined<Bot>, 'name'>, env: Record<string, string | undefined>) =>
  present([
    ['BOTHUB_LLM_BASE_URL', env.BOTHUB_LLM_BASE_URL],
    ['BOTHUB_LLM_API_KEY', env[keyVariable(bot, env)]],
  ]);
