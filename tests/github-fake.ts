import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetch } from '../src/github-app.ts';

type Call = { method: string; path: string; body?: Record<string, unknown> };

/**
 * A `fetch` that answers the Git data API calls from a local repository at `dir`, so an API push can be checked
 * against real git objects. Commits get a fixed GitHub identity; one carrying author, committer or signature fields
 * is refused, since GitHub would not sign it.
 */
export const fakeGitHub = (dir: string) => {
  const calls: Call[] = [];
  const run = (args: string[], options: { input?: Buffer; env?: Record<string, string> } = {}) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      ...(options.input && { input: options.input }),
      env: { ...process.env, ...options.env },
    }).trim();
  const ok = (args: string[]) => {
    try {
      run(args);
      return true;
    } catch {
      return false;
    }
  };
  const reply = (status: number, json?: unknown) =>
    new Response(json === undefined ? null : JSON.stringify(json), { status });

  const fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, path, ...(body && { body }) });
    const ref = decodeURIComponent(path.replace(/^\/git\/refs?\//, ''));
    if (method === 'GET' && path.startsWith('/git/ref/')) {
      const sha = ok(['rev-parse', '--verify', '--quiet', `refs/${ref}`]) ? run(['rev-parse', `refs/${ref}`]) : '';
      return sha ? reply(200, { object: { sha } }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const sha = path.split('/').at(-1)!;
      return ok(['cat-file', '-e', `${sha}^{commit}`]) ? reply(200, { sha }) : reply(404, { message: 'Not Found' });
    }
    if (method === 'POST' && path === '/git/blobs') {
      const input = Buffer.from(body!.content as string, 'base64');
      return reply(201, { sha: run(['hash-object', '-w', '--stdin'], { input }) });
    }
    if (method === 'POST' && path === '/git/trees') {
      const index = join(dir, `.fake-index-${calls.length}`);
      const env = { GIT_INDEX_FILE: index };
      run(['read-tree', body!.base_tree as string], { env });
      for (const e of body!.tree as { path: string; mode: string; sha: string | null }[])
        if (e.sha === null) run(['update-index', '--force-remove', '--', e.path], { env });
        else run(['update-index', '--add', '--cacheinfo', `${e.mode},${e.sha},${e.path}`], { env });
      const sha = run(['write-tree'], { env });
      rmSync(index, { force: true });
      return reply(201, { sha });
    }
    if (method === 'POST' && path === '/git/commits') {
      if (['author', 'committer', 'signature'].some(key => key in body!)) return reply(422, { message: 'unsigned' });
      const parents = (body!.parents as string[]).flatMap(p => ['-p', p]);
      const env = {
        GIT_AUTHOR_NAME: 'app[bot]',
        GIT_AUTHOR_EMAIL: 'app@github',
        GIT_COMMITTER_NAME: 'GitHub',
        GIT_COMMITTER_EMAIL: 'noreply@github.com',
      };
      const sha = run(['commit-tree', body!.tree as string, ...parents], {
        env,
        input: Buffer.from(body!.message as string),
      });
      return reply(201, { sha });
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = body!.ref as string;
      if (ok(['rev-parse', '--verify', '--quiet', name])) return reply(422, { message: 'Reference already exists' });
      run(['update-ref', name, body!.sha as string]);
      return reply(201, {});
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/')) {
      const name = `refs/${ref}`;
      const old = run(['rev-parse', name]);
      if (!body!.force && !ok(['merge-base', '--is-ancestor', old, body!.sha as string]))
        return reply(422, { message: 'Update is not a fast forward' });
      run(['update-ref', name, body!.sha as string, old]);
      return reply(200, {});
    }
    return reply(404, { message: `no fake for ${method} ${path}` });
  };
  return { calls, fetch };
};
