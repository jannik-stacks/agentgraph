import { Effect, Redacted } from 'effect';
import { appToken } from './github.ts';
import { Store } from './store.ts';

/** What waits on a human: repos the installation reaches beyond `app.repo`, and parked runs with the command to continue each. */
export const needsYou = (
  app: { repo: string; id: string; key: Redacted.Redacted },
  where: { hub: string; data: string },
  fetch: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch
) =>
  Effect.gen(function* () {
    const token = yield* appToken(app, fetch);
    const res = yield* Effect.tryPromise(() =>
      fetch('https://api.github.com/installation/repositories?per_page=100', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'bothub' },
      }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`GET /installation/repositories ${r.status}`))))
    );
    const repos = (res as { repositories: { full_name: string }[] }).repositories.map(r => r.full_name);
    const lines: string[] = [];
    const extra = repos.filter(r => r !== app.repo);
    if (extra.length > 0) {
      lines.push(`The installation reaches ${extra.length} repo(s) besides ${app.repo}: ${extra.join(', ')}`);
      lines.push('  Narrow it at https://github.com/settings/installations');
    }
    const store = yield* Store;
    const parked = [...(yield* store.list({ status: 'asking' })), ...(yield* store.list({ status: 'waiting' }))];
    for (const run of parked) {
      lines.push(`${run.id} ${run.workflow} #${run.thread} is ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
      lines.push(`  Answer at https://github.com/${app.repo}/issues/${run.thread}, then:`);
      lines.push(`  node core/bin/run.ts --hub ${where.hub} --issue ${run.thread} --data ${where.data}`);
    }
    return lines;
  });
