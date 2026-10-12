import { Effect } from 'effect';
import { apply } from './apply.ts';
import {
  effectiveCan,
  effectivePreload,
  effectiveTools,
  harnessTools,
  jobOrder,
  type Config,
  type Defined,
} from './config.ts';
import type { PlannedJob } from './dispatch.ts';
import { executors } from './executors/index.ts';
import type { GitHub } from './github-app.ts';
import { githubIssues } from './issues-github.ts';
import type { Issues } from './issues.ts';
import { mcpToolNames, type McpServer } from './mcp-config.ts';
import { extractProposals, matchGlob, validate, type Proposal, type Validated } from './outputs.ts';
import { issueContext, relevantNotes, renderNotes } from './preload.ts';
import { runJob, runScript, type limiter } from './runner.ts';
import {
  NoteKind,
  type Preload,
  type Bot,
  type Check,
  type Executor,
  type HubTool,
  type Job,
  type ProposalKind,
  type Skill,
  type Workflow,
} from './schema.ts';
import type { EventRecord, Outcome, Run, Store, Verdict } from './store.ts';
import type { BotEvent, ExecutorAdapter, RunSpec } from './types.ts';
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

const eventContext = (event: BotEvent, args: string | undefined, branch: string | undefined) => {
  const facts = [
    `Repository: ${event.repo}`,
    event.number !== undefined && `Number: #${event.number}`,
    `Actor: @${event.actor.login} (${event.actor.association})`,
    event.url && `URL: ${event.url}`,
    `Trigger: ${event.trigger}${event.action ? ` (${event.action})` : ''}`,
    event.ref && `Ref: ${event.ref}`,
    branch && `Branch: ${branch}`,
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
 * A bot's session for a skill. The system prompt holds the role, offered skills, the relevant notes (when `notes` is
 * preloaded), the hub tools and the proposal format for `can`. Hub tools are served by `mcp` when one is given.
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
}: {
  config: Config;
  bot: Defined<Bot>;
  skill: Defined<Skill>;
  can: ProposalKind[];
  branch: string | undefined;
  prompt: string;
  cwd: string;
  paths?: string[] | undefined;
  preload?: Preload[];
  tools?: HubTool[];
  mcp?: ((tools: HubTool[]) => McpServer) | undefined;
}): RunSpec => {
  const kinds = [...(bot.notes ?? []), ...(skill.notes ?? [])];
  const notes = preload.includes('notes') ? renderNotes(relevantNotes(config.notes, { kinds, paths })) : undefined;
  const served = mcp && tools.length ? tools : [];
  return {
    prompt,
    system: [
      bot.body,
      offered(config, bot),
      notes,
      offeredTools(served),
      can.length ? proposing(can, branch) : undefined,
    ]
      .filter(Boolean)
      .join('\n\n'),
    cwd,
    ...(bot.model && { model: bot.model }),
    tools: [...harnessTools(bot), ...mcpToolNames(bot.harness, served)],
    maxTurns: bot['max-turns'],
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

/**
 * The agent session for a planned job: the bot's system prompt, and the forced skill's body plus the event and any
 * `preloaded` issue context as the prompt.
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
}: Pick<PlannedJob, 'job' | 'args'> &
  Pick<Pipeline, 'mcp'> & {
    config: Config;
    workflow: Defined<Workflow>;
    event: BotEvent;
    cwd: string;
    preloaded?: string | undefined;
  }) => {
  const job = workflow.jobs[id];
  if (!job) throw new Error(`workflow "${workflow.name}" has no job "${id}"`);
  const bot = job.bot ? config.bots[job.bot] : undefined;
  const skill = job.skill ? config.skills[job.skill] : undefined;
  if (!bot || !skill) throw new Error(`job "${id}" has no bot and skill`);
  const can = effectiveCan(bot, job);
  const branch = job.branch ? renderBranch(job.branch, { event, args, job: id, workflow: workflow.name }) : undefined;
  const prompt = [skill.body, eventContext(event, args, branch), preloaded].filter(Boolean).join('\n\n');
  const preload = effectivePreload(bot, job);
  const tools = effectiveTools(bot, job);
  return {
    spec: session({ config, bot, skill, can, branch, prompt, cwd, paths: job.paths, preload, tools, mcp }),
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
 * The secrets a bot's harness needs, picked from `env`. Model-proxy harnesses get the proxy URL and a per-bot key
 * (`BOTHUB_LLM_API_KEY_<BOT>`), falling back to the shared `BOTHUB_LLM_API_KEY`.
 */
export const secretsFor = (
  { name, harness }: Pick<Defined<Bot>, 'name' | 'harness'>,
  env: Record<string, string | undefined>
) => {
  const botKey = `BOTHUB_LLM_API_KEY_${name.toUpperCase().replaceAll('-', '_')}`;
  const proxy: [string, string | undefined][] = [
    ['BOTHUB_LLM_BASE_URL', env.BOTHUB_LLM_BASE_URL],
    ['BOTHUB_LLM_API_KEY', env[botKey] ?? env.BOTHUB_LLM_API_KEY],
  ];
  const byHarness: Record<Executor, [string, string | undefined][]> = {
    'claude-code': [['CLAUDE_CODE_OAUTH_TOKEN', env.CLAUDE_CODE_OAUTH_TOKEN]],
    codex: [],
    opencode: proxy,
    pi: proxy,
  };
  return present(byHarness[harness]);
};

/**
 * Everything a planned job needs to run. Without `gh` or `issues`, nothing is applied; without `gh`, pull requests
 * are skipped; without `hubPr`, notes are skipped. `issues` defaults to GitHub's when `gh` is given and also feeds
 * `preload`; `mcp` starts the server for a run's hub tools, which are left out without it.
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
  hubPr?: Parameters<typeof apply>[1]['hubPr'];
  adapters?: Record<Executor, ExecutorAdapter>;
  onEvent?: (run: Run, record: EventRecord) => void;
};

/** A planned job, either skipped with a stored reason or run with its final outcome. */
export type JobResult = PlannedJob & ({ skipped: string } | { run: Run; outcome?: Outcome });

const skip = async (planned: PlannedJob, reason: string, p: Pipeline): Promise<JobResult> => {
  const { workflow, job, bot } = planned;
  await p.store.create({ workflow, job, ...(bot && { bot }), event: p.event, status: 'skipped', reason });
  return { ...planned, skipped: reason };
};

/** Runs one agent session through the limiter and resolves to the finished run and its final message. */
const agent = (bot: Defined<Bot>, spec: RunSpec, timeoutMinutes: number, run: Run, p: Pipeline) =>
  Effect.gen(function* () {
    let result: string | undefined;
    let lastText = '';
    const finished = yield* p.limit(
      runJob({
        adapter: (p.adapters ?? executors)[bot.harness],
        spec,
        timeoutMinutes,
        store: p.store,
        runId: run.id,
        secrets: secretsFor(bot, p.env),
        onEvent: record => {
          if (record.event.type === 'text') lastText = record.event.text;
          if (record.event.type === 'end') result = record.event.result;
          p.onEvent?.(run, record);
        },
      })
    );
    return { run: finished, final: result ?? lastText };
  });

/** Reads a check bot's verdict: its reply's first line is `PASS` or `FAIL`, the rest are findings. */
const verdictOf = (run: Run, final: string): Pick<Verdict, 'pass' | 'findings'> => {
  if (run.status !== 'succeeded')
    return { pass: false, findings: `run ${run.id} ${run.status}${run.error ? `: ${run.error}` : ''}` };
  const reply = extractProposals(final).proposals.find(proposal => proposal.kind === 'reply');
  if (!reply) return { pass: true };
  const [first = '', ...rest] = reply.body.trim().split('\n');
  const word = first.trim().toUpperCase();
  const findings = (word === 'PASS' || word === 'FAIL' ? rest.join('\n') : reply.body).trim();
  return { pass: word === 'PASS', ...(findings && { findings }) };
};

const verdictContract = [
  '## Verdict',
  'End with a `bothub` block holding one reply. Its first line is `PASS` or `FAIL`; the lines after it are your',
  'findings, most severe first, each naming the file and line.',
].join('\n');

type Attempt = { planned: PlannedJob; job: Job; worktree: string; cwd: string; parent: Run };

const runCheck = (check: Defined<Check>, a: Attempt, p: Pipeline) =>
  Effect.gen(function* () {
    const gating = check.mode !== 'shadow';
    const done = (result: Pick<Verdict, 'pass' | 'findings' | 'runs'>): Verdict => ({
      check: check.name,
      gating,
      ...result,
    });
    const { run: script, paths } = check;
    const changed = script && !paths ? [] : (yield* Effect.promise(() => p.workspaces.changes(a.worktree))).files;
    const matching = paths ? changed.filter(file => paths.some(glob => matchGlob(glob, file))) : changed;
    if (paths && !matching.length) return done({ pass: true, findings: 'no changed file matches its paths' });

    if (script) {
      const timeout = a.job['timeout-minutes'] ?? defaultMinutes;
      const { ok, output } = yield* Effect.promise(() => runScript(script, a.cwd, timeout));
      return done({ pass: ok, ...(!ok && { findings: output || 'exited non-zero' }) });
    }

    const bot = p.config.bots[check.bot ?? ''];
    const skill = p.config.skills[check.skill ?? ''];
    if (!bot || !skill) return done({ pass: false, findings: 'the check has no bot and skill' });
    if (!matching.length) return done({ pass: true, findings: 'no changed files' });
    const targets = check['for-each'] ? matching.map(file => [file]) : [matching];
    const runs: string[] = [];
    const findings: string[] = [];
    let pass = true;
    for (const target of targets) {
      const { diff } = yield* Effect.promise(() => p.workspaces.changes(a.worktree, target));
      const prompt = [
        skill.body,
        check.body,
        `## Changes\n\n${target.map(file => `- ${file}`).join('\n')}\n\n${fenced(diff)}`,
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
      runs.push(run.id);
      const verdict = verdictOf(run, final);
      pass &&= verdict.pass;
      if (verdict.findings) findings.push(targets.length > 1 ? `${target[0]}:\n${verdict.findings}` : verdict.findings);
    }
    return done({ pass, runs, ...(findings.length && { findings: findings.join('\n\n') }) });
  });

const followUp = (prompt: string, failing: Verdict[], attempt: number, total: number) =>
  [
    prompt,
    '## Check findings',
    `Attempt ${attempt} of ${total}. Your earlier changes are still in this worktree, but these checks failed. Fix what they found, then end with your proposals again.`,
    ...failing.map(v => `### ${v.check}\n\n${fenced(v.findings ?? 'failed without output')}`),
  ].join('\n\n');

/** Stores and returns an attempt's outcome, applying `toApply` when the mode and a GitHub client allow it. */
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
  const push = ({ kind: _, ...proposal }: Extract<Proposal, { kind: 'push' }>) =>
    workspaces.publish(event.repo, a.worktree, { ...proposal, ...(paths && { paths }), message: `bothub: ${run.job}` });
  const results = applied
    ? await apply(toApply, { event, push, ...(gh && { gh }), ...(issues && { issues }), ...(hubPr && { hubPr }) })
    : [];
  const outcome: Outcome = { proposals, errors, accepted, rejected, results, applied, ...(checks && { checks }) };
  await p.store.saveOutcome(run.id, outcome);
  return outcome;
};

/** The issue context a planned job preloads, read from `issues`, or GitHub's issues when only `gh` is given. */
const preloadFor = async (planned: PlannedJob, workflow: Defined<Workflow>, p: Pipeline) => {
  const job = workflow.jobs[planned.job];
  const bot = job?.bot ? p.config.bots[job.bot] : undefined;
  if (!job || !bot) return;
  return issueContext(p.issues ?? (p.gh && githubIssues(p.gh, p.event.repo)), p.event, effectivePreload(bot, job));
};

/** Runs the job's bot, then its `until` checks, sending failing findings back as new attempts in the same worktree. */
const attempts = (planned: PlannedJob, workflow: Defined<Workflow>, first: Run, cwd: string, p: Pipeline) =>
  Effect.gen(function* () {
    const preloaded = yield* Effect.promise(() => preloadFor(planned, workflow, p));
    const built = buildSpec({
      ...planned,
      config: p.config,
      workflow,
      event: p.event,
      cwd,
      preloaded,
      ...(p.mcp && { mcp: p.mcp }),
    });
    const { bot, job, can, branch, timeoutMinutes } = built;
    const max = job.until?.max ?? 0;
    let parent = first;
    let prompt = built.spec.prompt;
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
      const { run, final } = yield* agent(bot, { ...built.spec, prompt }, timeoutMinutes, current, p);
      const extracted = extractProposals(final);
      const validated = validate(extracted.proposals, { can, paths: job.paths, branch }, job.mode);
      const a: Attempt = { planned, job, worktree: first.id, cwd, parent: run };
      const succeeded = run.status === 'succeeded';
      if (!succeeded || !job.until) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, succeeded ? validated.accepted : undefined, a, p)
        );
        return { ...planned, run, outcome };
      }

      const checks: Verdict[] = [];
      for (const name of job.until.checks) {
        const check = p.config.checks[name];
        checks.push(
          check ? yield* runCheck(check, a, p) : { check: name, gating: true, pass: false, findings: 'unknown check' }
        );
      }
      const failing = checks.filter(v => v.gating && !v.pass);
      if (!failing.length) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, validated.accepted, a, p, checks)
        );
        return { ...planned, run, outcome };
      }

      if (attempt > max) {
        const reason = `checks still failing after ${attempt} attempts`;
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
        return { ...planned, run: failed, outcome };
      }

      yield* Effect.promise(() => settle(run, extracted, validated, undefined, a, p, checks));
      prompt = followUp(built.spec.prompt, failing, attempt + 1, max + 1);
      parent = run;
    }
  });

const scriptJob = (planned: PlannedJob, script: string, job: Job, p: Pipeline) =>
  Effect.gen(function* () {
    const { store, event } = p;
    const created = yield* Effect.promise(() => store.create({ workflow: planned.workflow, job: planned.job, event }));
    const timeout = job['timeout-minutes'] ?? defaultMinutes;
    const execute = (cwd: string) =>
      Effect.promise(async () => {
        await store.update(created.id, { status: 'running', startedAt: new Date().toISOString() });
        const { ok, output } = await runScript(script, cwd, timeout);
        const ts = new Date().toISOString();
        if (output) await store.append(created.id, { ts, seq: 0, event: { type: 'text', text: output } });
        await store.append(created.id, { ts, seq: output ? 1 : 0, event: { type: 'end', ok } });
        const run = await store.update(created.id, {
          status: ok ? 'succeeded' : 'failed',
          ...(!ok && { error: 'the script exited non-zero' }),
          endedAt: ts,
        });
        return { ...planned, run };
      });
    return yield* withWorktree(created, execute, p);
  });

const withWorktree = (
  created: Run,
  use: (cwd: string) => Effect.Effect<JobResult>,
  p: Pipeline
): Effect.Effect<JobResult> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => p.workspaces.create(p.event, created.id)),
    use,
    () => Effect.promise(() => p.workspaces.remove(p.event.repo, created.id))
  ).pipe(
    Effect.catchAll(e =>
      Effect.promise(async () => {
        const error = e.error instanceof Error ? e.error.message : String(e.error);
        const run = await p.store.update(created.id, { status: 'failed', error, endedAt: new Date().toISOString() });
        return { workflow: created.workflow, job: created.job, ...(created.bot && { bot: created.bot }), run };
      })
    )
  );

/**
 * Runs one planned job in a fresh worktree: a script, or a bot running its skill until the job's checks pass.
 * Proposals are validated and applied only once the checks pass and the mode and a GitHub client allow it. Every
 * attempt is stored as its own run, linked to the one before by `parent`; the worktree is always removed.
 */
export const runPlanned = (planned: PlannedJob, p: Pipeline): Effect.Effect<JobResult> =>
  Effect.gen(function* () {
    const workflow = p.config.workflows[planned.workflow];
    const job = workflow?.jobs[planned.job];
    if (!workflow || !job) return yield* Effect.promise(() => skip(planned, 'the job is not in the config', p));
    if (job.run) return yield* scriptJob(planned, job.run, job, p);
    const bot = job.bot ? p.config.bots[job.bot] : undefined;
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
    return yield* withWorktree(created, cwd => attempts(planned, workflow, created, cwd, p), p);
  });

/**
 * Runs planned jobs workflow by workflow, each in dependency order. A job whose `needs` did not all succeed in
 * this run is skipped.
 */
export const runPlan = (planned: PlannedJob[], p: Pipeline): Effect.Effect<JobResult[]> =>
  Effect.forEach(
    [...new Set(planned.map(j => j.workflow))],
    name =>
      Effect.gen(function* () {
        const workflow = p.config.workflows[name];
        const results: JobResult[] = [];
        const succeeded = new Set<string>();
        for (const id of workflow ? jobOrder(workflow) : []) {
          const job = planned.find(j => j.workflow === name && j.job === id);
          if (!job) continue;
          const blocked = workflow?.jobs[id]?.needs.filter(need => !succeeded.has(need)) ?? [];
          const reason = `needs ${blocked.map(need => `"${need}"`).join(', ')}, which did not succeed`;
          const result = blocked.length ? yield* Effect.promise(() => skip(job, reason, p)) : yield* runPlanned(job, p);
          if ('run' in result && result.run.status === 'succeeded') succeeded.add(id);
          results.push(result);
        }
        return results;
      }),
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(results => results.flat()));
