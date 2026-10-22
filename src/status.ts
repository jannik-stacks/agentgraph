import { Effect, Redacted } from 'effect';
import { appToken } from './github.ts';
import { Store } from './store.ts';

/** A warning when the installation reaches repos beyond `app.repo`. */
const reaches = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  fetch: (url: string, init?: RequestInit) => Promise<Response>
) =>
  Effect.gen(function* () {
    const token = yield* appToken(app, fetch)('repos');
    const res = yield* Effect.tryPromise(() =>
      fetch('https://api.github.com/installation/repositories?per_page=100', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'agentgraph',
        },
      }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`GET /installation/repositories ${r.status}`))))
    );
    const repos = (res as { repositories: { full_name: string }[] }).repositories.map(r => r.full_name);
    const lines: string[] = [];
    const extra = repos.filter(r => r !== app.repo);
    if (extra.length > 0) {
      lines.push(`The installation reaches ${extra.length} repo(s) besides ${app.repo}: ${extra.join(', ')}`);
      lines.push('  Narrow it at https://github.com/settings/installations');
    }
    return lines;
  });

/**
 * What waits on a human: repos the installation reaches beyond `app.repo`, and waiting runs with the command to
 * continue each. Without an App, the runs are on the forge folder `where.forge`. `where.again` are the run flags.
 */
export const needsYou = (
  app: { repo: string; id: string; key: Redacted.Redacted } | undefined,
  where: { again: string; forge?: string },
  fetch: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch
) =>
  Effect.gen(function* () {
    const lines: string[] = [];
    if (app) lines.push(...(yield* reaches(app, fetch)));
    const store = yield* Store;
    for (const run of yield* store.list({ status: 'waiting' })) {
      lines.push(`${run.id} ${run.workflow} #${run.issue} is ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
      const issue = app
        ? `https://github.com/${app.repo}/issues/${run.issue}`
        : `#${run.issue} (node bin/forge.ts ${where.forge} show)`;
      lines.push(run.reason ? `  Answer at ${issue}, then:` : `  Review the PR linked from ${issue}, then:`);
      lines.push(`  node bin/run.ts ${where.again} --issue ${run.issue}`);
    }
    return lines;
  });
