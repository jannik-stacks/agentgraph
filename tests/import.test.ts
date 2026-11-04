import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { makeStudioDevApiPlugin } from '../studio/fixtures.ts';
import { ensureInstance, writeImportedRun } from '../src/instance.ts';
import { getRunOrigin } from '../src/meta.ts';
import { fileStore, Store } from '../src/store.ts';
import { seeded } from './fixtures.ts';
import { git, tmp } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const serveStudio = (data: string) => {
  vi.stubEnv('AGI_STUDIO_DIR', join(import.meta.dirname, '..', 'examples', 'sandbox'));
  vi.stubEnv('AGI_STUDIO_DATA', data);
  const routes: Record<string, (req: unknown, res: unknown) => void> = {};
  const plugin = makeStudioDevApiPlugin().configureServer as (server: unknown) => void;
  plugin({
    watcher: { add: () => {}, on: () => {} },
    middlewares: { use: (path: string, f: (typeof routes)[string]) => (routes[path] = f) },
  });
  return (url: string, route = '/api/runs') =>
    new Promise<{ status: number; body: unknown }>(done => {
      const res = {
        statusCode: 200,
        setHeader: () => {},
        end: (body: string) => done({ status: res.statusCode, body: JSON.parse(body) }),
      };
      routes[route]!({ url }, res);
    });
};

it('keeps a commit or a patch as an ended run with no issue, once per import', async () => {
  const w = seeded('import', { 'README.md': 'hi\n' });
  dirs.push(w.root);
  const i = await ensureInstance(join(w.root, 'agentgraph'), w.seed);
  const base = git(w.seed, 'rev-parse', 'HEAD');
  writeFileSync(join(w.seed, 'hello.txt'), 'hello\n');
  git(w.seed, 'add', '-A');
  git(w.seed, 'commit', '-qm', 'add hello');
  const commit = git(w.seed, 'rev-parse', 'HEAD');
  const patch = join(w.root, 'hello.patch');
  writeFileSync(patch, git(w.seed, 'diff', base, commit) + '\n');
  const issue = join(w.root, 'issue.md');
  writeFileSync(issue, 'Add hello\n\nSay hello in a file.\n');
  const input = { case: 'hello', arm: 'human' };
  const ids = [
    await writeImportedRun(i, commit, { version: '0.0.1', issue, input }),
    await writeImportedRun(i, commit, { version: '0.0.1', issue, input }),
    await writeImportedRun(i, patch, { version: '0.0.1', from: base }),
  ];
  expect(new Set(ids).size).toBe(3);
  const origin = join(i.tracker, 'origin.git');
  for (const id of ids)
    expect(git(w.root, '--git-dir', origin, 'diff', '--name-only', base, `refs/agentgraph/runs/${id}`)).toBe(
      'hello.txt'
    );
  const [records, live] = await Effect.runPromise(
    Effect.flatMap(Store, s => Effect.all([s.listRecords(), s.list()])).pipe(Effect.provide(fileStore(i.data)))
  );
  expect(live).toEqual([]);
  const first = records.find(r => r.id === ids[0]);
  expect(first).toMatchObject({ status: 'done', startCommit: base, title: 'Add hello', body: 'Say hello in a file.' });
  expect(first).not.toHaveProperty('issue');
  expect(getRunOrigin(first?.meta)).toEqual({ plugin: 'agi', version: '0.0.1', job: 'import', input });
  await expect(writeImportedRun(i, patch, { version: '0.0.1', from: commit })).rejects.toThrow();
}, 30_000);

it('serves an imported run in the studio run list and on its own page', async () => {
  const w = seeded('import-api', { 'README.md': 'hi\n' });
  dirs.push(w.root);
  const i = await ensureInstance(join(w.root, 'agentgraph'), w.seed);
  const id = await writeImportedRun(i, 'HEAD', { version: '0.0.1', from: 'HEAD' });
  const ask = serveStudio(i.data);
  const list = await ask('/');
  expect(list).toMatchObject({
    status: 200,
    body: [{ run: { id, workflow: 'import' }, usd: 0, urls: [] }],
  });
  expect((list.body as object[])[0]).not.toHaveProperty('trace');
  expect((list.body as object[])[0]).not.toHaveProperty('checks');
  expect((list.body as { run: object }[])[0]!.run).not.toHaveProperty('startCommit');
  const one = await ask(`/${id}`);
  expect(one).toMatchObject({
    status: 200,
    body: {
      run: { id, status: 'done', startCommit: expect.any(String) },
      usd: 0,
      urls: [],
      trace: [{ saved: { id } }],
    },
  });
  expect(Object.keys(one.body as object)).not.toEqual(expect.arrayContaining(['trail']));
  expect(Object.keys(one.body as object)).not.toEqual(expect.arrayContaining(['checks']));
  mkdirSync(join(i.data, 'broken'));
  writeFileSync(join(i.data, 'broken', 'run.json'), '{');
  const broken = await ask('/');
  expect(broken.status).toBe(500);
  expect(broken.body).toEqual({ error: expect.stringMatching(/.+/) });
}, 30_000);

const run = (id: string, workflow: string, started: string) => ({
  id,
  workflow,
  issue: 7,
  title: 'Fix it',
  body: `body of ${id}`,
  step: 'implement',
  status: 'done' as const,
  tries: 0,
  rounds: {},
  sessions: { implement: { id: 's', home: '/h' } },
  started,
});
const check = (at: string, step: string, name: string, pass: boolean, extra: object = {}) => ({
  at,
  step,
  check: { check: name, pass, ms: 1, findings: `${name} at ${at}`, ...extra },
  version: 'v',
  usd: 0,
  used: { peak: 1, cpu: 1 },
});

it('serves verdicts of one check at one step lazily, and an issue body once on its newest run', async () => {
  const data = tmp('studio-api');
  dirs.push(data);
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.put(run('old', 'issue', '2026-11-01T00:00:00Z'));
      yield* store.put(run('new', 'issue', '2026-11-02T00:00:00Z'));
      yield* store.put(run('other', 'crosscheck', '2026-11-03T00:00:00Z'));
      yield* store.addChecks(
        'old',
        check('2026-11-01T01:00:00Z', 'implement', 'review', true, { empty: true }),
        check('2026-11-01T02:00:00Z', 'review', 'review', false),
        check('2026-11-01T03:00:00Z', 'implement', 'lint', false)
      );
      yield* store.addChecks(
        'new',
        check('2026-11-02T01:00:00Z', 'implement', 'review', false),
        { ...check('2026-11-02T01:00:00Z', 'implement', 'review', false), item: 'a.ts' },
        { ...check('2026-11-02T01:00:00Z', 'implement', 'review', true), item: 'b.ts' }
      );
      yield* store.addChecks('other', check('2026-11-03T01:00:00Z', 'implement', 'review', false));
    }).pipe(Effect.provide(fileStore(data)))
  );
  const ask = serveStudio(data);
  const verdicts = await ask('?fixture=sandbox/issue&step=implement&check=review', '/api/verdicts');
  expect(verdicts).toEqual({
    status: 200,
    body: [
      {
        run: 'new',
        issue: 7,
        at: '2026-11-02T01:00:00Z',
        pass: false,
        empty: false,
        findings: 'review at 2026-11-02T01:00:00Z',
        items: 2,
        failed: 1,
      },
      {
        run: 'old',
        issue: 7,
        at: '2026-11-01T01:00:00Z',
        pass: true,
        empty: true,
        findings: 'review at 2026-11-01T01:00:00Z',
        items: 0,
        failed: 0,
      },
    ],
  });
  expect((await ask('?fixture=sandbox/issue&step=review&check=lint', '/api/verdicts')).body).toEqual([]);
  expect((await ask('?fixture=sandbox/issue&step=implement', '/api/verdicts')).status).toBe(400);
  const list = (await ask('/')).body as { run: { id: string; body?: string; sessions?: object } }[];
  expect(list.filter(r => r.run.body !== undefined).map(r => [r.run.id, r.run.body])).toEqual([
    ['other', 'body of other'],
  ]);
  expect(list.every(r => r.run.sessions === undefined)).toBe(true);
  expect((await ask('/old')).body).toMatchObject({
    run: { ...run('old', 'issue', '2026-11-01T00:00:00Z') },
  });
});
