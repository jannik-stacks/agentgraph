import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { stringify } from 'yaml';
import { expect, it, vi } from 'vitest';
import { readInstanceEnv } from '../src/main.ts';
import { ensureInstance } from '../src/instance.ts';
import { seeded } from './fixtures.ts';
import { makeRun } from './kit.ts';
import { removeAfter } from './world.ts';
import { runStudioAction, startStudioServer, studioDir } from './studio.ts';
import { makeServedGraphs } from '../studio/served.ts';

const starter = join(import.meta.dirname, '..', 'examples', 'starter');

const writeRun = (data: string, id: string) => {
  mkdirSync(join(data, id), { recursive: true });
  writeFileSync(
    join(data, id, 'run.json'),
    JSON.stringify(makeRun({ id, issue: 1, workflow: 'issue', status: 'done', step: 'done', started: 'now' }))
  );
};

it('serves each named instance under its own name, with no run crossing over', async () => {
  const { root: dir, seed } = seeded('studio-instances', { 'README.md': 'hello' });
  removeAfter(dir);
  const root = join(dir, 'instances');
  const [live, bench] = await Promise.all(['live', 'bench'].map(name => ensureInstance(root, name, seed)));
  for (const i of [live!, bench!]) {
    writeFileSync(
      join(i.dir, 'instance.yaml'),
      `checkout: ${seed}\nbase: main\nowner: o\nexported: {}\ngraph: ${starter}\nfork: ${i === live ? 'live' : 'bench'}/project\n`
    );
    writeRun(i.data, `run-${i.dir.split('/').at(-1)}`);
  }
  const at = new Date().toISOString();
  writeFileSync(
    join(live!.data, 'run-live', 'labels.jsonl'),
    `${JSON.stringify({ at, key: 'variant', value: 'a' })}\n`
  );
  writeFileSync(
    join(live!.data, 'run-live', 'checks.jsonl'),
    `${JSON.stringify({ at, step: 'review', check: { check: 'quality', pass: true, ms: 0, value: { score: 3 } }, version: 'v', usd: 0 })}\n`
  );
  writeFileSync(
    join(live!.data, 'run-live', 'trace.jsonl'),
    `${JSON.stringify({ at, step: 'implement', told: { text: 'go', by: 'me' } })}\n`
  );
  vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root, names: ['live', 'bench'] }));
  vi.stubEnv('AGI_STUDIO_DIR', undefined);
  vi.stubEnv('AGI_STUDIO_DATA', undefined);
  vi.stubEnv('AGI_STUDIO_PLUGINS', join(import.meta.dirname, '../examples/plugins/bench'));
  const { server, base } = await startStudioServer();
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return [response.status, await response.json()];
  };
  try {
    const runs = (query: string) => runStudioAction(`${base}/api/actions${query}`, actions => actions.runs());
    const opened = (query: string, id: string) =>
      runStudioAction(`${base}/api/actions${query}`, actions => actions.run({ id }));
    const listed = async (name: string) => (await runs(`?instance=${name}`)).map(r => `${r.fixture} ${r.run.id}`);
    expect(await listed('live')).toEqual(['live/issue run-live']);
    expect(await listed('bench')).toEqual(['bench/issue run-bench']);
    expect(await opened('?instance=bench', 'run-bench')).toMatchObject({ instance: 'bench' });
    expect(await opened('?instance=live', 'run-live')).toMatchObject({ fork: 'live/project', repo: '' });
    expect(await runs('?instance=bench')).toMatchObject([{ fork: 'bench/project', repo: '' }]);
    expect(await opened('?instance=live', 'run-bench')).toBeNull();
    const tail = (after: { trace: number; checks: number }) =>
      runStudioAction(`${base}/api/actions?instance=live`, actions => actions.run({ id: 'run-live', after }));
    expect((await opened('?instance=live', 'run-live'))?.trace.map(line => 'check' in line)).toEqual([false, true]);
    expect((await tail({ trace: 1, checks: 0 }))?.trace.map(line => 'check' in line)).toEqual([true]);
    expect(await tail({ trace: 1, checks: 1 })).toMatchObject({ trace: [], usd: 0 });
    for (const query of ['', '?instance=other']) await expect(runs(query)).rejects.toThrow();
    expect((await fetch(`${base}/api/plugins/results/data`)).status).toBe(404);
    const [, results] = await get('/api/plugins/results/data?instance=bench');
    expect(results.sheet.runs.map((r: { key: string }) => r.key)).toEqual(['run-bench']);
    const [, benched] = await get('/api/plugins/bench/data');
    expect(
      benched.rows.map((r: { instance: string; run: string; labels: Record<string, string> }) => [
        r.instance,
        r.run,
        r.labels.instance,
        r.labels.variant,
      ])
    ).toEqual([
      ['live', 'run-live', 'live', 'a'],
      ['bench', 'run-bench', 'bench', undefined],
    ]);
    expect(benched.fields).toEqual([{ check: 'quality', field: 'score', type: 'number' }]);
    expect((await get('/api/plugins/bench/data?instance=live'))[0]).toBe(404);
    const served = await (await fetch(`${base}/@id/__x00__virtual:served`)).text();
    expect(served).toContain('"name":"live","title":"live","problems":[],"local":true');
    expect(served).toContain('"name":"bench"');
    const manifest = await (await fetch(`${base}/@id/__x00__virtual:agentgraph-pages`)).text();
    expect(manifest).toContain('instance:"live",load:()=>import("/@id/__x00__virtual:agentgraph-page/live/results")');
    expect(manifest).toContain('instance:"bench"');
    const fixtures = await (await fetch(`${base}/@id/__x00__virtual:fixtures`)).text();
    expect(fixtures).toContain('"id":"live/issue"');
    expect(fixtures).toContain('"id":"bench/issue"');
    await vi.waitFor(() => expect(server.watcher.getWatched()).toHaveProperty(realpathSync(bench!.data)));
    const sent = vi.spyOn(server.ws, 'send');
    writeRun(bench!.data, 'run-later');
    await vi.waitFor(() =>
      expect(sent).toHaveBeenCalledWith('agi:changed', {
        topics: expect.arrayContaining(['bench:data', 'bench:data:run-later', 'bench:results', 'bench']),
      })
    );
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});

const readStudioUrl = async (url: string) =>
  (await readInstanceEnv({ dir: '/data/stacks-kit', owner: 'o', base: 'main' }, {}, { AGENTGRAPH_STUDIO_URL: url })).env
    .AGENTGRAPH_STUDIO_URL;

it('links an instance run under the studio address plus the instance name', async () => {
  expect(await readStudioUrl('http://127.0.0.1:5600/')).toBe('http://127.0.0.1:5600/stacks-kit');
  expect(await readStudioUrl('')).toBe('');
});

it('ignores instance settings from the shell when it serves several instances, as the loop does', async () => {
  const { root: dir, seed } = seeded('studio-shell', { 'README.md': 'hello' });
  removeAfter(dir);
  const root = join(dir, 'instances');
  for (const name of ['left', 'right']) {
    const i = await ensureInstance(root, name, seed);
    writeFileSync(
      join(i.dir, 'instance.yaml'),
      `checkout: ${seed}\nbase: main\nowner: o\nexported: {}\ngraph: ${starter}\n`
    );
  }
  vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root, names: ['left', 'right'] }));
  vi.stubEnv('AGENTGRAPH_TRACKER', 'github');
  vi.stubEnv('AGENTGRAPH_FORK', 'shell/project');
  const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const served = await makeServedGraphs().read();
    expect(served.map(({ name, local, problems }) => ({ name, local, problems }))).toEqual([
      { name: 'left', local: true, problems: [] },
      { name: 'right', local: true, problems: [] },
    ]);
    expect(served.map(instance => instance.fork)).toEqual([undefined, undefined]);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('AGENTGRAPH_TRACKER'));
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('AGENTGRAPH_FORK'));
  } finally {
    warned.mockRestore();
    vi.unstubAllEnvs();
  }
});

it.each(['issues', 'issue', 'since'] as const)(
  'keeps each Studio fork instance credential for lazy tracker %s reads',
  async operation => {
    const { root: dir, seed } = seeded('studio-credentials', { 'README.md': 'hello' });
    removeAfter(dir);
    const root = join(dir, 'instances');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    for (const name of ['left', 'right']) {
      const instance = await ensureInstance(root, name, seed);
      const env = join(instance.dir, 'credentials.env');
      writeFileSync(
        env,
        `AGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_KEY="${privateKey}"\nAGENTGRAPH_GITHUB_TOKEN=${name}-user\n`
      );
      writeFileSync(
        join(instance.dir, 'instance.yaml'),
        stringify({
          checkout: seed,
          base: 'main',
          owner: 'o',
          exported: {},
          graph: starter,
          tracker: 'github',
          repo: 'upstream/project',
          fork: 'fork/project',
          env,
        })
      );
    }
    vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root, names: ['left', 'right'] }));
    vi.stubEnv('AGENTGRAPH_GITHUB_TOKEN', 'shell-user');
    const upstreamTokens: string[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      const credential = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      if (path.startsWith('/repos/upstream/project/')) upstreamTokens.push(credential);
      const issue = {
        number: 7,
        title: credential,
        body: '',
        state: 'open',
        labels: [],
        user: { login: 'o' },
        author_association: 'OWNER',
        html_url: 'https://github.com/upstream/project/issues/7',
      };
      const routes: Record<string, unknown> = {
        '/app': { slug: 'helper' },
        '/user': { login: 'o' },
        '/repos/fork/project/installation': { id: 9 },
        '/app/installations/9/access_tokens': { token: 'fork-app', expires_at: '2999-01-01T00:00:00Z' },
        '/repos/fork/project/activity': [],
        '/repos/upstream/project/issues': [issue],
        '/repos/upstream/project/issues/7': issue,
        '/repos/upstream/project/issues/7/comments': [],
        '/repos/upstream/project/issues/7/events': [],
        '/repos/upstream/project/issues/comments': [
          {
            id: 1,
            body: credential,
            user: { login: 'o' },
            author_association: 'OWNER',
            created_at: '2026-10-16T12:00:00Z',
            issue_url: 'https://api.github.com/repos/upstream/project/issues/7',
          },
        ],
        '/repos/upstream/project/pulls/comments': [],
        '/repos/upstream/project/issues/events': [],
        '/repos/upstream/project/pulls': [],
      };
      return new Response(JSON.stringify(routes[path] ?? { message: 'Not Found' }), {
        status: Object.hasOwn(routes, path) ? 200 : 404,
      });
    });
    try {
      const served = await makeServedGraphs().read();
      expect(served.map(instance => instance.problems)).toEqual([[], []]);
      expect(fetch).not.toHaveBeenCalled();
      const read = (instance: (typeof served)[number]) => {
        const tracker = instance.host!.tracker;
        if (operation === 'since')
          return Stream.runCollect(tracker.since('2026-10-16T00:00:00Z')).pipe(
            Effect.map(events => events.map(event => event.comment?.body))
          );
        if (operation === 'issue') return tracker.issue(7).pipe(Effect.map(issue => [issue.title]));
        return tracker.issues().pipe(Effect.map(issues => issues.map(issue => issue.title)));
      };
      expect(await Promise.all(served.map(instance => Effect.runPromise(read(instance))))).toEqual([
        ['left-user'],
        ['right-user'],
      ]);
      vi.stubEnv('AGENTGRAPH_GITHUB_TOKEN', 'changed-shell-user');
      expect(await Promise.all(served.map(instance => Effect.runPromise(read(instance))))).toEqual([
        ['left-user'],
        ['right-user'],
      ]);
      expect([...new Set(upstreamTokens)].toSorted()).toEqual(['left-user', 'right-user']);
    } finally {
      fetch.mockRestore();
      vi.unstubAllEnvs();
    }
  }
);

it.each(['plugins', 'runs'])('refuses to serve an instance named %s, which would hide a studio page', async name => {
  const { root: dir, seed } = seeded(`studio-reserved-${name}`, { 'README.md': 'hello' });
  removeAfter(dir);
  const root = join(dir, 'instances');
  await ensureInstance(root, name, seed);
  const ran = spawnSync(process.execPath, [join(studioDir, 'dev.ts'), '--instance', name, '--data', root], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
  expect([ran.status, ran.stderr.trim()]).toEqual([
    2,
    `an instance named ${name} would hide the studio pages at /${name}; rename ${join(root, name)}`,
  ]);
});
