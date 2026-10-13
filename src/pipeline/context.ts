import { join } from 'node:path';
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
import { githubPulls, type Pulls } from '../pulls.ts';
import { runJob, sandboxed, type Launcher, type limiter } from '../runner.ts';
import type { Bot, Closure, Harness } from '../schema.ts';
import { Summarizer, summarizeRun } from '../summaries.ts';
import type { EventRecord, Outcome, Run, Store, Verdict } from '../store.ts';
import type { BotEvent, HarnessAdapter, RunSpec } from '../types.ts';
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
  onCheck?: (attempt: Run, check: string, verdict?: Verdict) => void;
  /** Minutes a harness may stay silent before its run is stopped, 10 unless set. */
  stallMinutes?: number;
  /** How often a running agent's issue is checked for being closed or unlabeled, 30 seconds unless set. */
  pollMs?: number;
};

/** How the pipeline starts commands: in the sandbox unless `launch` says otherwise, with the hub's `deps` ready. */
export const launcher = (p: Pipeline) => {
  const launch = p.launch ?? sandboxed;
  const { deps } = p.config.hub;
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
 * runs whose sandbox never started.
 */
const outOfRuns = async (bot: Defined<Bot>, store: Store, now = Date.now()) => {
  const cap = bot.budget?.['runs-per-day'];
  if (!cap) return;
  const used = (await store.runs({ bot: bot.name, since: now - day })).filter(run => run.stopped !== 'sandbox').length;
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

/**
 * Runs one agent session through the limiter and resolves to the finished run and its final message, with the
 * worktree read-only when `readonly`. A bot out of runs for the day is skipped instead; the model the harness reports
 * is recorded on the run. A silent harness is stopped after `stallMinutes`, and a run whose issue was abandoned is
 * withdrawn.
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
    const until = abandonment(p);
    const finished = yield* p.limit(
      runJob({
        adapter: (p.adapters ?? harnesses)[bot.harness],
        spec: spec.surfacer ? { ...spec, surfacer: { ...spec.surfacer, run: run.id } } : spec,
        timeoutMinutes,
        store: p.store,
        runId: run.id,
        secrets: { ...secretsFor(bot, p.env), ...env },
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
      })
    );
    const reported: string | undefined = model;
    const recorded = reported ? yield* Effect.promise(() => p.store.update(run.id, { model: reported })) : finished;
    yield* Effect.promise(() => summarize(bot, run.id, p));
    return { run: recorded, final: result ?? lastText };
  });
