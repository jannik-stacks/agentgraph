import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Effect } from 'effect';
import { api, serve } from './api.ts';
import { compile } from './config.ts';
import { prepareDeps } from './deps.ts';
import { plan, withdrawn, type PlannedJob } from './dispatch.ts';
import { githubIssues } from './issues-github.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { bothubServer } from './mcp-config.ts';
import { approvals, runPlan, type JobResult, type Pipeline } from './pipeline.ts';
import { localPulls } from './pulls.ts';
import { fileQueue, worker, type Queued, type WorkerOptions } from './queue.ts';
import { limiter, sandboxed } from './runner.ts';
import { openStore, reconcile, type Run, type Verdict } from './store.ts';
import type { BotEvent } from './types.ts';
import { workspaces } from './workspace.ts';

const exec = promisify(execFile);

/** A local bare repository to use as the origin; anything else (a URL, a working clone) is refused. */
export const localOrigin = async (path: string) => {
  const origin = resolve(path);
  if (!(await stat(origin).catch(() => undefined))?.isDirectory())
    throw new Error(`${path} is not a local directory; serve only pushes to a local bare repository`);
  const { stdout } = await exec('git', ['-C', origin, 'rev-parse', '--is-bare-repository']).catch(() => ({
    stdout: '',
  }));
  if (stdout.trim() !== 'true') throw new Error(`${path} is not a bare repository (create one with git clone --bare)`);
  return origin;
};

/** One issue or pull request's lane: its events run one at a time, in order. An event without a number has its own. */
export const laneOf = ({ id, item }: Queued<BotEvent>) => `${item.repo}#${item.number ?? id}`;

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
  const issues = p.issues ?? (p.gh && githubIssues(p.gh, p.event.repo));
  for (const original of issues ? await approvals(p.event, p.store, issues) : [])
    results.push(...(await Effect.runPromise(runPlan(plan(original, p.config), { ...p, event: original }))));
  return results;
};

/**
 * A long-running local hub: watches `<hub>/issues` and the merge requests in `<data>/pulls.jsonl`, runs the jobs
 * each change starts through the pipeline (local issues, the bothub MCP server, worktrees and merge requests of the
 * local `origin`) and serves the studio API on `port` (0 picks a free one). Each new event id waits in `<data>/queue`;
 * up to `concurrency` events run at once, one at a time per issue, and as many agent sessions. An event a bot made
 * that starts no job is not queued; one whose label was removed before it ran is dropped. An event that fails, or
 * meets a hub that does not compile, waits and runs again (`retry`), then moves to `<data>/queue/failed`. Runs a
 * stopped process left unfinished are marked interrupted at startup and their events run again. Changes made while it
 * was stopped run at startup; on the first start for a data directory, what is already there is recorded as seen
 * instead. With `prewarm`, the hub's `deps` install starts at once. Resolves once listening.
 */
export const serveHub = async ({
  hub,
  data,
  origin,
  repo = `local/${basename(origin, '.git')}`,
  env,
  port = 5181,
  interval = 1000,
  log = line => process.stderr.write(`${line}\n`),
  adapters,
  launch,
  onResults,
  concurrency = 4,
  retry = {},
  prewarm = false,
}: {
  hub: string;
  data: string;
  origin: string;
  repo?: string;
  env: Record<string, string | undefined>;
  port?: number;
  interval?: number;
  log?: (line: string) => void;
  adapters?: Pipeline['adapters'];
  launch?: Pipeline['launch'];
  onResults?: (event: BotEvent, results: JobResult[]) => void;
  concurrency?: number;
  retry?: Pick<WorkerOptions<BotEvent>, 'tries' | 'backoff'>;
  prewarm?: boolean;
}) => {
  const dir = resolve(hub);
  const root = resolve(data);
  const store = openStore(root);
  const issues = localIssues(join(dir, 'issues'), { repo });
  const pulls = localPulls({ origin, file: join(root, 'pulls.jsonl'), repo });
  const spaces = workspaces({ dataDir: root, cloneUrl: () => origin });
  const limit = await Effect.runPromise(limiter(concurrency));
  const described = (event: BotEvent, jobs: number) =>
    `event ${event.trigger} (${event.action}) on #${event.number} by @${event.actor.login}: ${jobs} jobs`;

  const handle = async (event: BotEvent) => {
    if (await withdrawn(event, issues)) return log(`event ${event.id} dropped, its label "${event.label}" was removed`);
    const compiled = compile(await readHub(dir));
    if (!compiled.ok) {
      for (const e of compiled.errors) log(`hub: ${e.path}: ${e.message}`);
      throw new Error(`the hub does not compile (${compiled.errors.length} errors)`);
    }
    const { config } = compiled;
    const jobs = plan(event, config);
    log(described(event, jobs.length));
    const results = await runEvent(jobs, {
      config,
      event,
      store,
      workspaces: spaces,
      limit,
      env,
      pulls,
      issues,
      mcp: tools => bothubServer({ dir, tools, repo, data: root }),
      hub: dir,
      data: root,
      ...(adapters && { adapters }),
      ...(launch && { launch }),
      onEvent: (run, { event: e }) => {
        if (e.type === 'start' || e.type === 'end' || e.type === 'error')
          log(`${run.workflow}/${run.job} ${run.id} ${e.type}${'message' in e ? ` ${e.message}` : ''}`);
      },
      onCheck: (run, check, verdict) => log(checkLine(run, check, verdict)),
    });
    for (const r of results)
      log(`${r.workflow}/${r.job}: ${'skipped' in r ? `skipped, ${r.skipped}` : `${r.run.status} ${r.run.id}`}`);
    if (results.length) onResults?.(event, results);
  };

  const queue = fileQueue<BotEvent>(join(root, 'queue'));
  const work = worker(queue, handle, e => log(`error: ${e.message}`), { concurrency, key: laneOf, ...retry });
  const startsNothing = async (event: BotEvent) => {
    if (!event.actor.login.endsWith('[bot]')) return false;
    const compiled = compile(await readHub(dir));
    return compiled.ok && !plan(event, compiled.config).length;
  };
  let pushing = Promise.resolve();
  const enqueue = (event: BotEvent, again = false) => {
    pushing = pushing
      .then(async () => {
        if (!again && !(await store.deliver(event.id))) return;
        if (!again && (await startsNothing(event))) return log(described(event, 0));
        await queue.push(event.id, event);
        void work.wake();
      })
      .catch((e: Error) => log(`error: ${e.message}`));
  };
  const warming = prewarm ? warmDeps({ hub: dir, data: root, repo, workspaces: spaces, launch, log }) : undefined;
  const interrupted = await reconcile(store, spaces);
  for (const run of interrupted) log(`${run.workflow}/${run.job} ${run.id} interrupted, running its event again`);
  for (const event of new Map(interrupted.map(run => [run.event.id, run.event])).values()) enqueue(event, true);
  void work.wake();
  const primed = join(root, 'issues-seen');
  let priming = !(await stat(primed).catch(() => undefined));
  const watching = issues.watch(
    event => {
      if (!priming) return enqueue(event);
      pushing = pushing.then(() => store.deliver(event.id)).then(() => undefined);
    },
    { interval, replay: true }
  );
  await watching.ready;
  const seen = new Set<string>();
  const scanPulls = () =>
    pulls.events().then(
      events => {
        for (const event of events) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          enqueue(event);
        }
      },
      (e: Error) => log(`error: ${e.message}`)
    );
  let scanning = scanPulls();
  const timer = setInterval(() => {
    scanning = scanning.then(scanPulls);
  }, interval);
  await scanning;
  await pushing;
  if (priming) {
    await mkdir(root, { recursive: true });
    await writeFile(primed, '');
    priming = false;
  }
  const server = await serve(api({ hubDir: dir, store }), port);
  const address = server.address();
  const listening = typeof address === 'object' && address ? address.port : port;
  log(`serving ${dir} on http://127.0.0.1:${listening}, origin ${origin} as ${repo}`);
  return {
    port: listening,
    idle: async () => {
      for (let before; before !== seen.size;) {
        before = seen.size;
        await pushing;
        await work.idle();
        await (scanning = scanning.then(scanPulls));
      }
      await pushing;
      await work.idle();
    },
    stop: async () => {
      watching.stop();
      clearInterval(timer);
      await scanning;
      await new Promise(done => server.close(done));
      await pushing;
      await work.stop();
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
  launch = sandboxed,
  log,
}: {
  hub: string;
  data: string;
  repo: string;
  workspaces: ReturnType<typeof workspaces>;
  launch?: Pipeline['launch'];
  log: (line: string) => void;
}) => {
  const compiled = compile(await readHub(hub));
  const deps = compiled.ok ? compiled.config.hub.deps : undefined;
  if (!deps) return;
  const id = `prewarm-${Date.now()}`;
  try {
    const tree = await spaces.create({ repo }, id);
    await prepareDeps(tree.path, deps, join(data, 'deps'), launch, hub);
    log('deps ready');
  } catch (e) {
    log(`deps not prewarmed: ${(e as Error).message}`);
  } finally {
    await spaces.remove(repo, id);
  }
};
