import { join } from 'node:path';
import { serve } from './api.ts';
import type { githubApp } from './github-app.ts';
import { senderTrust } from './github.ts';
import { localIssues } from './issues-local.ts';
import { runner, servedHub, serveStudio, type ServeOptions } from './serve.ts';
import { webhook } from './webhook.ts';
import { workspaces } from './workspace.ts';

/**
 * A hub driven by GitHub App webhooks: receives deliveries on `webhookPort` (the only port to expose through a
 * tunnel), starts each one's work on the runner once per delivery id, runs the jobs as the installation that covers
 * the event's repository, and serves the studio API with the ops on `port`. Events from repositories outside `repos`,
 * when given, are ignored. Resolves once listening.
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
  const run = await runner(hub, {
    ...(repos?.length === 1 && { repo: repos[0] }),
    ...(options.onResults && { onResults: options.onResults }),
  });
  const delivered = new Set<string>();
  const receiver = webhook({
    secret,
    onEvent: async (event, id) => {
      if (delivered.has(id)) return;
      delivered.add(id);
      if (repos && !repos.includes(event.repo)) return log(`event ${event.id} from ${event.repo} ignored`);
      await run.start({ event: await senderTrust(event, app.repoClient(event.repo)) });
    },
    ...(options.env.BOTHUB_APP_SLUG && { slug: options.env.BOTHUB_APP_SLUG }),
    onError: (e, id) => log(`delivery ${id}: ${(e as Error).message}`),
  });
  const hooks = await serve(receiver, webhookPort);
  const studio = await serveStudio(run, options.port);
  const portOf = (server: typeof hooks) => (server.address() as { port: number }).port;
  log(`webhooks on http://127.0.0.1:${portOf(hooks)}, studio on http://127.0.0.1:${portOf(studio)}, hub ${hub.dir}`);
  const close = (server: typeof hooks) => new Promise(done => server.close(done));
  return {
    ports: { webhook: portOf(hooks), studio: portOf(studio) },
    runner: run,
    idle: run.idle,
    stop: async () => {
      await Promise.all([close(hooks), close(studio)]);
      await run.idle();
    },
  };
};
