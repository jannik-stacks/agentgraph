import { join, resolve } from 'node:path';
import { Effect } from 'effect';
import { api, serve } from './api.ts';
import { compile } from './config.ts';
import { plan } from './dispatch.ts';
import type { githubApp } from './github-app.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { bothubServer } from './mcp-config.ts';
import type { JobResult } from './pipeline.ts';
import { fileQueue, worker, type WorkerOptions } from './queue.ts';
import { limiter } from './runner.ts';
import { checkLine, laneOf, runEvent } from './serve.ts';
import { openStore } from './store.ts';
import type { BotEvent } from './types.ts';
import { webhook } from './webhook.ts';
import { workspaces } from './workspace.ts';

/** A webhook delivery waiting to run: its event and the installation that sent it. */
type Delivery = { event: BotEvent; installation?: number };

/**
 * A hub driven by GitHub App webhooks: receives deliveries on `webhookPort` (the only port to expose through a
 * tunnel), acknowledges repeated delivery ids from the store's ledger without running them, runs the jobs as the
 * installation that sent it, and serves the studio API on `port`. Events from repositories outside `repos`, when
 * given, are ignored. Deliveries wait in `<data>/queue` and run like `serveHub`'s: up to `concurrency` at once, one at a
 * time per issue or pull request, and a failing one again after a wait (`retry`) until it moves to
 * `<data>/queue/failed`. Resolves once listening.
 */
export const serveGitHub = async ({
  hub,
  data,
  app,
  secret,
  env,
  repos,
  port = 5181,
  webhookPort = 5183,
  log = line => process.stderr.write(`${line}\n`),
  onResults,
  concurrency = 4,
  retry = {},
}: {
  hub: string;
  data: string;
  app: ReturnType<typeof githubApp>;
  secret: string;
  env: Record<string, string | undefined>;
  repos?: string[];
  port?: number;
  webhookPort?: number;
  log?: (line: string) => void;
  onResults?: (event: BotEvent, results: JobResult[]) => void;
  concurrency?: number;
  retry?: Pick<WorkerOptions<Delivery>, 'tries' | 'backoff'>;
}) => {
  const dir = resolve(hub);
  const root = resolve(data);
  const store = openStore(root);
  const spaces = workspaces({ dataDir: root, token: repo => app.repoToken(repo) });
  const limit = await Effect.runPromise(limiter(concurrency));

  const handle = async ({ event, installation }: Delivery) => {
    if (repos && !repos.includes(event.repo)) return log(`event ${event.id} from ${event.repo} ignored`);
    const compiled = compile(await readHub(dir));
    if (!compiled.ok) {
      for (const e of compiled.errors) log(`hub: ${e.path}: ${e.message}`);
      throw new Error(`the hub does not compile (${compiled.errors.length} errors)`);
    }
    const { config } = compiled;
    const jobs = plan(event, config);
    const on = `${event.repo}${event.number ? `#${event.number}` : ''}`;
    log(
      `event ${event.trigger}${event.action ? ` (${event.action})` : ''} on ${on} by @${event.actor.login}: ${jobs.length} jobs`
    );
    const issues = config.hub.issues === 'local' ? localIssues(join(dir, 'issues'), { repo: event.repo }) : undefined;
    const results = await runEvent(jobs, {
      config,
      event,
      store,
      workspaces: spaces,
      limit,
      env,
      gh: installation !== undefined ? app.client(installation) : app.repoClient(event.repo),
      ...(issues && { issues }),
      mcp: tools => bothubServer({ dir, tools, repo: event.repo, data: root }),
      hub: dir,
      data: root,
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

  const queue = fileQueue<Delivery>(join(root, 'queue'));
  const work = worker(queue, handle, e => log(`error: ${e.message}`), {
    concurrency,
    key: ({ id, item }) => laneOf({ id, item: item.event }),
    ...retry,
  });
  void work.wake();
  let pushing = Promise.resolve();
  const receiver = webhook({
    secret,
    seen: async id => !(await store.deliver(id)),
    onEvent: (event, _id, { installation }) => {
      pushing = pushing
        .then(async () => {
          await queue.push(event.id, { event, ...(installation !== undefined && { installation }) });
          void work.wake();
        })
        .catch((e: Error) => log(`error: ${e.message}`));
    },
    onError: (e, id) => log(`delivery ${id}: ${(e as Error).message}`),
  });
  const hooks = await serve(receiver, webhookPort);
  const studio = await serve(api({ hubDir: dir, store }), port);
  const portOf = (server: typeof hooks) => (server.address() as { port: number }).port;
  log(`webhooks on http://127.0.0.1:${portOf(hooks)}, studio on http://127.0.0.1:${portOf(studio)}, hub ${dir}`);
  const close = (server: typeof hooks) => new Promise(done => server.close(done));
  return {
    ports: { webhook: portOf(hooks), studio: portOf(studio) },
    idle: async () => {
      await pushing;
      await work.idle();
    },
    stop: async () => {
      await Promise.all([close(hooks), close(studio)]);
      await pushing;
      await work.stop();
    },
  };
};
