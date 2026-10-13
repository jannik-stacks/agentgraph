import { readFile } from 'node:fs/promises';
import { Effect } from 'effect';
import { apply, type ApplyResult } from './apply.ts';
import {
  effectivePreload,
  effectiveReturns,
  effectiveTools,
  harnessTools,
  jobOrder,
  recallOf,
  returnGlobs,
  returnKinds,
  type Config,
  type Defined,
} from './config.ts';
import { isTrusted, type PlannedJob } from './dispatch.ts';
import { decideCheck } from './decide.ts';
import { fanOut, itemsOf, type Item } from './over.ts';
import { harnesses } from './harnesses/index.ts';
import type { GitHub } from './github-app.ts';
import { githubIssues } from './issues-github.ts';
import { roles, type Issues } from './issues.ts';
import type { SurfacerOptions } from './harnesses/opencode-surfacer.ts';
import { hubProposal } from './hub-write.ts';
import { mcpToolNames, type McpServer } from './mcp-config.ts';
import { proposalsFile, type McpTool } from './mcp.ts';
import { writeMemory } from './memory.ts';
import {
  approved,
  extractProposals,
  matchGlob,
  Proposal,
  validate,
  type Rejection,
  type Validated,
} from './outputs.ts';
import { issueContext } from './preload.ts';
import { githubPulls, type Pull, type Pulls } from './pulls.ts';
import { runJob, runScript, type Launcher, type limiter } from './runner.ts';
import {
  NoteKind,
  type Preload,
  type Bot,
  type Check,
  type Closure,
  type Harness,
  type HubTool,
  type Job,
  type Over,
  type ProposalKind,
  type Return,
  type Workflow,
} from './schema.ts';
import { items, Summarizer, summarizeRun } from './summaries.ts';
import type { EventRecord, Outcome, Run, Store, Verdict } from './store.ts';
import type { BotEvent, HarnessAdapter, RunSpec } from './types.ts';
import { unresolved, type Workspaces } from './workspace.ts';

const defaultMinutes = 30;

const examples: Record<ProposalKind, string> = {
  reply: '{ "kind": "reply", "body": "Markdown comment on the issue or pull request" }',
  label: '{ "kind": "label", "add": ["bug"], "remove": ["needs-triage"] }',
  push: '{ "kind": "push", "branch": "<branch>", "files": ["src/changed.ts"] }',
  'merge-request':
    '{ "kind": "merge-request", "title": "…", "body": "Closes #<issue>", "branch": "<branch>", "into": "<into>", "draft": true }',
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

const fenced = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
};

const eventContext = (event: BotEvent, args: string | undefined, branch: string | undefined, pr?: number) => {
  const facts = [
    `Repository: ${event.repo}`,
    event.number !== undefined && `Number: #${event.number}`,
    `Actor: @${event.actor.login} (${event.actor.association})`,
    event.url && `URL: ${event.url}`,
    `Trigger: ${event.trigger}${event.action ? ` (${event.action})` : ''}`,
    event.ref && `Ref: ${event.ref}`,
    branch && `Branch: ${branch}`,
    pr !== undefined && `Pull request: #${pr}`,
  ].filter(Boolean);
  const quoted =
    args !== undefined
      ? `Command arguments:\n\n${fenced(args)}`
      : event.body
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
 * The surfacer for an opencode run that preloads recall or may call `history`: accepted notes and the summaries of
 * earlier runs its bot may see, surfaced by relevance as it works. `run` is filled in when the run starts.
 */
const surfacerFor = (config: Config, bot: Defined<Bot>, preload: Preload[], tools: HubTool[], access: HubAccess) => {
  const recall = preload.map(recallOf).find(Boolean);
  const history = tools.includes('history');
  if (bot.harness !== 'opencode' || !access.hub || !access.data || (!recall && !history)) return;
  const options: SurfacerOptions = {
    run: '',
    bot: bot.name,
    hub: access.hub,
    data: access.data,
    share: Object.fromEntries(Object.values(config.bots).map(b => [b.name, b.session?.share ?? 'bot'])),
    ...(bot.summarizer && { summarizer: bot.summarizer }),
    ...(history && { history }),
    ...(!recall && { surface: false }),
    ...(recall?.cutoff !== undefined && { cutoff: recall.cutoff }),
    ...(recall?.budget !== undefined && { budget: recall.budget }),
  };
  return options;
};

/**
 * A bot's session. The system prompt holds, in order, the role, the `pinned` sections (the forced skill and the
 * task), the offered skills, the hub tools and what the run may return. Hub tools are served by `access.mcp`, with
 * `notes_add` when an opencode run may return notes; `history` and recall come from the surfacer.
 */
const session = ({
  config,
  bot,
  returns,
  target = {},
  prompt,
  cwd,
  preload = ['recall'],
  tools = [],
  access = {},
  pinned = [],
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
}): RunSpec => {
  const notesTool = bot.harness === 'opencode' && returnKinds(returns).includes('note');
  const served: McpTool[] = access.mcp
    ? [
        ...tools.filter((tool): tool is Exclude<HubTool, 'history'> => tool !== 'history'),
        ...(notesTool ? ['notes_add' as const] : []),
      ]
    : [];
  const surfacer = surfacerFor(config, bot, preload, tools, access);
  return {
    prompt,
    system: [
      bot.body,
      ...pinned,
      offered(config, bot),
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
type Target = Pick<Job, 'branch' | 'into'>;

/** A job's rendered `branch` (or the branch handed to it) and `into`. */
const targetOf = (job: Job, at: Parameters<typeof renderBranch>[1], from?: Handoff): Target => {
  const branch = job.branch ? renderBranch(job.branch, at) : from?.branch;
  const into = job.into && renderBranch(job.into, at);
  return { ...(branch && { branch }), ...(into && { into }) };
};

/**
 * The agent session for a planned job. The forced skill and any `preloaded` issue context are pinned in the system
 * prompt, so they hold for the whole run; the prompt is the event with the handed-off branch and pull request.
 */
export const buildSpec = ({
  config,
  workflow,
  job: id,
  args,
  event,
  cwd,
  preloaded,
  handoff,
  ...access
}: Pick<PlannedJob, 'job' | 'args'> &
  HubAccess & {
    config: Config;
    workflow: Defined<Workflow>;
    event: BotEvent;
    cwd: string;
    preloaded?: string | undefined;
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
  return {
    spec: session({
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
    }),
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

/**
 * The secrets a bot's harness gets, picked from `env`: only the model proxy's URL and the bot's own key
 * (`BOTHUB_LLM_API_KEY_<BOT>`, falling back to the shared `BOTHUB_LLM_API_KEY`).
 */
export const secretsFor = ({ name }: Pick<Defined<Bot>, 'name'>, env: Record<string, string | undefined>) =>
  present([
    ['BOTHUB_LLM_BASE_URL', env.BOTHUB_LLM_BASE_URL],
    [
      'BOTHUB_LLM_API_KEY',
      env[`BOTHUB_LLM_API_KEY_${name.toUpperCase().replaceAll('-', '_')}`] ?? env.BOTHUB_LLM_API_KEY,
    ],
  ]);

/**
 * Everything a planned job needs to run. Without `gh` or `issues`, nothing is applied; merge requests go through
 * `pulls`, GitHub's when only `gh` is given, and are skipped without either. Hub changes land through `hubPr`, by default on a branch of the `hub` directory's own repository.
 * `data` is the data directory: runs are summarized into it, and opencode runs surface what it holds. Scripts see the `hub` directory read-only as `BOTHUB_HUB` and the
 * commit their worktree started from as `BOTHUB_BASE`. `issues` defaults to GitHub's when `gh` is given and also feeds
 * `preload`; `mcp` starts the server for a run's hub tools, which are left out without it. Harnesses and scripts
 * run in the sandbox; `launch` replaces it only in tests and the simulator.
 */
export type Pipeline = {
  config: Config;
  event: BotEvent;
  store: Store;
  workspaces: Workspaces;
  limit: Effect.Effect.Success<ReturnType<typeof limiter>>;
  env: Record<string, string | undefined>;
  gh?: GitHub;
  issues?: Issues;
  pulls?: Pulls;
  mcp?: (tools: McpTool[]) => McpServer;
  hub?: string;
  data?: string;
  hubPr?: Parameters<typeof apply>[1]['hubPr'];
  adapters?: Record<Harness, HarnessAdapter>;
  launch?: Launcher;
  onEvent?: (run: Run, record: EventRecord) => void;
};

const pullsOf = (p: Pipeline) => p.pulls ?? (p.gh && githubPulls(p.gh, p.event.repo));

const issuesOf = (p: Pipeline) => p.issues ?? (p.gh && githubIssues(p.gh, p.event.repo));

/** A planned job, either skipped with a stored reason and closure, or run with its final outcome. */
export type JobResult = PlannedJob & ({ skipped: string; closure: Closure } | { run: Run; outcome?: Outcome });

const skip = async (
  planned: PlannedJob,
  reason: string,
  p: Pipeline,
  closure: Closure = 'deferred',
  extra: Pick<Run, 'approval'> = {}
): Promise<JobResult> => {
  const { workflow, job, bot } = planned;
  await p.store.create({
    workflow,
    job,
    ...(bot && { bot }),
    event: p.event,
    status: 'skipped',
    closure,
    reason,
    ...extra,
  });
  return { ...planned, skipped: reason, closure };
};

const day = 24 * 60 * 60 * 1000;

/** A run whose sandbox never started: no agent ran, so it costs no budget and waits for the sandbox. */
const sandboxFailed = (run: Pick<Run, 'error'>) => run.error?.startsWith('sandbox-failed: ') ?? false;

/**
 * Why a bot may not start another run today, if it may not. Every run counts, attempts and checks too, except
 * runs whose sandbox never started.
 */
const outOfRuns = async (bot: Defined<Bot>, store: Store, now = Date.now()) => {
  const cap = bot.budget?.['runs-per-day'];
  if (!cap) return;
  const used = (await store.list()).filter(
    run => run.bot === bot.name && run.startedAt && now - Date.parse(run.startedAt) < day && !sandboxFailed(run)
  ).length;
  return used >= cap ? `bot "${bot.name}" used its ${cap} runs for the last 24 hours` : undefined;
};

/** Writes a run's summaries into the data directory, with the bot's summarizer; a summary never fails the run. */
const summarize = async (bot: Defined<Bot>, run: string, p: Pipeline) => {
  const settings = bot.summarizer ?? Summarizer.parse('extractive');
  if (!p.data || settings.mode === 'off') return;
  const { BOTHUB_LLM_BASE_URL: url, BOTHUB_LLM_API_KEY: apiKey } = secretsFor(bot, p.env);
  await summarizeRun(p.data, run, settings, url ? { endpoint: { url, ...(apiKey && { apiKey }) } } : {}).catch(
    () => {}
  );
};

/**
 * Runs one agent session through the limiter and resolves to the finished run and its final message. A bot out of
 * runs for the day is skipped instead; the model the harness reports is recorded on the run.
 */
const agent = (
  bot: Defined<Bot>,
  spec: RunSpec,
  timeoutMinutes: number,
  run: Run,
  p: Pipeline,
  env: Record<string, string> = {}
) =>
  Effect.gen(function* () {
    const spent = yield* Effect.promise(() => outOfRuns(bot, p.store));
    if (spent) {
      const skipped = yield* Effect.promise(() => p.store.update(run.id, { status: 'skipped', reason: spent }));
      return { run: skipped, final: '' };
    }
    let result: string | undefined;
    let lastText = '';
    let model: string | undefined;
    const finished = yield* p.limit(
      runJob({
        adapter: (p.adapters ?? harnesses)[bot.harness],
        spec: spec.surfacer ? { ...spec, surfacer: { ...spec.surfacer, run: run.id } } : spec,
        timeoutMinutes,
        store: p.store,
        runId: run.id,
        secrets: { ...secretsFor(bot, p.env), ...env },
        ...(p.launch && { launch: p.launch }),
        onEvent: record => {
          if (record.event.type === 'start') model ??= record.event.model;
          if (record.event.type === 'text') lastText = record.event.text;
          if (record.event.type === 'end') result = record.event.result;
          p.onEvent?.(run, record);
        },
      })
    );
    const reported: string | undefined = model;
    const recorded = reported ? yield* Effect.promise(() => p.store.update(run.id, { model: reported })) : finished;
    yield* Effect.promise(() => summarize(bot, run.id, p));
    return { run: recorded, final: result ?? lastText };
  });

/**
 * Reads a check bot's verdict: its reply's first line is `PASS` or `FAIL`, the rest are findings. A check that cannot
 * decide (the run failed, there is no reply, or the first line is neither word) fails with the reason.
 */
export const verdictOf = (run: Run, final: string): Pick<Verdict, 'pass' | 'findings'> => {
  if (run.status !== 'succeeded') {
    const why = run.error ?? run.reason;
    return { pass: false, findings: `run ${run.id} ${run.status}${why ? `: ${why}` : ''}` };
  }
  const reply = extractProposals(final).proposals.find(proposal => proposal.kind === 'reply');
  if (!reply) return { pass: false, findings: `run ${run.id} gave no verdict` };
  const [first = '', ...rest] = reply.body.trim().split('\n');
  const word = first.trim().toUpperCase();
  if (word !== 'PASS' && word !== 'FAIL')
    return { pass: false, findings: `run ${run.id} gave no verdict: its first line is neither PASS nor FAIL` };
  const findings = rest.join('\n').trim();
  return { pass: word === 'PASS', ...(findings && { findings }) };
};

const verdictContract = [
  '## Verdict',
  'End with a `bothub` block holding one reply. Its first line is `PASS` or `FAIL`; the lines after it are your',
  'findings, most severe first, each naming the file and line.',
].join('\n');

/** One attempt of a job in its worktree. `merging` is set while it resolves a merge of `base` into its branch. */
type Attempt = {
  planned: PlannedJob;
  job: Job;
  worktree: string;
  cwd: string;
  base: string;
  parent: Run;
  handoff: Handoff;
  target: Target;
  item?: number;
  merging?: boolean;
};

/** Where `over` reads from: the worktree, the commit the change starts at, the files in scope and the script env. */
type Scope = {
  worktree: string;
  cwd: string;
  since: string;
  files: string[];
  timeout: number;
  env: Record<string, string>;
};

/**
 * The items `over` names. A script `over` runs in the worktree with `BOTHUB_BASE` set to where the change starts; a
 * script that fails, or prints more items than `max`, gives an error instead.
 */
const gather = async (over: Over, scope: Scope, p: Pipeline): Promise<{ items: Item[]; error?: string }> => {
  if (typeof over === 'object') {
    const script = 'each' in over ? over.each : over.run;
    const env = { ...scope.env, BOTHUB_BASE: scope.since };
    const { ok, output, stdout } = await runScript(script, scope.cwd, scope.timeout, env, p.launch, p.hub);
    if (!ok) return { items: [], error: `the "over" script failed: ${output || 'exited non-zero'}` };
    const items = itemsOf(over, { diff: '', output: stdout });
    if ('each' in over && items.length > over.max)
      return {
        items: [],
        error: `the "over" script printed ${items.length} items, more than "max" allows (${over.max})`,
      };
    return { items };
  }
  if (over === 'event') return { items: itemsOf(over, { diff: '', event: p.event.body }) };
  const { diff } = await p.workspaces.changes(scope.worktree, scope.since, scope.files);
  return { items: itemsOf(over, { diff }) };
};

/** An item as a prompt section. The event is already in every prompt, so it gets none. */
const itemSection = (over: Over, item: Item) => {
  if (over === 'event') return;
  const titles: Record<Exclude<Over, object>, string> = {
    diff: 'Changes',
    added: 'Added lines',
    event: 'Event',
    'each-file': `Changes to ${item.label}`,
    'each-hunk': `Hunk in ${item.label}`,
  };
  const title = typeof over === 'string' ? titles[over] : 'run' in over ? 'Command output' : `Item: ${item.label}`;
  return `## ${title}\n\n${fenced(item.text)}`;
};

/** The item as a script sees it: in `BOTHUB_ITEM` and on stdin. */
const runOnItem = (script: string, item: Item, scope: Scope, p: Pipeline) =>
  runScript(script, scope.cwd, scope.timeout, { ...scope.env, BOTHUB_ITEM: item.text }, p.launch, p.hub, item.text);

type Judged = Pick<Verdict, 'pass' | 'findings'> & { run?: string };

const judgeWith = (check: Defined<Check>, a: Attempt, scope: Scope, p: Pipeline) => {
  if (check.type === 'script')
    return (item: Item) =>
      Effect.promise(async (): Promise<Judged> => {
        const { ok, output } = await runOnItem(check.run, item, scope, p);
        return { pass: ok, ...(!ok && { findings: output || 'exited non-zero' }) };
      });
  if (check.type === 'decide')
    return (item: Item) =>
      Effect.promise(() => decideCheck(check.body.trim(), item.text, p.env, check.threshold) as Promise<Judged>);
  const bot = p.config.bots[check.bot];
  const skill = check.skill ? p.config.skills[check.skill] : undefined;
  return (item: Item): Effect.Effect<Judged> =>
    Effect.gen(function* () {
      if (!bot) return { pass: false, findings: `unknown bot "${check.bot}"` };
      const prompt = [
        skill?.body,
        check.body,
        itemSection(check.over, item),
        verdictContract,
        eventContext(p.event, a.planned.args, undefined),
      ]
        .filter(Boolean)
        .join('\n\n');
      const created = yield* Effect.promise(() =>
        p.store.create({
          workflow: a.planned.workflow,
          job: a.planned.job,
          bot: bot.name,
          harness: bot.harness,
          event: p.event,
          parent: a.parent.id,
          check: check.name,
        })
      );
      const spec = session({
        config: p.config,
        bot,
        returns: ['reply'],
        prompt,
        cwd: a.cwd,
        preload: effectivePreload(bot, {}),
        tools: effectiveTools(bot, {}),
        access: p,
      });
      const { run, final } = yield* agent(bot, spec, bot.budget?.minutes ?? defaultMinutes, created, p);
      return { ...verdictOf(run, final), run: run.id };
    });
};

/**
 * Runs one check over an attempt's changes. A check whose `paths` match no changed file, or that has nothing to look
 * at, is skipped. A script that does not fan out runs once and reads the worktree itself; every other check judges
 * each item `over` names and passes only when every item passes.
 */
const runCheck = (check: Defined<Check>, a: Attempt, p: Pipeline) =>
  Effect.gen(function* () {
    const done = (result: Pick<Verdict, 'pass' | 'findings' | 'runs' | 'skipped'>): Verdict => ({
      check: check.name,
      gating: check.mode !== 'shadow',
      ...result,
    });
    const skipped = (findings: string) => done({ pass: false, skipped: true, findings });
    const { paths, over } = check;
    const changed = paths ? (yield* Effect.promise(() => p.workspaces.changes(a.worktree, a.base))).files : [];
    const files = changed.filter(file => paths?.some(glob => matchGlob(glob, file)));
    if (paths && !files.length) return skipped('no changed file matches its paths');
    const scope: Scope = {
      worktree: a.worktree,
      cwd: a.cwd,
      since: a.base,
      files,
      timeout: a.job['timeout-minutes'] ?? defaultMinutes,
      env: { ...handoffEnv(a.handoff), BOTHUB_BASE: a.base },
    };

    if (check.type === 'script' && !fanOut(over)) {
      const { ok, output } = yield* Effect.promise(() =>
        runScript(check.run, a.cwd, scope.timeout, scope.env, p.launch, p.hub)
      );
      return done({ pass: ok, ...(!ok && { findings: output || 'exited non-zero' }) });
    }

    const { items, error } = yield* Effect.promise(() => gather(over, scope, p));
    if (error) return done({ pass: false, findings: error });
    if (!items.length) return skipped('nothing to look at');
    const judge = judgeWith(check, a, scope, p);
    const runs: string[] = [];
    const findings: string[] = [];
    let pass = true;
    for (const item of items) {
      const verdict = yield* judge(item);
      if (verdict.run) runs.push(verdict.run);
      pass &&= verdict.pass;
      if (verdict.findings) findings.push(items.length > 1 ? `${item.label}:\n${verdict.findings}` : verdict.findings);
    }
    return done({
      pass,
      ...(runs.length && { runs }),
      ...(findings.length && { findings: findings.join('\n\n') }),
    });
  });

/**
 * The gating checks that fail an attempt. A check skipped because the change touches nothing it covers does not gate,
 * unless no gating check ran at all: then every skipped one fails, so a change is never passed unchecked.
 */
export const failingChecks = (verdicts: Verdict[]) => {
  const gating = verdicts.filter(v => v.gating);
  const ran = gating.filter(v => !v.skipped);
  return ran.length ? ran.filter(v => !v.pass) : gating.filter(v => v.skipped);
};

/** The files a merge left conflicting, as a prompt section; `attempt` marks a follow-up. */
const conflictSection = (files: string[], attempt?: string) =>
  [
    '## Merge conflicts',
    `${attempt ? `${attempt} These files still hold conflict markers.` : 'The branch your work goes into was merged into this worktree and conflicts with your change.'} Resolve each conflict keeping what both sides meant, remove every marker, then push your branch again; the merge is committed for you.`,
    files.map(file => `- ${file}`).join('\n'),
  ].join('\n\n');

const followUp = (
  prompt: string,
  failing: Verdict[],
  rejected: Rejection[],
  attempt: number,
  total: number,
  problems: string[] = [],
  earlier?: string,
  conflicts: string[] = []
) =>
  [
    prompt,
    ...(earlier ? ['## Your earlier attempt', earlier] : []),
    ...(conflicts.length ? [conflictSection(conflicts, `Attempt ${attempt} of ${total}.`)] : []),
    ...(problems.length
      ? [
          '## Proposal errors',
          `Attempt ${attempt} of ${total}. Your earlier changes are still in this worktree, but your last reply ended without usable proposals. Fix these, then end with your proposals again.`,
          problems.map(problem => `- ${problem}`).join('\n'),
        ]
      : []),
    ...(failing.length
      ? [
          '## Check findings',
          `Attempt ${attempt} of ${total}. Your earlier changes are still in this worktree, but these checks failed. Fix what they found, then end with your proposals again.`,
        ]
      : []),
    ...failing.map(v => `### ${v.check}\n\n${fenced(v.findings ?? 'failed without output')}`),
    ...(rejected.length
      ? [
          '## Rejected proposals',
          rejected.map(({ proposal, reason }) => `- \`${proposal.kind}\`: ${reason}`).join('\n'),
        ]
      : []),
  ].join('\n\n');

/** Errors that mean the provider refused the run for now: rate and usage limits, quotas, overload. */
const providerLimit = /\b(429|rate[ -]?limit|usage limit|quota|overloaded)\b/i;

const kindsOf = (outcome: Outcome) =>
  outcome.applied
    ? outcome.results.filter(result => result.status === 'applied').map(result => result.kind)
    : outcome.accepted.map(proposal => proposal.kind);

const closed = (closure: Closure, reason?: string): Pick<Run, 'closure' | 'reason'> => ({
  closure,
  ...(reason && { reason }),
});

/**
 * What happened to a job's work, from its run and outcome. A closure the bot stated wins once the run succeeded. A
 * question is `blocked`, a merge request `handed-off`, any other write (a merge too) `done`. A push without a merge
 * request is `handed-off` when a later job needs this one or it resolves a merge, otherwise `blocked`. A job that may push but
 * changed nothing, or one that wrote nothing at all, is `no-op`. A skipped run, a provider limit or a sandbox that
 * never started is `deferred`;
 * any other failure, or an effect that failed to apply, is `blocked`.
 */
export const closureOf = (run: Run, outcome: Outcome | undefined, returns: ProposalKind[], taken = false) => {
  if (run.status === 'skipped') return closed('deferred', run.reason);
  const asked = outcome && kindsOf(outcome).includes('ask');
  if (run.status !== 'succeeded') {
    if (providerLimit.test(run.error ?? '')) return closed('deferred', `the provider refused the run: ${run.error}`);
    if (sandboxFailed(run)) return closed('deferred', run.error);
    return closed('blocked', asked ? 'asked a human' : (run.error ?? `the run ${run.status}`));
  }
  const stated = outcome?.accepted.find(proposal => proposal.kind === 'close');
  if (stated) return closed(stated.as, stated.reason);
  if (!outcome) return closed('no-op', 'proposed nothing');
  const failed = outcome.results.find(result => result.status === 'failed');
  if (failed) return closed('blocked', `${failed.kind} failed: ${failed.reason ?? 'unknown error'}`);
  const kinds = kindsOf(outcome).filter(kind => kind !== 'close');
  if (asked) return closed('blocked', 'asked a human');
  if (kinds.includes('merge-request')) return closed('handed-off');
  if (kinds.includes('push'))
    return taken ? closed('handed-off') : closed('blocked', 'pushed a branch without opening a merge request');
  if (returns.includes('push')) return closed('no-op', 'proposed no change');
  return kinds.length ? closed('done') : closed('no-op', 'proposed nothing');
};

const pullNumber = (url: string | undefined) => Number(url?.match(/\/(\d+)$/)?.[1]) || undefined;

/** The branch that landed and the merge request that is open after applying. */
const handoffOf = (applied: Proposal[], results: ApplyResult[]): Handoff => {
  const landed = (kind: Proposal['kind']) => results.find(r => r.kind === kind && r.status === 'applied');
  const push = applied.find((proposal): proposal is Extract<Proposal, { kind: 'push' }> => proposal.kind === 'push');
  const request = applied.find(
    (proposal): proposal is Extract<Proposal, { kind: 'merge-request' }> => proposal.kind === 'merge-request'
  );
  const opened = landed('merge-request');
  const branch = push && landed('push') ? push.branch : request && opened ? request.branch : undefined;
  const number = pullNumber(opened?.url);
  return { ...(branch && { branch }), ...(number && { pr: number }) };
};

/** Effects recorded by earlier runs of the same event and job, applied ones first. */
const priorEffects = async (run: Run, p: Pipeline) => {
  const earlier = (await p.store.list()).filter(
    r => r.id !== run.id && r.event.id === p.event.id && r.workflow === run.workflow && r.job === run.job && !r.check
  );
  const results = (await Promise.all(earlier.map(r => p.store.outcome(r.id)))).flatMap(o => o?.results ?? []);
  return results.sort((x, y) => Number(y.status === 'applied') - Number(x.status === 'applied'));
};

/**
 * Stores and returns an attempt's outcome, applying `toApply` when the mode and a GitHub client allow it. The planned
 * effects are journalled in the outcome before the first one is applied.
 */
const settle = async (
  run: Run,
  { proposals, errors }: ReturnType<typeof extractProposals>,
  { accepted, rejected, apply: allowed }: Validated,
  toApply: Proposal[] | undefined,
  a: Attempt,
  p: Pipeline,
  checks?: Verdict[]
): Promise<Outcome> => {
  const { gh, issues, event, workspaces, hubPr } = p;
  const pulls = pullsOf(p);
  const applied = toApply !== undefined && allowed && (gh !== undefined || issues !== undefined || pulls !== undefined);
  const { paths } = a.job;
  const base: Outcome = { proposals, errors, accepted, rejected, results: [], applied, ...(checks && { checks }) };
  if (!applied) return p.store.saveOutcome(run.id, base);
  const writes = toApply.filter(proposal => proposal.kind !== 'close');
  const push: Parameters<typeof apply>[1]['push'] = ({ kind: _, ...proposal }, journal) =>
    workspaces.publish(event.repo, a.worktree, {
      ...proposal,
      ...(paths && { paths }),
      message: `bothub: ${run.job}`,
      base: a.base,
      ...journal,
    });
  const results = await apply(writes, {
    event,
    push,
    prefix: `${event.id}/${run.workflow}/${run.job}${a.item ? `/item-${a.item + 1}` : ''}${a.merging ? `/merge-${a.base.slice(0, 12)}` : ''}`,
    prior: await priorEffects(run, p),
    record: results => p.store.saveOutcome(run.id, { ...base, results }),
    ...(gh && { gh }),
    ...(issues && { issues }),
    ...(pulls && { pulls }),
    origin: { job: `${run.workflow}/${run.job}`, event: event.id },
    ...(a.target.into && { into: a.target.into }),
    merge: request => landMerge(request, a, p),
    ...((hubPr ?? p.hub) && { hubPr: hubPr ?? hubProposal(p.hub!) }),
  });
  return p.store.saveOutcome(run.id, { ...base, results, ...handoffOf(writes, results) });
};

type Landed = { conflicts: string[] } | { sha: string };

/**
 * Merges `pull` into a fresh worktree of its branch. When it merges cleanly, runs the job's `requires` checks on the
 * merged tree and lands the merge while both branches are still where the checks saw them.
 */
const tryMerge = async (pull: Pull, round: number, a: Attempt, pulls: Pulls, p: Pipeline): Promise<Landed> => {
  const id = `${a.parent.id}-merge-${pull.number}-${round}`;
  const tree = await p.workspaces.create({ repo: p.event.repo, ref: pull.branch, merge: pull.into }, id);
  try {
    if (tree.conflicts.length) return { conflicts: tree.conflicts };
    const at: Attempt = { ...a, worktree: id, cwd: tree.path, base: tree.base };
    const verdicts = await Effect.runPromise(
      Effect.forEach(a.job.requires ?? [], name => {
        const check = p.config.checks[name];
        return check ? runCheck(check, at, p) : Effect.succeed<Verdict>({ check: name, gating: true, pass: false });
      })
    );
    const failing = failingChecks(verdicts);
    if (failing.length)
      throw new Error(
        `required checks failed on the merged tree: ${failing.map(v => `${v.check}${v.findings ? ` (${v.findings.split('\n')[0]})` : ''}`).join(', ')}`
      );
    return await pulls.merge(pull.number, { head: tree.head, into: tree.base });
  } finally {
    await p.workspaces.remove(p.event.repo, id);
  }
};

/** Runs the job that opened `pull` again, on its branch with `into` merged in, so its bot resolves the conflicts. */
const resolveConflicts = async (pull: Pull, p: Pipeline) => {
  const [workflow = '', job = ''] = pull.origin?.job.split('/') ?? [];
  const definition = p.config.workflows[workflow]?.jobs[job];
  const event = (await p.store.list()).find(run => run.event.id === pull.origin?.event)?.event;
  if (!definition || !event) return;
  const planned: PlannedJob = { workflow, job, ...(definition.type === 'bot' && { bot: definition.bot }) };
  await Effect.runPromise(runPlanned(planned, { ...p, event }, {}, pull.into));
};

/**
 * Lands merge request `number` for an attempt's job: only an open request from a `bothub/` branch into the job's
 * `into`, and into the default branch only when `hub.yaml` lets bots merge there. A conflicting request goes back to
 * the job that opened it once; the job's `requires` checks then run on the merged tree before the merge lands.
 */
const landMerge = async (number: number, a: Attempt, p: Pipeline): Promise<Omit<ApplyResult, 'kind' | 'key'>> => {
  const pulls = pullsOf(p);
  if (!pulls) return { status: 'skipped', reason: 'no merge requests to merge' };
  const pull = await pulls.get(number);
  if (pull?.state !== 'open') throw new Error(`merge request #${number} is not open`);
  if (!pull.branch.startsWith('bothub/')) throw new Error(`merge request #${number} is not from a bothub/ branch`);
  const main = await pulls.defaultBranch();
  const into = a.target.into ?? main;
  if (pull.into !== into) throw new Error(`merge request #${number} goes into "${pull.into}", not "${into}"`);
  if (into === main && p.config.hub.merge['default-branch'] === 'human')
    throw new Error(`only a human merges into the default branch "${main}"`);
  let landed = await tryMerge(pull, 1, a, pulls, p);
  if ('conflicts' in landed) {
    await resolveConflicts(pull, p);
    landed = await tryMerge(pull, 2, a, pulls, p);
  }
  if ('conflicts' in landed) throw new Error(`merge request #${number} conflicts in ${landed.conflicts.join(', ')}`);
  return { status: 'applied', url: pull.url, sha: landed.sha };
};

/** Saves the memory of a job's final run; a memory that cannot be written never fails the job. */
const remember = async (run: Run, outcome: Outcome | undefined, p: Pipeline) => {
  try {
    await writeMemory(p.store, run, await p.store.events(run.id), outcome);
  } catch {}
};

const finish = (
  planned: PlannedJob,
  run: Run,
  outcome: Outcome | undefined,
  kinds: ProposalKind[],
  p: Pipeline,
  merging = false
) =>
  Effect.promise(async (): Promise<JobResult> => {
    const jobs = Object.values(p.config.workflows[planned.workflow]?.jobs ?? {});
    const taken = merging || jobs.some(job => job.needs.includes(planned.job));
    const final = await p.store.update(run.id, closureOf(run, outcome, kinds, taken));
    await remember(final, outcome, p);
    return { ...planned, run: final, ...(outcome && { outcome }) };
  });

/** The issue context a planned job preloads, read from `issues`, or GitHub's issues when only `gh` is given. */
const preloadFor = async (planned: PlannedJob, workflow: Defined<Workflow>, p: Pipeline) => {
  const job = workflow.jobs[planned.job];
  const bot = job?.type === 'bot' ? p.config.bots[job.bot] : undefined;
  if (job?.type !== 'bot' || !bot) return;
  return issueContext(issuesOf(p), p.event, effectivePreload(bot, job));
};

/**
 * Why a finished run's reply cannot be acted on, for a job that may propose something: its proposal block did not
 * parse, every proposal was rejected, or it proposed nothing at all.
 */
export const proposalProblems = (
  extracted: ReturnType<typeof extractProposals>,
  validated: Validated,
  kinds: ProposalKind[]
): string[] => {
  if (!kinds.length) return [];
  if (extracted.errors.length) return extracted.errors;
  if (validated.rejected.length && !validated.accepted.length)
    return validated.rejected.map(({ proposal, reason }) => `\`${proposal.kind}\` was rejected: ${reason}`);
  if (!extracted.proposals.length)
    return [
      'the reply has no bothub block; end with your proposals, or a `close` proposal when there is nothing to do',
    ];
  return [];
};

/** The notes a run proposed with `notes_add`, ahead of those in its final message. */
const withTools = async (extracted: ReturnType<typeof extractProposals>, run: Run, p: Pipeline) => {
  const text = await readFile(proposalsFile(p.store.home(run.id)), 'utf8').catch(() => '');
  const recorded = text
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        const parsed = Proposal.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  return recorded.length ? { ...extracted, proposals: [...recorded, ...extracted.proposals] } : extracted;
};

const earlierLines = 40;

/** What an attempt did, one line per message and tool call, for the next attempt of a bot that resumes. */
const attemptSummary = async (run: Run, p: Pipeline) => {
  const lines = items(await p.store.events(run.id)).map(item => `- ${item.line}`);
  return lines.slice(-earlierLines).join('\n') || undefined;
};

const costOf = async (ids: string[], store: Store) =>
  (await Promise.all(ids.map(id => store.read(id)))).reduce((sum, run) => sum + (run?.costUsd ?? 0), 0);

/**
 * A run's worktree: the run that owns it, its path, the commit its change is measured from, and while it resolves a
 * merge (`merging`), the files that merge left conflicting.
 */
type Worktree = { id: string; cwd: string; base: string; conflicts: string[]; merging: boolean };

/** The default branch, when the job may open merge requests and there is a backend to ask. */
const defaultBranchFor = async (kinds: ProposalKind[], p: Pipeline) =>
  kinds.includes('merge-request')
    ? pullsOf(p)
        ?.defaultBranch()
        .catch(() => undefined)
    : undefined;

/**
 * Runs the job's bot, then its `until` checks, sending failing findings back as new attempts in the same worktree.
 * While it resolves a merge, conflict markers left in the conflicting files count as a failing check. The loop stops
 * at `until.max` follow-ups, or once the attempts and checks have spent the bot's `usd-per-run`. An `item` of a
 * fan-out adds its section to the prompt.
 */
const attempts = (
  planned: PlannedJob,
  workflow: Defined<Workflow>,
  first: Run,
  worktree: Worktree,
  handoff: Handoff,
  p: Pipeline,
  item?: { index: number; section: string | undefined }
) =>
  Effect.gen(function* () {
    const { cwd, base, merging } = worktree;
    const preloaded = yield* Effect.promise(() => preloadFor(planned, workflow, p));
    const built = buildSpec({
      ...planned,
      config: p.config,
      workflow,
      event: p.event,
      cwd,
      preloaded,
      handoff,
      ...(p.mcp && { mcp: p.mcp }),
      ...(p.hub && { hub: p.hub }),
      ...(p.data && { data: p.data }),
    });
    const { bot, job, returns, branch, into, timeoutMinutes } = built;
    const target: Target = { ...(branch && { branch }), ...(into && { into }) };
    const kinds = returnKinds(returns);
    const defaultBranch = yield* Effect.promise(() => defaultBranchFor(kinds, p));
    const env = handoffEnv(handoff);
    const max = job.until?.max ?? 1;
    const cap = bot.budget?.['usd-per-run'];
    let spent = 0;
    let parent = first;
    const task = [built.spec.prompt, item?.section, merging ? conflictSection(worktree.conflicts) : undefined]
      .filter(Boolean)
      .join('\n\n');
    let prompt = task;
    for (let attempt = 1; ; attempt++) {
      const current =
        attempt === 1
          ? first
          : yield* Effect.promise(() =>
              p.store.create({
                ...planned,
                bot: bot.name,
                harness: bot.harness,
                event: p.event,
                parent: parent.id,
                attempt,
              })
            );
      const { run, final } = yield* agent(bot, { ...built.spec, prompt }, timeoutMinutes, current, p, env);
      spent += run.costUsd ?? 0;
      const extracted = yield* Effect.promise(() => withTools(extractProposals(final), run, p));
      const allowance = { returns, paths: job.paths, ...target, ...(defaultBranch && { defaultBranch }) };
      const validated = validate(extracted.proposals, allowance, job.mode);
      const a: Attempt = {
        planned,
        job,
        worktree: worktree.id,
        cwd,
        base,
        parent: run,
        handoff,
        target,
        ...(item && { item: item.index }),
        ...(merging && { merging }),
      };
      const succeeded = run.status === 'succeeded';
      const problems = succeeded ? proposalProblems(extracted, validated, kinds) : [];
      if (problems.length) {
        const error = problems.join('; ');
        if (attempt > max) {
          const failed = yield* Effect.promise(() =>
            p.store.update(run.id, {
              status: 'failed',
              error: `no usable proposals after ${attempt} attempts: ${error}`,
            })
          );
          const outcome = yield* Effect.promise(() => settle(failed, extracted, validated, undefined, a, p));
          return yield* finish(planned, failed, outcome, kinds, p, merging);
        }
        const failed = yield* Effect.promise(() => p.store.update(run.id, { status: 'failed', error }));
        yield* Effect.promise(() => settle(failed, extracted, validated, undefined, a, p));
        const earlier =
          bot.session?.resume === 'attempts' ? yield* Effect.promise(() => attemptSummary(run, p)) : undefined;
        prompt = followUp(task, [], [], attempt + 1, max + 1, problems, earlier);
        parent = failed;
        continue;
      }
      const left = succeeded && merging ? yield* Effect.promise(() => unresolved(cwd, worktree.conflicts)) : [];
      if (!succeeded || (!job.until && !left.length)) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, succeeded ? validated.accepted : undefined, a, p)
        );
        return yield* finish(planned, run, outcome, kinds, p, merging);
      }

      const checks: Verdict[] = [];
      for (const name of job.until?.checks ?? []) {
        const check = p.config.checks[name];
        checks.push(
          check ? yield* runCheck(check, a, p) : { check: name, gating: true, pass: false, findings: 'unknown check' }
        );
      }
      spent += yield* Effect.promise(() =>
        costOf(
          checks.flatMap(v => v.runs ?? []),
          p.store
        )
      );
      const failing = failingChecks(checks);
      const verdicts = job.until ? checks : undefined;
      if (!failing.length && !left.length) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, validated.accepted, a, p, verdicts)
        );
        return yield* finish(planned, run, outcome, kinds, p, merging);
      }

      const broke = cap !== undefined && spent >= cap;
      if (attempt > max || broke) {
        const what = [failing.length && 'checks still failing', left.length && 'merge conflicts left'].filter(Boolean);
        const reason = broke
          ? `spent $${spent.toFixed(2)} of the $${cap} budget in ${attempt} attempts with ${what.join(' and ')}`
          : `${what.join(' and ')} after ${attempt} attempts`;
        const ask: Proposal = {
          kind: 'ask',
          question: `${reason}: ${[...failing.map(v => v.check), ...left].join(', ')}. The findings are in run ${run.id}.`,
        };
        const asks = [...validated.accepted.filter(proposal => proposal.kind === 'ask'), ask];
        const held = validated.accepted
          .filter(proposal => proposal.kind !== 'ask')
          .map(proposal => ({ proposal, reason }));
        const failed = yield* Effect.promise(() => p.store.update(run.id, { status: 'failed', error: reason }));
        const outcome = yield* Effect.promise(() =>
          settle(
            failed,
            { ...extracted, proposals: [...extracted.proposals, ask] },
            { ...validated, accepted: asks, rejected: [...validated.rejected, ...held] },
            asks,
            a,
            p,
            verdicts
          )
        );
        return yield* finish(planned, failed, outcome, kinds, p, merging);
      }

      yield* Effect.promise(() => settle(run, extracted, validated, undefined, a, p, verdicts));
      const earlier =
        bot.session?.resume === 'attempts' ? yield* Effect.promise(() => attemptSummary(run, p)) : undefined;
      prompt = followUp(task, failing, validated.rejected, attempt + 1, max + 1, [], earlier, left);
      parent = run;
    }
  });

/**
 * Where a job's change starts: for a handed-off branch, where it forked from the event's ref or the default branch;
 * for a pull request, where it forked from its base branch; otherwise the commit the worktree started from.
 */
const changeStart = (worktree: Worktree, handoff: Handoff, p: Pipeline) => {
  const { ref, branch, repo } = p.event;
  const from = handoff.branch ? (ref ?? '') : branch && ref !== `refs/heads/${branch}` ? branch : undefined;
  if (from === undefined) return Promise.resolve(worktree.base);
  return p.workspaces.forkPoint(repo, worktree.id, from || undefined).catch(() => worktree.base);
};

/** The items a job's `over` names, from its change limited to its `paths`, and the scope to run scripts on them in. */
const jobItems = async (job: Job, worktree: Worktree, handoff: Handoff, p: Pipeline) => {
  const since = await changeStart(worktree, handoff, p);
  const { paths } = job;
  const changed = paths ? (await p.workspaces.changes(worktree.id, since)).files : [];
  const scope: Scope = {
    worktree: worktree.id,
    cwd: worktree.cwd,
    since,
    files: changed.filter(file => paths?.some(glob => matchGlob(glob, file))),
    timeout: job['timeout-minutes'] ?? defaultMinutes,
    env: { ...handoffEnv(handoff), BOTHUB_BASE: worktree.base },
  };
  if (paths && !scope.files.length) return { items: [], scope };
  return { ...(await gather(job.over, scope, p)), scope };
};

/**
 * Runs a bot job once, or once per item its `over` names, each item as its own chain of attempts in the same
 * worktree. Stops at the first item that does not close done or handed off.
 */
const fanned = (
  planned: PlannedJob,
  workflow: Defined<Workflow>,
  job: Extract<Job, { type: 'bot' }>,
  first: Run,
  worktree: Worktree,
  handoff: Handoff,
  p: Pipeline
) =>
  Effect.gen(function* () {
    if (job.over === 'event') return yield* attempts(planned, workflow, first, worktree, handoff, p);
    const { items, error } = yield* Effect.promise(() => jobItems(job, worktree, handoff, p));
    if (error || !items.length) {
      const patch: Partial<Run> = error
        ? { status: 'failed', error, ...closed('blocked', error) }
        : { status: 'skipped', ...closed('no-op', 'nothing to look at') };
      const run = yield* Effect.promise(() => p.store.update(first.id, patch));
      return { ...planned, run } satisfies JobResult;
    }
    let result: JobResult | undefined;
    for (const [index, item] of items.entries()) {
      const run =
        index === 0
          ? first
          : yield* Effect.promise(() =>
              p.store.create({
                workflow: planned.workflow,
                job: planned.job,
                bot: job.bot,
                ...(first.harness && { harness: first.harness }),
                event: p.event,
                parent: first.id,
                ...(job.until && { attempt: 1 }),
              })
            );
      const section = itemSection(job.over, item);
      result = yield* attempts(planned, workflow, run, worktree, handoff, p, { index, section });
      if (!proceeds(closureOfResult(result))) return result;
    }
    return result as JobResult;
  });

/**
 * The open requests from `bothub/` branches into a merging job's `into`, as `BOTHUB_INTO`, `BOTHUB_REQUESTS` and
 * `BOTHUB_DEFAULT_BRANCH`.
 */
const requestsEnv = async (kinds: ProposalKind[], target: Target, p: Pipeline): Promise<Record<string, string>> => {
  const pulls = pullsOf(p);
  if (!kinds.includes('merge') || !pulls) return {};
  const defaultBranch = await pulls.defaultBranch();
  const into = target.into ?? defaultBranch;
  const open = (await pulls.list({ into })).filter(pull => pull.branch.startsWith('bothub/'));
  const requests = open.map(({ number, branch, title, url }) => ({ number, branch, into, title, url }));
  return { BOTHUB_INTO: into, BOTHUB_REQUESTS: JSON.stringify(requests), BOTHUB_DEFAULT_BRANCH: defaultBranch };
};

/**
 * Runs a script job: once, or once per item its `over` names with the item in `BOTHUB_ITEM` and on stdin. It fails
 * when any run fails; the output of every run is stored on the job's run. A script that may return proposals ends
 * its output with a `bothub` block, validated and applied like a bot's; a script that may merge also gets the open
 * requests into its `into` from `requestsEnv`.
 */
const scriptJob = (
  planned: PlannedJob,
  job: Extract<Job, { type: 'script' }>,
  handoff: Handoff,
  target: Target,
  p: Pipeline
) =>
  Effect.gen(function* () {
    const { store, event } = p;
    const created = yield* Effect.promise(() => store.create({ workflow: planned.workflow, job: planned.job, event }));
    const timeout = job['timeout-minutes'] ?? defaultMinutes;
    const returns = job.returns ?? [];
    const kinds = returnKinds(returns);
    const once = (cwd: string, env: Record<string, string>) => runScript(job.run, cwd, timeout, env, p.launch, p.hub);
    const each = async (worktree: Worktree) => {
      const { items, error, scope } = await jobItems(job, worktree, handoff, p);
      if (error) return { ok: false, output: error, stdout: '' };
      const outputs: string[] = [];
      let stdout = '';
      let ok = true;
      for (const item of items) {
        const result = await runOnItem(job.run, item, scope, p);
        ok &&= result.ok;
        stdout += result.stdout;
        if (result.output) outputs.push(items.length > 1 ? `${item.label}:\n${result.output}` : result.output);
      }
      return { ok, output: outputs.join('\n\n'), stdout };
    };
    const execute = (worktree: Worktree) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          store.update(created.id, { status: 'running', startedAt: new Date().toISOString() })
        );
        const env = {
          ...handoffEnv(handoff),
          BOTHUB_BASE: worktree.base,
          ...(yield* Effect.promise(() => requestsEnv(kinds, target, p))),
        };
        const { ok, output, stdout } = yield* Effect.promise(() =>
          fanOut(job.over) ? each(worktree) : once(worktree.cwd, env)
        );
        const ts = new Date().toISOString();
        yield* Effect.promise(async () => {
          if (output) await store.append(created.id, { ts, seq: 0, event: { type: 'text', text: output } });
          await store.append(created.id, { ts, seq: output ? 1 : 0, event: { type: 'end', ok } });
        });
        const why = output.startsWith('sandbox-failed: ') ? output : 'the script exited non-zero';
        if (!ok || !kinds.length) {
          const run = yield* Effect.promise(() =>
            store.update(created.id, {
              status: ok ? 'succeeded' : 'failed',
              ...(ok ? closed('done') : { error: why, ...closed('blocked', why) }),
              endedAt: ts,
            })
          );
          yield* Effect.promise(() => remember(run, undefined, p));
          return { ...planned, run } satisfies JobResult;
        }
        const extracted = extractProposals(stdout);
        const defaultBranch = yield* Effect.promise(() => defaultBranchFor(kinds, p));
        const allowance = { returns, paths: job.paths, ...target, ...(defaultBranch && { defaultBranch }) };
        const validated = validate(extracted.proposals, allowance, job.mode);
        const said = extracted.proposals.length || extracted.errors.length;
        const problems = said ? proposalProblems(extracted, validated, kinds) : [];
        const run = yield* Effect.promise(() =>
          store.update(created.id, {
            status: problems.length ? 'failed' : 'succeeded',
            ...(problems.length && { error: problems.join('; ') }),
            endedAt: ts,
          })
        );
        const a: Attempt = {
          planned,
          job,
          worktree: worktree.id,
          cwd: worktree.cwd,
          base: worktree.base,
          parent: run,
          handoff,
          target,
        };
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, problems.length ? undefined : validated.accepted, a, p)
        );
        return yield* finish(planned, run, outcome, kinds, p);
      });
    return yield* withWorktree(created, execute, handoff, p, { target, lock: lockOf(target, returns) });
  });

/** The branch a job locks while it runs: its own, or the `into` it merges into. */
const lockOf = (target: Target, returns: Return[]) =>
  target.branch ?? (returnKinds(returns).includes('merge') ? target.into : undefined);

/**
 * Runs `use` in a fresh worktree for `created`, at the job's branch when it exists, otherwise the handed-off branch or
 * the event's ref, holding the lock on `lock`. With `merge`, that branch is merged in for the job to resolve. The
 * commit the worktree starts from is stored as the run's `base`; the worktree is always removed. A branch another
 * live run holds defers the job.
 */
const withWorktree = (
  created: Run,
  use: (worktree: Worktree) => Effect.Effect<JobResult>,
  handoff: Handoff,
  p: Pipeline,
  { target, lock, merge }: { target: Target; lock: string | undefined; merge?: string }
): Effect.Effect<JobResult> => {
  const planned: PlannedJob = {
    workflow: created.workflow,
    job: created.job,
    ...(created.bot && { bot: created.bot }),
  };
  const ref = handoff.branch ?? p.event.ref;
  const fail = (error: string) =>
    Effect.promise(async (): Promise<JobResult> => {
      const run = await p.store.update(created.id, {
        status: 'failed',
        error,
        ...closed('blocked', error),
        endedAt: new Date().toISOString(),
      });
      return { ...planned, run };
    });
  const start = {
    repo: p.event.repo,
    ...(ref && { ref }),
    ...(target.branch && { branch: target.branch }),
    ...(merge && { merge }),
  };
  return Effect.acquireUseRelease(
    Effect.promise(() =>
      lock ? p.store.lock(`${p.event.repo}:${lock}`, created.id) : Promise.resolve({ release: async () => {} })
    ),
    held =>
      'holder' in held
        ? Effect.promise(async (): Promise<JobResult> => {
            const reason = `branch "${lock}" is in use by run ${held.holder}`;
            const run = await p.store.update(created.id, { status: 'skipped', ...closed('deferred', reason) });
            return { ...planned, run };
          })
        : Effect.acquireUseRelease(
            Effect.tryPromise(async (): Promise<Worktree> => {
              const worktree = await p.workspaces.create(start, created.id);
              await p.store.update(created.id, { base: worktree.base });
              const { path: cwd, base, conflicts } = worktree;
              return { id: created.id, cwd, base, conflicts, merging: merge !== undefined };
            }),
            use,
            () => Effect.promise(() => p.workspaces.remove(p.event.repo, created.id))
          ).pipe(Effect.catchAll(e => fail(e.error instanceof Error ? e.error.message : String(e.error)))),
    held => Effect.promise(() => ('release' in held ? held.release() : Promise.resolve()))
  );
};

/**
 * Runs one planned job in a fresh worktree: a script, or a bot running its skill until the job's checks pass.
 * Proposals are validated and applied only once the checks pass and the mode and a GitHub client allow it. Every
 * attempt is stored as its own run, linked to the one before by `parent`; the worktree is always removed. A job
 * that needs another starts from the branch handed to it, which scripts and harnesses also get as `handoffEnv`. With
 * `merge`, the job runs again on its branch with that branch merged in, to resolve the conflicts. A `branch` or
 * `into` naming a value the event does not have blocks the job.
 */
export const runPlanned = (
  planned: PlannedJob,
  p: Pipeline,
  handoff: Handoff = {},
  merge?: string
): Effect.Effect<JobResult> =>
  Effect.gen(function* () {
    const workflow = p.config.workflows[planned.workflow];
    const job = workflow?.jobs[planned.job];
    if (!workflow || !job) return yield* Effect.promise(() => skip(planned, 'the job is not in the config', p));
    const target = targetOf(
      job,
      { event: p.event, args: planned.args, job: planned.job, workflow: workflow.name },
      handoff
    );
    const unfilled = [target.branch, target.into].find(name => name?.includes('{'));
    if (unfilled)
      return yield* Effect.promise(() =>
        skip(planned, `"${unfilled}" names a value this event does not have`, p, 'blocked')
      );
    if (job.type === 'script') return yield* scriptJob(planned, job, handoff, target, p);
    const bot = p.config.bots[job.bot];
    if (!bot) return yield* Effect.promise(() => skip(planned, 'the job has no bot', p));
    const created = yield* Effect.promise(() =>
      p.store.create({
        workflow: planned.workflow,
        job: planned.job,
        bot: bot.name,
        harness: bot.harness,
        event: p.event,
        ...(job.until && { attempt: 1 }),
      })
    );
    return yield* withWorktree(
      created,
      worktree => fanned(planned, workflow, job, created, worktree, handoff, p),
      handoff,
      p,
      { target, lock: lockOf(target, effectiveReturns(bot, job)), ...(merge && { merge }) }
    );
  });

const proceeds = (closure: Closure | undefined) => closure === 'done' || closure === 'handed-off';

const closureOfResult = (result: JobResult) => ('skipped' in result ? result.closure : result.run.closure);

/** The latest run of this event's job that already closed done or handed off, so a retry does not redo it. */
const reuse = async (planned: PlannedJob, earlier: Run[], p: Pipeline): Promise<JobResult | undefined> => {
  const run = earlier.find(
    r =>
      r.event.id === p.event.id &&
      r.workflow === planned.workflow &&
      r.job === planned.job &&
      !r.check &&
      r.status === 'succeeded' &&
      proceeds(r.closure)
  );
  if (!run) return;
  const outcome = await p.store.outcome(run.id);
  return { ...planned, run, ...(outcome && { outcome }) };
};

/**
 * Holds a job with an `environment` until a human approves it: an `unsure` issue under the event's issue asks for the
 * `approved` label. Resolves to the blocked result, or to nothing once approved.
 */
const gate = async (planned: PlannedJob, job: Job, p: Pipeline): Promise<JobResult | undefined> => {
  const { environment } = job;
  if (!environment) return;
  const issues = issuesOf(p);
  if (!issues)
    return skip(planned, `environment "${environment}" needs an issue tracker to ask for approval`, p, 'blocked');
  const { number: parent, actor, repo, url } = p.event;
  const title = `Approve ${planned.workflow}/${planned.job}${parent !== undefined ? ` for #${parent}` : ''} in ${environment}`;
  const scope = { label: roles.unsure, state: 'all', ...(parent !== undefined && { parent }) } as const;
  const asked = (await issues.list(scope)).find(issue => issue.title === title);
  if (asked?.labels.includes(approved)) {
    const waiting = (await p.store.list()).filter(
      r => r.event.id === p.event.id && r.job === planned.job && r.closure === 'blocked' && r.approval === asked.number
    );
    for (const run of waiting) await p.store.update(run.id, closed('done', `approved in #${asked.number}`));
    return;
  }
  const issue =
    asked ??
    (await issues.create({
      title,
      body: `Add the label \`${approved}\` to let ${planned.workflow}/${planned.job} run in \`${environment}\` for ${url ?? repo}.`,
      labels: [roles.unsure],
      ...(parent !== undefined && { parent }),
    }));
  if (!asked && parent !== undefined) await issues.comment(parent, `@${actor.login} needs a human: #${issue.number}`);
  return skip(planned, `waiting for approval in #${issue.number}`, p, 'blocked', { approval: issue.number });
};

/**
 * The events to run again because a trusted human approved a job they hold: `issues` `labeled` on an approval issue
 * that now carries the `approved` label, with a blocked job waiting on it. Planning and running such an event again reuses the jobs that already closed.
 */
export const approvals = async (event: BotEvent, store: Store, issues: Issues): Promise<BotEvent[]> => {
  if (event.trigger !== 'issues' || event.action !== 'labeled' || event.number === undefined) return [];
  if (!isTrusted(event.actor.association)) return [];
  if (!(await issues.get(event.number))?.labels.includes(approved)) return [];
  const waiting = (await store.list()).filter(
    run =>
      run.status === 'skipped' &&
      run.closure === 'blocked' &&
      run.approval === event.number &&
      run.event.repo === event.repo
  );
  return [...new Map(waiting.map(run => [run.event.id, run.event])).values()];
};

/**
 * Runs planned jobs workflow by workflow, each in dependency order. A job starts only when every job it needs closed
 * `done` or `handed-off`, and starts from the branch and pull request they handed off. A job of this event that
 * already closed that way is reused rather than run again, and a job with an `environment` waits for approval.
 */
/** The pipeline with the event's parent issue filled in, when a planned job's `branch` or `into` names it. */
const withParent = async (planned: PlannedJob[], p: Pipeline): Promise<Pipeline> => {
  const { event } = p;
  const named = planned.some(({ workflow, job }) => {
    const definition = p.config.workflows[workflow]?.jobs[job];
    return [definition?.branch, definition?.into].some(name => name?.includes('{parent}'));
  });
  if (!named || event.parent !== undefined || event.number === undefined) return p;
  const parent = (await issuesOf(p)?.get(event.number))?.parent;
  return parent === undefined ? p : { ...p, event: { ...event, parent } };
};

export const runPlan = (planned: PlannedJob[], pipeline: Pipeline): Effect.Effect<JobResult[]> =>
  Effect.flatMap(
    Effect.promise(() => withParent(planned, pipeline)),
    p => runWorkflows(planned, p)
  );

const runWorkflows = (planned: PlannedJob[], p: Pipeline): Effect.Effect<JobResult[]> =>
  Effect.forEach(
    [...new Set(planned.map(j => j.workflow))],
    name =>
      Effect.gen(function* () {
        const workflow = p.config.workflows[name];
        const earlier = yield* Effect.promise(() => p.store.list());
        const results: JobResult[] = [];
        const closures = new Map<string, Closure | undefined>();
        const handoffs = new Map<string, Handoff>();
        for (const id of workflow ? jobOrder(workflow) : []) {
          const job = planned.find(j => j.workflow === name && j.job === id);
          const definition = workflow?.jobs[id];
          if (!job || !definition) continue;
          const blocked = definition.needs.filter(need => !proceeds(closures.get(need)));
          const handoff: Handoff = Object.assign({}, ...definition.needs.map(need => handoffs.get(need)));
          const reason = `needs ${blocked.map(need => `"${need}" (${closures.get(need) ?? 'not run'})`).join(', ')} to be done`;
          const result = blocked.length
            ? yield* Effect.promise(() => skip(job, reason, p))
            : ((yield* Effect.promise(() => reuse(job, earlier, p))) ??
              (yield* Effect.promise(() => gate(job, definition, p))) ??
              (yield* runPlanned(job, p, handoff)));
          closures.set(id, closureOfResult(result));
          const own: Handoff = ('outcome' in result && result.outcome) || {};
          handoffs.set(id, {
            ...handoff,
            ...(own.branch && { branch: own.branch }),
            ...(own.pr !== undefined && { pr: own.pr }),
          });
          results.push(result);
        }
        return results;
      }),
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(results => results.flat()));
