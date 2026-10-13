import { Effect } from 'effect';
import { apply, type ApplyResult } from './apply.ts';
import {
  effectiveCan,
  effectivePreload,
  effectiveTools,
  harnessTools,
  jobOrder,
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
import { mcpToolNames, type McpServer } from './mcp-config.ts';
import { writeMemory } from './memory.ts';
import {
  approved,
  extractProposals,
  matchGlob,
  validate,
  type Proposal,
  type Rejection,
  type Validated,
} from './outputs.ts';
import { issueContext, relevantNotes, renderNotes } from './preload.ts';
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
  type Skill,
  type Workflow,
} from './schema.ts';
import type { EventRecord, Outcome, Run, Store, Verdict } from './store.ts';
import type { BotEvent, HarnessAdapter, RunSpec } from './types.ts';
import type { Workspaces } from './workspace.ts';

const defaultMinutes = 30;

const examples: Record<ProposalKind, string> = {
  reply: '{ "kind": "reply", "body": "Markdown comment on the issue or pull request" }',
  label: '{ "kind": "label", "add": ["bug"], "remove": ["needs-triage"] }',
  push: '{ "kind": "push", "branch": "<branch>", "files": ["src/changed.ts"] }',
  'open-pr':
    '{ "kind": "open-pr", "title": "…", "body": "Closes #<issue>", "head": "<branch>", "base": "main", "draft": true }',
  note: '{ "kind": "note", "note": "pattern", "slug": "short-kebab-name", "title": "…", "body": "The note, in Markdown" }',
  ask: '{ "kind": "ask", "question": "What should happen when …?" }',
};

const proposing = (kinds: ProposalKind[], branch: string | undefined) => {
  const has = (kind: ProposalKind) => kinds.includes(kind);
  const pushes = has('push') || has('open-pr');
  const notes = [
    pushes && (branch ? `Use the branch \`${branch}\`.` : 'Branches must start with `bothub/`.'),
    has('push') && '`files` lists every file you changed, as repository-relative paths.',
    has('open-pr') && 'Leave out `base` to target the default branch.',
    has('note') && `A note's kind is one of ${NoteKind.options.join(', ')}.`,
    has('ask') && 'An `ask` opens an issue labelled `unsure` for a human; stop after asking.',
    'When you stop without finishing, add `{ "kind": "close", "as": "blocked", "reason": "…" }` with `as` one of blocked, deferred or no-op.',
    'Include only the proposals you need.',
  ].filter(Boolean);
  const example = (kind: ProposalKind) => examples[kind].replaceAll('<branch>', branch ?? 'bothub/<issue>-<slug>');
  return [
    '## Proposing changes',
    '',
    'You cannot write to GitHub yourself. To post a comment, label, push, open a pull request, add a note or ask a',
    'human, end your final message with one fenced block tagged `bothub` that holds a JSON array of proposals.',
    'Only the last such block counts. Anything the job does not allow is rejected.',
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

const toolDescriptions: Record<HubTool, string> = {
  issues_list: 'list issues, filtered by label (plan, spec, unsure), state or parent',
  issues_get: 'read one issue with its comments',
  notes_search: 'search the hub notes, including patterns and caveats not loaded here',
  notes_get: 'read one note',
  runs_read: 'list past runs or read one run transcript',
};

const offeredTools = (tools: HubTool[]) =>
  tools.length
    ? [
        '## Hub tools',
        'Read-only tools from the `bothub` server. Writes still go through proposals.',
        tools.map(tool => `- ${tool}: ${toolDescriptions[tool]}`).join('\n'),
      ].join('\n\n')
    : undefined;

/**
 * A bot's session for a skill. The system prompt holds, in order, the role, the relevant notes (when `notes` is
 * preloaded), the `pinned` sections (the forced skill and the task), the offered skills, the hub tools and the
 * proposal format for `can`. Hub tools are served by `mcp` when one is given.
 */
const session = ({
  config,
  bot,
  skill,
  can,
  branch,
  prompt,
  cwd,
  paths,
  preload = ['notes'],
  tools = [],
  mcp,
  pinned = [],
}: {
  config: Config;
  bot: Defined<Bot>;
  skill?: Defined<Skill> | undefined;
  can: ProposalKind[];
  branch: string | undefined;
  prompt: string;
  cwd: string;
  paths?: string[] | undefined;
  preload?: Preload[];
  tools?: HubTool[];
  mcp?: ((tools: HubTool[]) => McpServer) | undefined;
  pinned?: (string | undefined)[];
}): RunSpec => {
  const kinds = [...(bot.notes ?? []), ...(skill?.notes ?? [])];
  const notes = preload.includes('notes') ? renderNotes(relevantNotes(config.notes, { kinds, paths })) : undefined;
  const served = mcp && tools.length ? tools : [];
  return {
    prompt,
    system: [
      bot.body,
      notes,
      ...pinned,
      offered(config, bot),
      offeredTools(served),
      can.length ? proposing(can, branch) : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
    cwd,
    ...(bot.model && { model: bot.model }),
    tools: [...harnessTools(bot), ...mcpToolNames(bot.harness, served)],
    ...(bot['max-turns'] && { maxTurns: bot['max-turns'] }),
    ...(mcp && served.length && { mcp: mcp(served) }),
  };
};

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');

/** Fills a job's `branch` template: `{issue}`, `{slug}` (from the command or event text), `{job}` and `{workflow}`. */
export const renderBranch = (
  template: string,
  { event, args, job, workflow }: { event: BotEvent; args: string | undefined; job: string; workflow: string }
) => {
  const values: Record<string, string> = {
    issue: String(event.number ?? 'new'),
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

/** The branch a job works on: its own `branch` template, or the branch handed to it. */
const branchFor = (job: Job, at: Parameters<typeof renderBranch>[1], from?: Handoff) =>
  job.type === 'bot' && job.branch ? renderBranch(job.branch, at) : from?.branch;

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
  mcp,
  handoff,
}: Pick<PlannedJob, 'job' | 'args'> &
  Pick<Pipeline, 'mcp'> & {
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
  const can = effectiveCan(bot, job);
  const branch = branchFor(job, { event, args, job: id, workflow: workflow.name }, handoff);
  const prompt = eventContext(event, args, branch, handoff?.pr);
  const preload = effectivePreload(bot, job);
  const tools = effectiveTools(bot, job);
  return {
    spec: session({
      config,
      bot,
      skill,
      can,
      branch,
      prompt,
      cwd,
      paths: job.paths,
      preload,
      tools,
      mcp,
      pinned: [`## Skill: ${skill.name}\n\n${skill.body}`, preloaded],
    }),
    bot,
    job,
    can,
    branch,
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
 * Everything a planned job needs to run. Without `gh` or `issues`, nothing is applied; without `gh`, pull requests
 * are skipped; without `hubPr`, notes are skipped. Scripts see the `hub` directory read-only as `BOTHUB_HUB` and the
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
  mcp?: (tools: HubTool[]) => McpServer;
  hub?: string;
  hubPr?: Parameters<typeof apply>[1]['hubPr'];
  adapters?: Record<Harness, HarnessAdapter>;
  launch?: Launcher;
  onEvent?: (run: Run, record: EventRecord) => void;
};

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
        spec,
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

type Attempt = {
  planned: PlannedJob;
  job: Extract<Job, { type: 'bot' }>;
  worktree: string;
  cwd: string;
  base: string;
  parent: Run;
  handoff: Handoff;
  item?: number;
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
        skill,
        can: ['reply'],
        branch: undefined,
        prompt,
        cwd: a.cwd,
        paths: check.paths,
        tools: effectiveTools(bot, {}),
        mcp: p.mcp,
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

const followUp = (
  prompt: string,
  failing: Verdict[],
  rejected: Rejection[],
  attempt: number,
  total: number,
  problems: string[] = []
) =>
  [
    prompt,
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
 * question is `blocked`, a pull request `handed-off`, any other write `done`. A push without a pull request is
 * `handed-off` when a later job needs this one, otherwise `blocked`. A job that may push but
 * changed nothing, or one that wrote nothing at all, is `no-op`. A skipped run, a provider limit or a sandbox that
 * never started is `deferred`;
 * any other failure, or an effect that failed to apply, is `blocked`.
 */
export const closureOf = (run: Run, outcome: Outcome | undefined, can: ProposalKind[], taken = false) => {
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
  if (kinds.includes('open-pr')) return closed('handed-off');
  if (kinds.includes('push'))
    return taken ? closed('handed-off') : closed('blocked', 'pushed a branch without opening a pull request');
  if (can.includes('push')) return closed('no-op', 'proposed no change');
  return kinds.length ? closed('done') : closed('no-op', 'proposed nothing');
};

const pullNumber = (url: string | undefined) => Number(url?.match(/\/(\d+)$/)?.[1]) || undefined;

/** The branch that landed and the pull request that is open after applying. */
const handoffOf = (applied: Proposal[], results: ApplyResult[]): Handoff => {
  const landed = (kind: Proposal['kind']) => results.find(r => r.kind === kind && r.status === 'applied');
  const push = applied.find((proposal): proposal is Extract<Proposal, { kind: 'push' }> => proposal.kind === 'push');
  const pr = applied.find(
    (proposal): proposal is Extract<Proposal, { kind: 'open-pr' }> => proposal.kind === 'open-pr'
  );
  const opened = landed('open-pr');
  const branch = push && landed('push') ? push.branch : pr && opened ? pr.head : undefined;
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
  const applied = toApply !== undefined && allowed && (gh !== undefined || issues !== undefined);
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
    prefix: `${event.id}/${run.workflow}/${run.job}${a.item ? `/item-${a.item + 1}` : ''}`,
    prior: await priorEffects(run, p),
    record: results => p.store.saveOutcome(run.id, { ...base, results }),
    ...(gh && { gh }),
    ...(issues && { issues }),
    ...(hubPr && { hubPr }),
  });
  return p.store.saveOutcome(run.id, { ...base, results, ...handoffOf(writes, results) });
};

/** Records the closure of a job's final run. */
/** Saves the memory of a job's final run; a memory that cannot be written never fails the job. */
const remember = async (run: Run, outcome: Outcome | undefined, p: Pipeline) => {
  try {
    await writeMemory(p.store, run, await p.store.events(run.id), outcome);
  } catch {}
};

const finish = (planned: PlannedJob, run: Run, outcome: Outcome | undefined, can: ProposalKind[], p: Pipeline) =>
  Effect.promise(async (): Promise<JobResult> => {
    const jobs = Object.values(p.config.workflows[planned.workflow]?.jobs ?? {});
    const taken = jobs.some(job => job.needs.includes(planned.job));
    const final = await p.store.update(run.id, closureOf(run, outcome, can, taken));
    await remember(final, outcome, p);
    return { ...planned, run: final, ...(outcome && { outcome }) };
  });

/** The issue context a planned job preloads, read from `issues`, or GitHub's issues when only `gh` is given. */
const preloadFor = async (planned: PlannedJob, workflow: Defined<Workflow>, p: Pipeline) => {
  const job = workflow.jobs[planned.job];
  const bot = job?.type === 'bot' ? p.config.bots[job.bot] : undefined;
  if (job?.type !== 'bot' || !bot) return;
  return issueContext(p.issues ?? (p.gh && githubIssues(p.gh, p.event.repo)), p.event, effectivePreload(bot, job));
};

/**
 * Why a finished run's reply cannot be acted on, for a job that may propose something: its proposal block did not
 * parse, every proposal was rejected, or it proposed nothing at all.
 */
export const proposalProblems = (
  extracted: ReturnType<typeof extractProposals>,
  validated: Validated,
  can: ProposalKind[]
): string[] => {
  if (!can.length) return [];
  if (extracted.errors.length) return extracted.errors;
  if (validated.rejected.length && !validated.accepted.length)
    return validated.rejected.map(({ proposal, reason }) => `\`${proposal.kind}\` was rejected: ${reason}`);
  if (!extracted.proposals.length)
    return [
      'the reply has no bothub block; end with your proposals, or a `close` proposal when there is nothing to do',
    ];
  return [];
};

const costOf = async (ids: string[], store: Store) =>
  (await Promise.all(ids.map(id => store.read(id)))).reduce((sum, run) => sum + (run?.costUsd ?? 0), 0);

/** A run's worktree: the run that owns it, its path and the commit it started from. */
type Worktree = { id: string; cwd: string; base: string };

/**
 * Runs the job's bot, then its `until` checks, sending failing findings back as new attempts in the same worktree.
 * The loop stops at `until.max` follow-ups, or once the attempts and checks have spent the bot's `usd-per-run`. An
 * `item` of a fan-out adds its section to the prompt.
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
    const { cwd, base } = worktree;
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
    });
    const { bot, job, can, branch, timeoutMinutes } = built;
    const env = handoffEnv(handoff);
    const max = job.until?.max ?? 1;
    const cap = bot.budget?.['usd-per-run'];
    let spent = 0;
    let parent = first;
    const task = [built.spec.prompt, item?.section].filter(Boolean).join('\n\n');
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
      const extracted = extractProposals(final);
      const validated = validate(extracted.proposals, { can, paths: job.paths, branch }, job.mode);
      const a: Attempt = {
        planned,
        job,
        worktree: worktree.id,
        cwd,
        base,
        parent: run,
        handoff,
        ...(item && { item: item.index }),
      };
      const succeeded = run.status === 'succeeded';
      const problems = succeeded ? proposalProblems(extracted, validated, can) : [];
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
          return yield* finish(planned, failed, outcome, can, p);
        }
        const failed = yield* Effect.promise(() => p.store.update(run.id, { status: 'failed', error }));
        yield* Effect.promise(() => settle(failed, extracted, validated, undefined, a, p));
        prompt = followUp(task, [], [], attempt + 1, max + 1, problems);
        parent = failed;
        continue;
      }
      if (!succeeded || !job.until) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, succeeded ? validated.accepted : undefined, a, p)
        );
        return yield* finish(planned, run, outcome, can, p);
      }

      const checks: Verdict[] = [];
      for (const name of job.until.checks) {
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
      if (!failing.length) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, validated.accepted, a, p, checks)
        );
        return yield* finish(planned, run, outcome, can, p);
      }

      const broke = cap !== undefined && spent >= cap;
      if (attempt > max || broke) {
        const reason = broke
          ? `spent $${spent.toFixed(2)} of the $${cap} budget in ${attempt} attempts with checks still failing`
          : `checks still failing after ${attempt} attempts`;
        const ask: Proposal = {
          kind: 'ask',
          question: `${reason}: ${failing.map(v => v.check).join(', ')}. The findings are in run ${run.id}.`,
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
            checks
          )
        );
        return yield* finish(planned, failed, outcome, can, p);
      }

      yield* Effect.promise(() => settle(run, extracted, validated, undefined, a, p, checks));
      prompt = followUp(task, failing, validated.rejected, attempt + 1, max + 1);
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
 * Runs a script job: once, or once per item its `over` names with the item in `BOTHUB_ITEM` and on stdin. It fails
 * when any run fails; the output of every run is stored on the job's run.
 */
const scriptJob = (planned: PlannedJob, job: Extract<Job, { type: 'script' }>, handoff: Handoff, p: Pipeline) =>
  Effect.gen(function* () {
    const { store, event } = p;
    const created = yield* Effect.promise(() => store.create({ workflow: planned.workflow, job: planned.job, event }));
    const timeout = job['timeout-minutes'] ?? defaultMinutes;
    const once = (cwd: string, base: string) =>
      runScript(job.run, cwd, timeout, { ...handoffEnv(handoff), BOTHUB_BASE: base }, p.launch, p.hub);
    const each = async (worktree: Worktree) => {
      const { items, error, scope } = await jobItems(job, worktree, handoff, p);
      if (error) return { ok: false, output: error };
      const outputs: string[] = [];
      let ok = true;
      for (const item of items) {
        const result = await runOnItem(job.run, item, scope, p);
        ok &&= result.ok;
        if (result.output) outputs.push(items.length > 1 ? `${item.label}:\n${result.output}` : result.output);
      }
      return { ok, output: outputs.join('\n\n') };
    };
    const execute = ({ cwd, base }: { cwd: string; base: string }) =>
      Effect.promise(async (): Promise<JobResult> => {
        await store.update(created.id, { status: 'running', startedAt: new Date().toISOString() });
        const { ok, output } = fanOut(job.over) ? await each({ id: created.id, cwd, base }) : await once(cwd, base);
        const ts = new Date().toISOString();
        if (output) await store.append(created.id, { ts, seq: 0, event: { type: 'text', text: output } });
        await store.append(created.id, { ts, seq: output ? 1 : 0, event: { type: 'end', ok } });
        const why = output.startsWith('sandbox-failed: ') ? output : 'the script exited non-zero';
        const run = await store.update(created.id, {
          status: ok ? 'succeeded' : 'failed',
          ...(ok ? closed('done') : { error: why, ...closed('blocked', why) }),
          endedAt: ts,
        });
        await remember(run, undefined, p);
        return { ...planned, run };
      });
    return yield* withWorktree(created, execute, handoff, p);
  });

/**
 * Runs `use` in a fresh worktree for `created`, at the handed-off branch or the event's ref, holding the lock on the
 * branch the job works on. The commit the worktree starts from is stored as the run's `base`; the worktree is always
 * removed. A branch another live run holds defers the job.
 */
const withWorktree = (
  created: Run,
  use: (worktree: { cwd: string; base: string }) => Effect.Effect<JobResult>,
  handoff: Handoff,
  p: Pipeline,
  branch = handoff.branch
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
  const locked = Effect.acquireUseRelease(
    Effect.promise(() =>
      branch ? p.store.lock(`${p.event.repo}:${branch}`, created.id) : Promise.resolve({ release: async () => {} })
    ),
    held =>
      'holder' in held
        ? Effect.promise(async (): Promise<JobResult> => {
            const reason = `branch "${branch}" is in use by run ${held.holder}`;
            const run = await p.store.update(created.id, { status: 'skipped', ...closed('deferred', reason) });
            return { ...planned, run };
          })
        : Effect.acquireUseRelease(
            Effect.tryPromise(async () => {
              const worktree = await p.workspaces.create({ repo: p.event.repo, ...(ref && { ref }) }, created.id);
              await p.store.update(created.id, { base: worktree.base });
              return { cwd: worktree.path, base: worktree.base };
            }),
            use,
            () => Effect.promise(() => p.workspaces.remove(p.event.repo, created.id))
          ).pipe(Effect.catchAll(e => fail(e.error instanceof Error ? e.error.message : String(e.error)))),
    held => Effect.promise(() => ('release' in held ? held.release() : Promise.resolve()))
  );
  return locked;
};

/**
 * Runs one planned job in a fresh worktree: a script, or a bot running its skill until the job's checks pass.
 * Proposals are validated and applied only once the checks pass and the mode and a GitHub client allow it. Every
 * attempt is stored as its own run, linked to the one before by `parent`; the worktree is always removed. A job
 * that needs another starts from the branch handed to it, which scripts and harnesses also get as `handoffEnv`.
 */
export const runPlanned = (planned: PlannedJob, p: Pipeline, handoff: Handoff = {}): Effect.Effect<JobResult> =>
  Effect.gen(function* () {
    const workflow = p.config.workflows[planned.workflow];
    const job = workflow?.jobs[planned.job];
    if (!workflow || !job) return yield* Effect.promise(() => skip(planned, 'the job is not in the config', p));
    if (job.type === 'script') return yield* scriptJob(planned, job, handoff, p);
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
    const at = { event: p.event, args: planned.args, job: planned.job, workflow: workflow.name };
    return yield* withWorktree(
      created,
      worktree => fanned(planned, workflow, job, created, { id: created.id, ...worktree }, handoff, p),
      handoff,
      p,
      branchFor(job, at, handoff)
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
  const issues = p.issues ?? (p.gh && githubIssues(p.gh, p.event.repo));
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
export const runPlan = (planned: PlannedJob[], p: Pipeline): Effect.Effect<JobResult[]> =>
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
