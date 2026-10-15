import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Effect } from 'effect';
import { api, serve } from './api.ts';
import { compile, type Config, type ConfigError } from './config.ts';
import { prepareDeps } from './deps.ts';
import { localChannel, trackerChannel, type Channel } from './channel.ts';
import { plan, type PlannedJob, type Rerun } from './dispatch.ts';
import { engine, hubVersions, srcDir } from './fingerprint.ts';
import { keyVariable } from './pipeline/prompt.ts';
import { git } from './git.ts';
import type { Issues } from './issues.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { bothubServer } from './mcp-config.ts';
import type { Started } from './ops.ts';
import { continuation, issuesOf, onRequest, runPlan, type JobResult, type Pipeline } from './pipeline.ts';
import { hubLauncher } from './pipeline/context.ts';
import { loadPrices } from './prices.ts';
import { localPulls } from './pulls.ts';
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

/** A log line for a check starting, or ending with its verdict and how long it took. */
export const checkLine = (run: Run, check: string, verdict?: Verdict) => {
  const at = `${run.workflow}/${run.job} ${run.id} check ${check}`;
  if (!verdict) return `${at} start`;
  const result = verdict.blocked ? 'blocked' : verdict.skipped ? 'skipped' : verdict.pass ? 'pass' : 'fail';
  return `${at} ${result}${verdict.durationMs === undefined ? '' : ` in ${(verdict.durationMs / 1000).toFixed(1)}s`}`;
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
    /** The hash of the hub's files now (see `hubVersions`), recorded on every run. */
    version?: () => Promise<string>;
    backend: (event: BotEvent, config: Config) => Backend;
    log: (line: string) => void;
  };

/** The pipeline one event of `hub` runs through, with `stamp` on every run it creates. */
export const pipelineFor = (
  hub: Hub,
  config: Config,
  event: BotEvent,
  stamp: Pick<Run, 'engine' | 'hub'> = {}
): Pipeline => ({
  config,
  event,
  store: { ...hub.store, create: (fields, id) => hub.store.create({ ...stamp, ...fields }, id) },
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
 * Work to run: an event, and the one workflow it is for when it names one. A `workflow_dispatch` event runs every job
 * of its workflow with its text as their arguments; any other event runs what each workflow's `on:` plans for it.
 */
export type Work = { event: BotEvent; workflow?: string };

const rerunWord = /^(all|fresh)(?:\s+|$)/;

/** The jobs `work` starts under `config`. */
export const planFor = ({ event, workflow }: Work, config: Config): PlannedJob[] => {
  if (event.trigger !== 'workflow_dispatch')
    return plan(event, config).filter(j => !workflow || j.workflow === workflow);
  const named = workflow && config.workflows[workflow];
  if (!named) return [];
  const word = rerunWord.exec(event.body ?? '');
  const args = word ? (event.body ?? '').slice(word[0].length) : event.body;
  return plan(event, { ...config, workflows: { [named.name]: { ...named, on: { workflow_dispatch: {} } } } }).map(
    job => ({ ...job, ...(args && { args }), ...(word && { rerun: word[1] as Rerun }) })
  );
};

/**
 * The event `work` runs as and the jobs it plans: a comment on a merge request bothub opened continues the issue it
 * was for (see `continuation`), and a request that is closed or merged continues nothing.
 */
export const prepare = async (work: Work, hub: Hub) => {
  const config = await hub.config();
  const continued = await continuation(pipelineFor(hub, config, work.event));
  if (continued && 'reason' in continued) {
    hub.log(`event ${work.event.id} continues nothing, ${continued.reason}`);
    return { event: work.event, config, jobs: [] };
  }
  const event = continued?.event ?? work.event;
  const workflow = continued?.workflow ?? work.workflow;
  const jobs = planFor({ event, ...(workflow && { workflow }) }, config);
  hub.log(described(event, jobs.length));
  return { event, config, jobs };
};

const runPrepared = async ({ event, config, jobs }: Awaited<ReturnType<typeof prepare>>, hub: Hub) => {
  if (!jobs.length) return [];
  const version = await hub.version?.().catch(() => undefined);
  const p = pipelineFor(hub, config, event, { engine: await engine(), ...(version && { hub: version }) });
  return Effect.runPromise(runPlan(jobs, p));
};

/** Runs the jobs `event` starts (see `prepare`), only those of `workflow` when given. */
export const handleEvent = async (event: BotEvent, hub: Hub, workflow?: string): Promise<JobResult[]> =>
  runPrepared(await prepare({ event, ...(workflow && { workflow }) }, hub), hub);

/** Whether the runner takes new work, and the work it holds until it does. Kept in `<data>/runner.json`. */
export type Control = { paused: boolean; held: Work[] };

/**
 * A hub that takes work: `start` plans it and runs it in the background, one event at a time per issue or merge
 * request, or holds it while paused. `control` and `edit` read and change the pause state, `issues` is the tracker
 * of a repository, `channel` where it answers, and `idle` resolves once nothing runs.
 */
export type Runner = Hub & {
  repo?: string;
  channel: Channel;
  issues: (repo: string) => Promise<Issues | undefined>;
  start: (work: Work) => Promise<Started>;
  control: () => Promise<Control>;
  edit: (change: (control: Control) => Control) => Promise<Control>;
  idle: () => Promise<void>;
};

/** One issue's or merge request's lane: its work runs one at a time, in order. */
export const laneOf = (event: BotEvent) => `${event.repo}${onRequest(event) ? '!' : '#'}${event.number ?? event.id}`;

/**
 * The runner of `hub`. On creation, runs a stopped process left unfinished are marked interrupted (see `reconcile`)
 * and their work started again; the jobs that already closed done are reused. After each event, `after` runs, such as
 * a look for merge requests bots opened.
 */
export const runner = async (
  hub: Hub,
  {
    repo,
    channel,
    after,
    onResults,
  }: {
    repo?: string;
    channel?: Channel;
    after?: (runner: Runner) => Promise<void>;
    onResults?: (event: BotEvent, results: JobResult[]) => void;
  } = {}
): Promise<Runner> => {
  const file = join(hub.data, 'runner.json');
  const control = async (): Promise<Control> => ({
    paused: false,
    held: [],
    ...(JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Partial<Control>),
  });
  let editing: Promise<unknown> = Promise.resolve();
  const edit = (change: (c: Control) => Control) => {
    const next = editing.then(async () => {
      const changed = change(await control());
      await mkdir(hub.data, { recursive: true });
      await writeFile(file, JSON.stringify(changed, null, 2));
      return changed;
    });
    editing = next.catch(() => {});
    return next;
  };
  const issues = async (name: string) => {
    const event = {
      id: '',
      ts: '',
      source: 'cli',
      trigger: 'workflow_dispatch',
      repo: name,
      actor: { login: '', association: 'NONE' },
    } as const;
    return issuesOf({ ...hub.backend(event, await hub.config()), event });
  };
  const lanes = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();
  const self: Runner = {
    ...hub,
    ...(repo && { repo }),
    channel: channel ?? trackerChannel(issues),
    issues,
    control,
    edit,
    start: async work => {
      const prepared = await prepare(work, hub);
      const started: Started = { event: prepared.event.id, jobs: prepared.jobs.map(j => `${j.workflow}/${j.job}`) };
      if (!prepared.jobs.length) return started;
      let holding = false;
      await edit(c => {
        holding = c.paused;
        return holding ? { ...c, held: [...c.held, work] } : c;
      });
      if (holding) return { ...started, held: true };
      const lane = laneOf(prepared.event);
      const ran = (lanes.get(lane) ?? Promise.resolve())
        .then(async () => {
          const results = await runPrepared(prepared, hub);
          if (results.length) onResults?.(prepared.event, results);
          await after?.(self);
        })
        .catch((e: Error) => hub.log(`error: ${e.message}`));
      lanes.set(lane, ran);
      pending.add(ran);
      void ran.finally(() => {
        pending.delete(ran);
        if (lanes.get(lane) === ran) lanes.delete(lane);
      });
      return started;
    },
    idle: async () => {
      while (pending.size) await Promise.all(pending);
    },
  };
  const interrupted = await reconcile(hub.store, hub.workspaces);
  const again = new Map<string, Work>();
  for (const r of interrupted) {
    hub.log(`${r.workflow}/${r.job} ${r.id} interrupted, running it again`);
    again.set(`${r.event.id}/${r.workflow}`, { event: r.event, workflow: r.workflow });
  }
  for (const work of again.values()) await self.start(work).catch((e: Error) => hub.log(`error: ${e.message}`));
  return self;
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

/** The model key variables set in `env`, by name only, each with the bots that use it. */
const modelKeys = (env: Record<string, string | undefined>, config?: Config) => {
  const keys = Object.keys(env)
    .filter(key => key.startsWith('BOTHUB_LLM_API_KEY') && env[key])
    .sort();
  const bots = Object.values(config?.bots ?? {});
  const users = (key: string) => bots.filter(bot => keyVariable(bot, env) === key).map(bot => bot.name);
  return keys.map(key => (users(key).length ? `${key} (${users(key).join(', ')})` : key)).join(', ') || 'none';
};

/**
 * Logs one line when the process exits: why, as `because` last said or an uncaught error, and its exit code.
 * Resolves to `because`.
 */
export const logExit = (log: (line: string) => void, proc: NodeJS.EventEmitter = process) => {
  let why = '';
  proc.once('uncaughtExceptionMonitor', (e: Error) => (why = `on error: ${e.message}`));
  proc.once('exit', (code: number) => log(`serve exits${why && ` ${why}`} with code ${code}`));
  return (reason: string) => void (why ||= reason);
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
  log(`model keys: ${modelKeys(env, await compiled.config().catch(() => undefined))}`);
  const version = hubVersions(dir, root, (from, to, stat) =>
    log(from ? `hub ${from} -> ${to}: ${stat.join(', ')}` : `hub ${to}`)
  );
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
    version,
    prices: loadPrices({ file: join(srcDir, '..', 'infra', 'local', 'prices.json'), env }),
    backend,
    log,
    ...(adapters && { adapters }),
    ...(launch && { launch }),
  };
};

/** Serves the studio API and the ops of `runner` on `port`. */
export const serveStudio = (runner: Runner, port = 5181) =>
  serve(
    api({
      hubDir: runner.dir,
      store: runner.store,
      runner,
      ...(runner.hubErrors && { hubErrors: runner.hubErrors }),
    }),
    port
  );

/**
 * Starts the `pull_request` events of local merge requests that no run has taken yet, such as a request a bot just
 * opened. Idempotent: an event already started here or recorded on a run is skipped.
 */
const pullFollowUps = (pulls: ReturnType<typeof localPulls>) => {
  const started = new Set<string>();
  return async (runner: Runner) => {
    for (const event of await pulls.events()) {
      if (event.trigger !== 'pull_request' || started.has(event.id)) continue;
      started.add(event.id);
      if ((await runner.store.runs({ event: event.id })).length) continue;
      await runner.start({ event });
    }
  };
};

/**
 * A local hub that runs the work it is given: local issues under `<hub>/issues`, merge requests in
 * `<data>/pulls.jsonl` against the local `origin`, and the studio API with the ops on `port` (0 picks a free one).
 * Nothing runs until an op triggers it, except runs a stopped process left unfinished and the merge requests bots
 * open, which start the workflows their `pull_request` events plan. With `prewarm`, the hub's `deps` install starts at
 * once. Resolves once listening.
 */
export const serveHub = async (options: ServeOptions & { origin: string; repo?: string; prewarm?: boolean }) => {
  const { origin, repo = `local/${basename(origin, '.git')}`, prewarm = false } = options;
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
  const followUps = pullFollowUps(pulls);
  const run = await runner(hub, {
    repo,
    channel: localChannel({ hub: dir, data: root }),
    after: followUps,
    ...(options.onResults && { onResults: options.onResults }),
  });
  const warming = prewarm
    ? warmDeps({ hub: dir, data: root, repo, workspaces: hub.workspaces, launch: options.launch, log })
    : undefined;
  await followUps(run).catch((e: Error) => log(`error: ${e.message}`));
  const server = await serveStudio(run, options.port);
  const address = server.address();
  const listening = typeof address === 'object' && address ? address.port : options.port;
  log(`serving ${dir} on http://127.0.0.1:${listening}, origin ${origin} as ${repo}`);
  return {
    port: listening,
    runner: run,
    idle: run.idle,
    stop: async () => {
      await new Promise(done => server.close(done));
      await run.idle();
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
