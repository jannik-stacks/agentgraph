import { join } from 'node:path';
import { api, serve } from './api.ts';
import type { githubApp } from './github-app.ts';
import { localIssues } from './issues-local.ts';
import { eventQueue, handled, servedHub, type ServeOptions } from './serve.ts';
import { webhook } from './webhook.ts';
import { workspaces } from './workspace.ts';

/**
 * A hub driven by GitHub App webhooks: receives deliveries on `webhookPort` (the only port to expose through a
 * tunnel), acknowledges repeated delivery ids from the store's ledger without running them, runs the jobs as the
 * installation that covers the event's repository, and serves the studio API on `port`. Events from repositories
 * outside `repos`, when given, are ignored. Deliveries wait in `eventQueue` like `serveHub`'s. Resolves once listening.
 */
export const serveGitHub = async (
  options: ServeOptions & {
    app: Pick<ReturnType<typeof githubApp>, 'repoClient' | 'repoToken'>;
    secret: string;
    repos?: string[];
    webhookPort?: number;
  }
) => {
  const { app, secret, repos, webhookPort = 5183 } = options;
  const hub = await servedHub(
    options,
    dataDir => workspaces({ dataDir, token: repo => app.repoToken(repo) }),
    (event, config) => ({
      gh: app.repoClient(event.repo),
      ...(config.hub.issues === 'local' && { issues: localIssues(join(options.hub, 'issues'), { repo: event.repo }) }),
    })
  );
  const { log } = hub;
  const run = handled(hub, options.onResults);
  const queue = await eventQueue(
    hub,
    async event => {
      if (repos && !repos.includes(event.repo)) return log(`event ${event.id} from ${event.repo} ignored`);
      await run(event);
    },
    options
  );
  const receiver = webhook({
    secret,
    seen: async id => !(await hub.store.deliver(id)),
    onEvent: event => queue.enqueue(event, true),
    onError: (e, id) => log(`delivery ${id}: ${(e as Error).message}`),
  });
  const hooks = await serve(receiver, webhookPort);
  const studio = await serve(
    api({ hubDir: hub.dir, store: hub.store, ...(hub.hubErrors && { hubErrors: hub.hubErrors }) }),
    options.port ?? 5181
  );
  const portOf = (server: typeof hooks) => (server.address() as { port: number }).port;
  log(`webhooks on http://127.0.0.1:${portOf(hooks)}, studio on http://127.0.0.1:${portOf(studio)}, hub ${hub.dir}`);
  const close = (server: typeof hooks) => new Promise(done => server.close(done));
  return {
    ports: { webhook: portOf(hooks), studio: portOf(studio) },
    idle: queue.idle,
    stop: async () => {
      await Promise.all([close(hooks), close(studio)]);
      await queue.stop();
    },
  };
};
