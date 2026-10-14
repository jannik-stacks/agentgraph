import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Effect } from 'effect';
import { apply } from '../apply.ts';
import type { Config, Defined } from '../config.ts';
import { abandoned, type PlannedJob } from '../dispatch.ts';
import { withDeps } from '../deps.ts';
import { harnesses } from '../harnesses/index.ts';
import type { GitHub } from '../github-app.ts';
import { githubIssues } from '../issues-github.ts';
import type { Issues } from '../issues.ts';
import type { McpServer } from '../mcp-config.ts';
import type { McpTool } from '../mcp.ts';
import type { loadPrices } from '../prices.ts';
import { githubPulls, type Pulls } from '../pulls.ts';
import { hubBox } from '../hub-sandbox.ts';
import { authFailure } from '../preflight.ts';
import { resetOf, runJob, sandboxed, stoppedByHuman, sandboxedWith, type Launcher, type limiter } from '../runner.ts';
import type { Bot, Closure, Harness } from '../schema.ts';
import { Summarizer, summarizeRun } from '../summaries.ts';
import type { EventRecord, Outcome, Run, Store, Verdict } from '../store.ts';
import type { BotEvent, HarnessAdapter, RunSpec } from '../types.ts';
import { estimate, tally } from '../usage.ts';
import type { Workspaces } from '../workspace.ts';
import { secretsFor } from './prompt.ts';

/**
 * Everything a planned job needs to run. Without `gh` or `issues`, nothing is applied; merge requests go through
 * `pulls`, GitHub's when only `gh` is given, and are skipped without either. Hub changes land through `hubPr`, by default on a branch of the `hub` directory's own repository.
 * `data` is the data directory: runs are summarized into it, and opencode runs surface what it holds. Scripts see the `hub` directory read-only as `BOTHUB_HUB` and the
 * commit their worktree started from as `BOTHUB_BASE`, the event's number as `BOTHUB_ISSUE`, and a check script the
 * attempt's reply as `BOTHUB_REPLY`. `issues` defaults to GitHub's when `gh` is given and also feeds
 * `preload`; `mcp` starts the server for a run's hub tools, which are left out without it. Harnesses and scripts
 * run in the sandbox; `launch` replaces it only in tests and the simulator. `onCheck` hears each check of an attempt
 * start, without a verdict, and end, with it.
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
  onAlert?: (line: string) => void;
  onCheck?: (attempt: Run, check: string, verdict?: Verdict) => void;
  /** Minutes a harness may stay silent before its run is stopped, 10 unless set. */
  stallMinutes?: number;
  /** List prices, for runs whose harness reports no cost. */
  prices?: ReturnType<typeof loadPrices>;
  /** Stops the running agent of a run id as a human's stop; each agent registers while it runs. */
  stops?: Map<string, () => void>;
  /** How often a running agent's issue is checked for being closed or unlabeled, 30 seconds unless set. */
  pollMs?: number;
};

/** The hub's sandbox, as its `sandbox` settings change it, unless `launch` replaces it. */
export const hubLauncher = (p: Pick<Pipeline, 'config' | 'hub' | 'data' | 'launch'>) => {
  const { sandbox } = p.config.hub;
  return p.launch ?? (sandbox && p.hub ? sandboxedWith(hubBox(sandbox, p.hub, p.data)) : sandboxed);
};

/** How the pipeline starts commands: in the hub's sandbox unless `launch` says otherwise, with the hub's `deps` ready. */
export const launcher = (p: Pipeline) => {
  const { deps } = p.config.hub;
  const launch = hubLauncher(p);
  return deps && p.data ? withDeps(launch, deps, join(p.data, 'deps'), p.hub) : launch;
};

export const pullsOf = (p: Pipeline) => p.pulls ?? (p.gh && githubPulls(p.gh, p.event.repo));

/** The issue tracker a pipeline acts on: its own, or GitHub's when only `gh` is given. */
export const issuesOf = (p: Pick<Pipeline, 'issues' | 'gh' | 'event'>) =>
  p.issues ?? (p.gh && githubIssues(p.gh, p.event.repo));

/** A planned job with its final run, which holds the reason and closure of a job that was skipped, and outcome. */
export type JobResult = PlannedJob & { run: Run; outcome?: Outcome };

export const skip = async (
  planned: PlannedJob,
  reason: string,
  p: Pipeline,
  closure: Closure = 'deferred',
  extra: Pick<Run, 'approval'> = {}
): Promise<JobResult> => {
  const { workflow, job, bot } = planned;
  const run = await p.store.create({
    workflow,
    job,
    ...(bot && { bot }),
    event: p.event,
    status: 'skipped',
    closure,
    reason,
    ...extra,
  });
  return { ...planned, run };
};

const day = 24 * 60 * 60 * 1000;

/**
 * Why a bot may not start another run today, if it may not. Every run counts, attempts and checks too, except
 * runs whose sandbox never started. Says when the next run frees up.
 */
const outOfRuns = async (bot: Defined<Bot>, store: Store, now = Date.now()) => {
  const cap = bot.budget?.['runs-per-day'];
  if (!cap) return;
  const used = (await store.runs({ bot: bot.name, since: now - day })).filter(run => run.stopped !== 'sandbox');
  if (used.length < cap) return;
  const frees = new Date(Date.parse(used[cap - 1]!.startedAt!) + day).toISOString();
  return `bot "${bot.name}" used its ${cap} runs for the last 24 hours, the next one frees up at ${frees}`;
};

/** The run with its `costUsd` at list prices when its harness reported none, each call priced by the model that answered. */
const priced = async (run: Run, p: Pipeline) => {
  if (run.costUsd || !p.prices) return run;
  const prices = await p.prices();
  let model = run.model;
  let usd = 0;
  for (const { event } of await p.store.events(run.id)) {
    if (event.type === 'start' && event.model) model = event.model;
    if (event.type === 'usage') usd += estimate(tally([event]), prices[event.model ?? model ?? '']) ?? 0;
  }
  return usd ? p.store.update(run.id, { costUsd: usd }) : run;
};

/** Writes a run's summaries into the data directory, with the bot's summarizer; a summary never fails the run. */
const summarize = async (bot: Defined<Bot>, run: string, p: Pipeline) => {
  const settings = bot.summarizer ?? Summarizer.parse('extractive');
  if (!p.data || settings.mode === 'off') return;
  const { BOTHUB_LLM_BASE_URL: url, BOTHUB_LLM_API_KEY: apiKey } = secretsFor(bot, p.env);
  const recorded: Promise<void>[] = [];
  await summarizeRun(p.data, run, settings, {
    ...(url && { endpoint: { url, ...(apiKey && { apiKey }) } }),
    onUsage: usage => recorded.push(p.store.add(run, { ...usage, source: 'summarizer' })),
  }).catch(() => {});
  await Promise.all(recorded).catch(() => {});
};

/** Resolves with a reason once the work `p.event` started is abandoned (see `abandoned`); never without an issue tracker. */
const abandonment = (p: Pipeline) => {
  const issues = issuesOf(p);
  if (!issues) return;
  return Effect.promise(() => abandoned(p.event, issues).catch(() => undefined)).pipe(
    Effect.delay(p.pollMs ?? 30_000),
    Effect.repeat({ until: reason => reason !== undefined }),
    Effect.map(reason => reason ?? '')
  );
};

/** The abandonment of the event's work, or a human's stop of run `id`, whichever resolves first. */
const stoppable = (id: string, p: Pipeline) => {
  const abandoned = abandonment(p);
  const { stops } = p;
  if (!stops) return abandoned;
  const human = Effect.async<string>(resume => void stops.set(id, () => resume(Effect.succeed(stoppedByHuman)))).pipe(
    Effect.ensuring(Effect.sync(() => void stops.delete(id)))
  );
  return abandoned ? Effect.race(abandoned, human) : human;
};

/**
 * Runs one agent session through the limiter, in the check pool for a check run, and resolves to the finished run and its final message, with the
 * worktree read-only when `readonly`. A bot out of runs for the day is skipped instead; the model the harness reports
 * is recorded on the run. A silent harness is stopped after `stallMinutes`, and a run whose issue was abandoned is
 * withdrawn.
 */
const once = (
  bot: Defined<Bot>,
  spec: RunSpec,
  timeoutMinutes: number,
  run: Run,
  p: Pipeline,
  env: Record<string, string> = {},
  readonly = false
) =>
  Effect.gen(function* () {
    const spent = yield* Effect.promise(() => outOfRuns(bot, p.store));
    if (spent) {
      const skipped = yield* Effect.promise(() =>
        p.store.update(run.id, { status: 'skipped', stopped: 'budget', reason: spent })
      );
      return { run: skipped, final: '' };
    }
    let result: string | undefined;
    let lastText = '';
    let model: string | undefined;
    const until = stoppable(run.id, p);
    const finished = yield* p.limit(
      runJob({
        adapter: (p.adapters ?? harnesses)[bot.harness],
        spec: spec.surfacer ? { ...spec, surfacer: { ...spec.surfacer, run: run.id } } : spec,
        timeoutMinutes,
        store: p.store,
        runId: run.id,
        secrets: secretsFor(bot, p.env),
        env,
        launch: launcher(p),
        readonly,
        stallMinutes: p.stallMinutes ?? 10,
        ...(until && { until }),
        onEvent: record => {
          if (record.event.type === 'start') model ??= record.event.model;
          if (record.event.type === 'text') lastText = record.event.text;
          if (record.event.type === 'end') result = record.event.result;
          p.onEvent?.(run, record);
        },
      }),
      { bot, check: run.check !== undefined }
    );
    const reported: string | undefined = model;
    const recorded = reported ? yield* Effect.promise(() => p.store.update(run.id, { model: reported })) : finished;
    const costed = yield* Effect.promise(() => priced(recorded, p));
    yield* Effect.promise(() => summarize(bot, run.id, p));
    return { run: costed, final: result ?? lastText };
  });

const restartBudget = 2;
const backoff = 10_000;
const resetCap = 5 * 60_000;
const lasting = /usage limit|quota/i;

/**
 * The fault outside the bot's work a failed run met: a refused key (`auth`), a stall, a provider fault, or a crash
 * of the harness or its container (`infra`), which a run that died before its bot did anything counts as.
 */
const faultOf = async (run: Run, p: Pipeline) => {
  if (run.status !== 'failed') return;
  if (authFailure(run.error)) return 'auth';
  if (run.stopped === 'stalled' || run.stopped === 'provider') return run.stopped;
  if (run.stopped) return;
  if (run.exit?.signal || run.exit?.code === 137) return 'infra';
  const events = await p.store.events(run.id);
  return events.every(({ event }) => event.type === 'start' || event.type === 'error') ? 'infra' : undefined;
};

/**
 * How long to wait before running again after `run` failed: until the reset or retry-after its error names, at once
 * after a stall, otherwise a backoff that grows with each restart. Undefined when that is more than 5 minutes off, or
 * for a usage limit or quota that names no reset.
 */
export const retryWait = (run: Pick<Run, 'stopped' | 'error'>, restarts = 0, now = Date.now()) => {
  const reset = resetOf(run.error, now);
  if (!reset && lasting.test(run.error ?? '')) return;
  const wait = reset ? reset.getTime() - now + 1000 : run.stopped === 'stalled' ? 0 : backoff * 3 ** restarts;
  return wait <= resetCap ? Math.max(wait, 0) : undefined;
};

/**
 * Runs one agent session (see `once`), and while it fails on a fault outside the bot's work (see `faultOf`), runs it
 * again on a new run after `retryWait`, in a fresh session told why the last one stopped, up to 2 restarts. A refused
 * key is never run again. Giving up stops the last run as `infra` with its own error, records its `restarts` and
 * raises one alert.
 */
export const agent = (
  bot: Defined<Bot>,
  spec: RunSpec,
  timeoutMinutes: number,
  run: Run,
  p: Pipeline,
  env: Record<string, string> = {},
  readonly = false
) =>
  Effect.gen(function* () {
    let ran = yield* once(bot, spec, timeoutMinutes, run, p, env, readonly);
    for (let restarts = 0; ; restarts++) {
      const fault = yield* Effect.promise(() => faultOf(ran.run, p));
      if (!fault) return ran;
      const why = stripVTControlCharacters(ran.run.error ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      const wait = fault === 'auth' || restarts >= restartBudget ? undefined : retryWait(ran.run, restarts);
      if (wait === undefined) {
        p.onAlert?.(`ALERT ${fault} ${ran.run.id} ${why} restarts=${restarts}`);
        return { ...ran, run: yield* Effect.promise(() => p.store.update(ran.run.id, { stopped: 'infra', restarts })) };
      }
      yield* Effect.sleep(wait);
      const { id, workflow, job, event, check, attempt, issue } = ran.run;
      const next = yield* Effect.promise(() =>
        p.store.create({
          workflow,
          job,
          event,
          bot: bot.name,
          harness: bot.harness,
          parent: id,
          restarts: restarts + 1,
          ...(check && { check }),
          ...(attempt && { attempt }),
          ...(issue && { issue }),
        })
      );
      const { session: _, ...fresh } = spec;
      const prompt = `${spec.prompt}\n\n## Restarted\n\nYour last run stopped before it finished. Why it stopped: ${why || fault}. Its work so far is still in the worktree; carry on from there.`;
      ran = yield* once(bot, { ...fresh, prompt }, timeoutMinutes, next, p, env, readonly);
    }
  });
