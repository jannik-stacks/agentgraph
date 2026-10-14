import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Effect } from 'effect';
import { api, serve } from './api.ts';
import { compile, type Config, type ConfigError } from './config.ts';
import { prepareDeps } from './deps.ts';
import { plan, withdrawn, type PlannedJob } from './dispatch.ts';
import { srcDir } from './fingerprint.ts';
import { git } from './git.ts';
import { roles } from './issues.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { bothubServer } from './mcp-config.ts';
import { approvals, continuation, issuesOf, onRequest, runPlan, type JobResult, type Pipeline } from './pipeline.ts';
import { hubLauncher } from './pipeline/context.ts';
import { loadPrices } from './prices.ts';
import { localPulls } from './pulls.ts';
import { fileQueue, worker, type Queued, type WorkerOptions } from './queue.ts';
import { limiter } from './runner.ts';
import { openStore, reconcile, type Run, type Verdict } from './store.ts';
import type { BotEvent } from './types.ts';
import { workspaces, type Workspaces } from './workspace.ts';

/** A local bare repository to use as the origin; anything else (a URL, a working clone) is refused. */
export const localOrigin = async (path: string) => {
  const origin = resolve(path);
  if (!(await stat(origin).catch(() => undefined))?.isDirectory())
    throw new Error(`${path} is not a local directory; serve only pushes to a local bare repository`);
  const bare = await git(origin, ['rev-parse', '--is-bare-repository']).catch(() => '');
  if (bare !== 'true') throw new Error(`${path} is not a bare repository (create one with git clone --bare)`);
  return origin;
};

/**
 * One issue's or merge request's lane: its events run one at a time, in order. Issues and merge requests that share a
 * number get separate lanes; an event without a number has its own.
 */
export const laneOf = ({ id, item }: Queued<BotEvent>) =>
  `${item.repo}${onRequest(item) ? '!' : '#'}${item.number ?? id}`;

/** A log line for a check starting, or ending with its verdict and how long it took. */
export const checkLine = (run: Run, check: string, verdict?: Verdict) => {
  const at = `${run.workflow}/${run.job} ${run.id} check ${check}`;
  if (!verdict) return `${at} start`;
  const result = verdict.blocked ? 'blocked' : verdict.skipped ? 'skipped' : verdict.pass ? 'pass' : 'fail';
  return `${at} ${result}${verdict.durationMs === undefined ? '' : ` in ${(verdict.durationMs / 1000).toFixed(1)}s`}`;
};

/**
 * Runs an event's planned jobs, then every earlier event whose blocked jobs this one approves, planned again so the
 * jobs that already closed are reused.
 */
export const runEvent = async (jobs: PlannedJob[], p: Pipeline): Promise<JobResult[]> => {
  const results = jobs.length ? await Effect.runPromise(runPlan(jobs, p)) : [];
  const issues = issuesOf(p);
  for (const original of issues ? await approvals(p.event, p.store, issues) : [])
    results.push(...(await Effect.runPromise(runPlan(plan(original, p.config), { ...p, event: original }))));
  return results;
};

/**
 * Compiles the hub in `dir` on each call. An edit that does not compile is logged once and the last version that
 * compiled keeps running, with `errors` saying what is wrong until it compiles again; a hub that never compiled
 * rejects.
 */
export const compiledHub = (dir: string, log: (line: string) => void) => {
  let good: Config | undefined;
  let errors: ConfigError[] = [];
  const config = async (): Promise<Config> => {
    const compiled = compile(await readHub(dir));
    if (compiled.ok) {
      if (errors.length) log('hub: compiles again');
      errors = [];
      return (good = compiled.config);
    }
    const message = `the hub does not compile (${compiled.errors.length} errors)`;
    if (JSON.stringify(compiled.errors) !== JSON.stringify(errors)) {
      for (const e of compiled.errors) log(`hub: ${e.path}: ${e.message}`);
      if (good) log(`${message}, running the last version that compiled`);
    }
    errors = compiled.errors;
    if (!good) throw new Error(message);
    return good;
  };
  return { config, errors: () => errors };
};

/** What an event's jobs act through: its issue tracker, merge requests and GitHub client. */
export type Backend = Pick<Pipeline, 'gh' | 'issues' | 'pulls'>;

/**
 * A hub that runs events: its directory, its data directory with the run store and worktrees, the config each event
 * runs with and the backend for each event's repository. `onEvent` and `onCheck` default to log lines for each run's
 * start and end and each check.
 */
export type Hub = Pick<Pipeline, 'store' | 'workspaces' | 'limit' | 'env'> &
  Partial<Pick<Pipeline, 'adapters' | 'launch' | 'onEvent' | 'onCheck' | 'prices' | 'stops'>> & {
    dir: string;
    data: string;
    config: () => Promise<Config>;
    hubErrors?: () => ConfigError[];
    backend: (event: BotEvent, config: Config) => Backend;
    log: (line: string) => void;
  };

/** The pipeline one event of `hub` runs through. */
export const pipelineFor = (hub: Hub, config: Config, event: BotEvent): Pipeline => ({
  config,
  event,
  store: hub.store,
  workspaces: hub.workspaces,
  limit: hub.limit,
  env: hub.env,
  ...hub.backend(event, config),
  mcp: tools => bothubServer({ dir: hub.dir, tools, repo: event.repo, data: hub.data }),
  hub: hub.dir,
  data: hub.data,
  ...(hub.adapters && { adapters: hub.adapters }),
  ...(hub.launch && { launch: hub.launch }),
  ...(hub.prices && { prices: hub.prices }),
  ...(hub.stops && { stops: hub.stops }),
  onEvent:
    hub.onEvent ??
    ((run, { event: e }) => {
      if (e.type === 'start' || e.type === 'end' || e.type === 'error')
        hub.log(`${run.workflow}/${run.job} ${run.id} ${e.type}${'message' in e ? ` ${e.message}` : ''}`);
    }),
  onAlert: hub.log,
  onJob: r =>
    hub.log(
      `${r.workflow}/${r.job}: ${r.run.status}${r.run.closure ? `, ${r.run.closure}` : ''} ${r.run.id}${r.run.reason ? `, ${r.run.reason}` : ''}`
    ),
  onCheck: hub.onCheck ?? ((run, check, verdict) => hub.log(checkLine(run, check, verdict))),
});

const described = (event: BotEvent, jobs: number) =>
  `event ${event.trigger}${event.action ? ` (${event.action})` : ''} on ${event.repo}${event.number ? `#${event.number}` : ''} by @${event.actor.login}: ${jobs} jobs`;

/**
 * Runs one event: an event whose label was removed before it ran is dropped, a comment on a merge request bothub
 * opened continues the issue it was for (see `continuation`), and any other runs the jobs it plans (see `runEvent`).
 * Logs the plan, and each job's result as it ends.
 */
export const handleEvent = async (delivered: BotEvent, hub: Hub): Promise<JobResult[]> => {
  const config = await hub.config();
  const continued = await continuation(pipelineFor(hub, config, delivered));
  if (continued && 'reason' in continued) {
    hub.log(`event ${delivered.id} continues nothing, ${continued.reason}`);
    return [];
  }
  const event = continued?.event ?? delivered;
  const p = pipelineFor(hub, config, event);
  const issues = issuesOf(p);
  if (issues && (await withdrawn(event, issues))) {
    hub.log(`event ${event.id} dropped, its label "${event.label}" was removed`);
    return [];
  }
  const jobs = plan(event, config).filter(job => !continued || job.workflow === continued.workflow);
  hub.log(described(event, jobs.length));
  if (!jobs.length && issues && event.trigger === 'issue_comment' && event.number !== undefined) {
    const issue = event.actor.login.endsWith('[bot]') ? undefined : await issues.get(event.number);
    const command = Object.values(config.workflows)
      .map(workflow => workflow.on.issue_comment?.command)
      .find(Boolean);
    if (issue?.labels.includes(roles.unsure) && command)
      hub.log(`#${issue.number} is an open question; start the answer with ${command} to continue the work`);
  }
  return runEvent(jobs, p);
};

/**
 * The durable queue of a hub's events in `<data>/queue`: up to `concurrency` events run at once, one at a time per
 * issue, and an event that fails waits and runs again (`retry`) until it moves to `<data>/queue/failed`. `enqueue`
 * records a new event in the delivery ledger first and drops a repeat, and drops an event a bot made that starts no
 * job; an event already `delivered` skips the ledger. A comment that continues an issue (see `continuation`) is queued
 * as that issue's comment, in the issue's lane. Runs a stopped process left unfinished are marked interrupted on
 * start and their events queued again.
 */
export const eventQueue = async (
  hub: Hub,
  run: (event: BotEvent) => Promise<void>,
  { concurrency = 4, retry = {} }: { concurrency?: number; retry?: Pick<WorkerOptions<BotEvent>, 'tries' | 'backoff'> }
) => {
  const queue = fileQueue<BotEvent>(join(hub.data, 'queue'));
  const work = worker(queue, run, e => hub.log(`error: ${e.message}`), { concurrency, key: laneOf, ...retry });
  const startsNothing = async (event: BotEvent) =>
    event.actor.login.endsWith('[bot]') &&
    (await hub.config().then(
      config => !plan(event, config).length,
      () => false
    ));
  const continues = async (event: BotEvent) => {
    const continued = await hub
      .config()
      .then(config => continuation(pipelineFor(hub, config, event)))
      .catch(() => undefined);
    return continued && 'event' in continued ? continued.event : event;
  };
  let pushing = Promise.resolve();
  const then = (step: () => Promise<unknown>) => {
    pushing = pushing.then(step).then(
      () => undefined,
      (e: Error) => hub.log(`error: ${e.message}`)
    );
  };
  const enqueue = (event: BotEvent, delivered = false) =>
    then(async () => {
      if (!delivered && !(await hub.store.deliver(event.id))) return;
      if (await startsNothing(event)) return hub.log(described(event, 0));
      await queue.push(event.id, await continues(event));
      void work.wake();
    });
  const interrupted = await reconcile(hub.store, hub.workspaces);
  for (const r of interrupted) hub.log(`${r.workflow}/${r.job} ${r.id} interrupted, running its event again`);
  for (const event of new Map(interrupted.map(r => [r.event.id, r.event])).values()) enqueue(event, true);
  void work.wake();
  return {
    enqueue,
    /** Records an event as delivered without running it. */
    skip: (event: BotEvent) => then(() => hub.store.deliver(event.id)),
    pushed: () => pushing,
    idle: async () => {
      await pushing;
      await work.idle();
    },
    stop: async () => {
      await pushing;
      await work.stop();
    },
  };
};

/**
 * Runs `handleEvent` for each queued event and hands the results to `onResults`. A job whose sandbox never started,
 * such as one whose dependencies did not install, fails the event so the queue runs it again; the jobs that closed
 * done are reused then.
 */
export const handled =
  (hub: Hub, onResults?: (event: BotEvent, results: JobResult[]) => void) => async (event: BotEvent) => {
    const results = await handleEvent(event, hub);
    if (results.length) onResults?.(event, results);
    const unstarted = results.filter(r => r.run.stopped === 'sandbox');
    if (unstarted.length)
      throw new Error(
        `${unstarted.map(r => `${r.workflow}/${r.job}`).join(', ')} did not start: ${unstarted[0]!.run.error}`
      );
  };

/** Options every served hub takes. */
export type ServeOptions = {
  hub: string;
  data: string;
  env: Record<string, string | undefined>;
  port?: number;
  log?: (line: string) => void;
  adapters?: Pipeline['adapters'];
  launch?: Pipeline['launch'];
  onResults?: (event: BotEvent, results: JobResult[]) => void;
  concurrency?: number;
  retry?: Pick<WorkerOptions<BotEvent>, 'tries' | 'backoff'>;
};

/** A log that writes each line with its ISO time to stderr and `<data>/serve.log`. */
export const stamped = (data: string) => {
  mkdirSync(data, { recursive: true });
  return (line: string) => {
    const stamp = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(stamp);
    appendFileSync(join(data, 'serve.log'), stamp);
  };
};

/** The `Hub` for a served hub directory, with its store, worktrees and limiter in `data`. */
export const servedHub = async (
  { hub, data, env, log = stamped(resolve(data)), adapters, launch, concurrency = 4 }: ServeOptions,
  spaces: (root: string) => Workspaces,
  backend: Hub['backend']
): Promise<Hub> => {
  const dir = resolve(hub);
  const root = resolve(data);
  const compiled = compiledHub(dir, log);
  return {
    dir,
    data: root,
    store: openStore(root),
    workspaces: spaces(root),
    limit: await Effect.runPromise(limiter(concurrency)),
    stops: new Map(),
    env,
    config: compiled.config,
    hubErrors: compiled.errors,
    prices: loadPrices({ file: join(srcDir, '..', 'infra', 'local', 'prices.json'), env }),
    backend,
    log,
    ...(adapters && { adapters }),
    ...(launch && { launch }),
  };
};

/** Serves the studio API of `hub` on `port`, stopping the runs it is running on request. */
export const serveStudio = (hub: Hub, port = 5181) =>
  serve(
    api({
      hubDir: hub.dir,
      store: hub.store,
      ...(hub.stops && { stops: hub.stops }),
      ...(hub.hubErrors && { hubErrors: hub.hubErrors }),
    }),
    port
  );

/**
 * A long-running local hub: watches `<hub>/issues` and the merge requests in `<data>/pulls.jsonl`, runs the jobs
 * each change starts through the pipeline (local issues, the bothub MCP server, worktrees and merge requests of the
 * local `origin`) and serves the studio API on `port` (0 picks a free one). Events wait in `eventQueue`. Changes made
 * while it was stopped run at startup; on the first start for a data directory, what is already there is recorded as
 * seen instead. With `prewarm`, the hub's `deps` install starts at once. Resolves once listening.
 */
export const serveHub = async (
  options: ServeOptions & { origin: string; repo?: string; interval?: number; prewarm?: boolean }
) => {
  const { origin, repo = `local/${basename(origin, '.git')}`, interval = 1000, prewarm = false } = options;
  const dir = resolve(options.hub);
  const root = resolve(options.data);
  const issues = localIssues(join(dir, 'issues'), { repo });
  const pulls = localPulls({ origin, file: join(root, 'pulls.jsonl'), repo });
  const hub = await servedHub(
    options,
    dataDir => workspaces({ dataDir, cloneUrl: () => origin }),
    () => ({ issues, pulls })
  );
  const { log } = hub;
  const queue = await eventQueue(hub, handled(hub, options.onResults), options);
  const warming = prewarm
    ? warmDeps({ hub: dir, data: root, repo, workspaces: hub.workspaces, launch: options.launch, log })
    : undefined;
  const primed = join(root, 'issues-seen');
  let priming = !(await stat(primed).catch(() => undefined));
  const watching = issues.watch(event => (priming ? queue.skip(event) : queue.enqueue(event)), {
    interval,
    replay: true,
  });
  await watching.ready;
  const seen = new Set<string>();
  const scanPulls = () =>
    pulls.events().then(
      events => {
        for (const event of events) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          queue.enqueue(event);
        }
      },
      (e: Error) => log(`error: ${e.message}`)
    );
  let scanning = scanPulls();
  let behind = false;
  const timer = setInterval(() => {
    if (behind) return;
    behind = true;
    scanning = scanning.then(scanPulls).finally(() => (behind = false));
  }, interval);
  await scanning;
  await queue.pushed();
  if (priming) {
    await mkdir(root, { recursive: true });
    await writeFile(primed, '');
    priming = false;
  }
  const server = await serveStudio(hub, options.port);
  const address = server.address();
  const listening = typeof address === 'object' && address ? address.port : options.port;
  log(`serving ${dir} on http://127.0.0.1:${listening}, origin ${origin} as ${repo}`);
  return {
    port: listening,
    idle: async () => {
      for (let before; before !== seen.size;) {
        before = seen.size;
        await queue.idle();
        await (scanning = scanning.then(scanPulls));
      }
      await queue.idle();
    },
    stop: async () => {
      watching.stop();
      clearInterval(timer);
      await scanning;
      await new Promise(done => server.close(done));
      await queue.stop();
      await warming;
    },
  };
};

/**
 * Installs the hub's `deps` for the default branch of `repo` in a worktree of its own, so the first runs find them
 * ready, or wait for the same install. Logs the outcome and never rejects.
 */
export const warmDeps = async ({
  hub,
  data,
  repo,
  workspaces: spaces,
  launch,
  log,
}: {
  hub: string;
  data: string;
  repo: string;
  workspaces: Workspaces;
  launch?: Pipeline['launch'] | undefined;
  log: (line: string) => void;
}) => {
  const compiled = compile(await readHub(hub));
  const deps = compiled.ok ? compiled.config.hub.deps : undefined;
  if (!compiled.ok || !deps) return;
  const launcher = hubLauncher({ config: compiled.config, hub, data, ...(launch && { launch }) });
  const id = `prewarm-${Date.now()}`;
  try {
    const tree = await spaces.create({ repo }, id);
    await prepareDeps(tree.path, deps, join(data, 'deps'), launcher, hub);
    log('deps ready');
  } catch (e) {
    log(`deps not prewarmed: ${(e as Error).message}`);
  } finally {
    await spaces.remove(repo, id);
  }
};
