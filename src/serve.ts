import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Effect } from 'effect';
import { api, serve } from './api.ts';
import { compile } from './config.ts';
import { plan, withdrawn, type PlannedJob } from './dispatch.ts';
import type { GitHub } from './github-app.ts';
import { githubIssues } from './issues-github.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { bothubServer } from './mcp-config.ts';
import { approvals, runPlan, type JobResult, type Pipeline } from './pipeline.ts';
import { fileQueue, worker } from './queue.ts';
import { limiter } from './runner.ts';
import { openStore, reconcile } from './store.ts';
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

/**
 * The few GitHub calls a pipeline makes about pull requests, answered by a local origin: the default branch is the
 * origin's HEAD, and opened pull requests are appended to `file` as JSON lines.
 */
export const localPulls =
  (origin: string, file: string): GitHub =>
  async <T>(method: string, path: string, body?: unknown) => {
    if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      const { stdout } = await exec('git', ['-C', origin, 'symbolic-ref', '--short', 'HEAD']);
      return { default_branch: stdout.trim() } as T;
    }
    const pulls = async () =>
      (await readFile(file, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { head?: string });
    const listing = /^\/repos\/[^/]+\/[^/]+\/pulls\?(.*)$/.exec(path);
    if (method === 'GET' && listing) {
      const head = new URLSearchParams(listing[1]).get('head')?.replace(/^[^:]*:/, '');
      return (await pulls()).filter(pull => head === undefined || pull.head === head) as T;
    }
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(path)) {
      const count = (await pulls()).length;
      const pull = { number: count + 1, ...(body as object), html_url: `${origin}#pull/${count + 1}` };
      await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...pull })}\n`);
      return pull as T;
    }
    throw new Error(`${method} ${path} has no local equivalent`);
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
 * A long-running local hub: watches `<hub>/issues`, runs the jobs each change starts through the pipeline (local
 * issues, the bothub MCP server, worktrees of the local `origin`, pull requests recorded in `<data>/pulls.jsonl`)
 * and serves the studio API on `port` (0 picks a free one). Each new event id waits in `<data>/queue` and runs one
 * after another; one whose label was removed before it ran is dropped. Runs a stopped process left unfinished are
 * marked interrupted at startup and their events run again. Changes made while it was stopped run at startup; on the
 * first start for a data directory, what is already there is recorded as seen instead. Resolves once listening.
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
}) => {
  const dir = resolve(hub);
  const root = resolve(data);
  const store = openStore(root);
  const issues = localIssues(join(dir, 'issues'), { repo });
  const gh = localPulls(origin, join(root, 'pulls.jsonl'));
  const spaces = workspaces({ dataDir: root, cloneUrl: () => origin });
  const limit = await Effect.runPromise(limiter(1));

  const handle = async (event: BotEvent) => {
    if (await withdrawn(event, issues)) return log(`event ${event.id} dropped, its label "${event.label}" was removed`);
    const compiled = compile(await readHub(dir));
    if (!compiled.ok) {
      for (const e of compiled.errors) log(`hub: ${e.path}: ${e.message}`);
      return;
    }
    const { config } = compiled;
    const jobs = plan(event, config);
    log(`event ${event.trigger} (${event.action}) on #${event.number} by @${event.actor.login}: ${jobs.length} jobs`);
    const results = await runEvent(jobs, {
      config,
      event,
      store,
      workspaces: spaces,
      limit,
      env,
      gh,
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
    });
    for (const r of results)
      log(`${r.workflow}/${r.job}: ${'skipped' in r ? `skipped, ${r.skipped}` : `${r.run.status} ${r.run.id}`}`);
    if (results.length) onResults?.(event, results);
  };

  const queue = fileQueue<BotEvent>(join(root, 'queue'));
  const work = worker(queue, handle, e => log(`error: ${e.message}`));
  let pushing = Promise.resolve();
  const enqueue = (event: BotEvent, again = false) => {
    pushing = pushing
      .then(async () => {
        if (again || (await store.deliver(event.id))) await queue.push(event.id, event);
        void work.wake();
      })
      .catch((e: Error) => log(`error: ${e.message}`));
  };
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
      await pushing;
      await work.idle();
    },
    stop: async () => {
      watching.stop();
      await new Promise(done => server.close(done));
      await pushing;
      await work.stop();
    },
  };
};
