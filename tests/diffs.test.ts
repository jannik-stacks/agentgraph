import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api } from '../src/api.ts';
import { openStore, type Outcome } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';
import { commit, git, sourceRepo, temp } from './kit.ts';

const hubDir = join(import.meta.dirname, '..', 'examples', 'hub');

const event = (id: string, number: number): BotEvent => ({
  id,
  ts: '2026-10-12T00:00:00.000Z',
  source: 'local',
  trigger: 'issue_comment',
  repo: 'local/origin',
  number,
  actor: { login: 'octocat', association: 'OWNER' },
});

const outcome = (results: Outcome['results'], pr?: number) =>
  ({ proposals: [], accepted: [], rejected: [], results, applied: true, ...(pr && { pr }) }) as unknown as Outcome;

/** A data directory with a bare `origin.git`: `main`, a `bothub/7` branch two files ahead, and its merge request. */
const setup = async () => {
  const { dir: work, main } = sourceRepo();
  git(work, 'checkout', '-qb', 'bothub/7');
  writeFileSync(join(work, 'big.txt'), `${'line\n'.repeat(30000)}`);
  const head = commit(work, { 'README.md': 'main\nchanged\n', 'new.ts': 'export const a = 1;\n' });
  git(work, 'checkout', '-q', 'main');
  const data = temp('diffs');
  const origin = join(data, 'origin.git');
  git(data, 'clone', '-q', '--bare', work, origin);
  const store = openStore(data);
  const opened = await store.create(
    { workflow: 'issue', job: 'implement', bot: 'b', event: event('e7', 7), status: 'succeeded', base: main },
    'r-implement'
  );
  await store.saveOutcome(opened.id, outcome([{ kind: 'push', status: 'applied', sha: head }], 1));
  await store.create(
    { workflow: 'issue', job: 'triage', bot: 'b', event: event('e7', 7), status: 'succeeded' },
    'r-triage'
  );
  appendFileSync(
    join(data, 'pulls.jsonl'),
    `${JSON.stringify({ ts: 'x', number: 1, op: 'open', title: 'Seven', body: 'Closes #7', branch: 'bothub/7', into: 'main', job: 'issue/implement', event: 'e7', sha: head })}\n`
  );
  const handle = api({ hubDir, store, pollMs: 10 });
  const get = async (path: string) => {
    const response = await handle(new Request(`http://studio${path}`));
    return { status: response.status, body: await response.json() };
  };
  return { data, origin, store, main, head, get };
};

describe('diff routes', () => {
  it('GET /api/pulls lists requests with the opening run, mergeability and per-file counts', async () => {
    const { get, main, head } = await setup();
    const { body } = await get('/api/pulls');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      number: 1,
      title: 'Seven',
      branch: 'bothub/7',
      into: 'main',
      state: 'open',
      mergeable: true,
      run: 'r-implement',
      issue: 7,
      base: main,
      head,
    });
    expect(body[0].files).toEqual([
      { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
      { path: 'big.txt', status: 'added', additions: 30000, deletions: 0 },
      { path: 'new.ts', status: 'added', additions: 1, deletions: 0 },
    ]);
  });

  it('GET /api/pulls/:n/diff answers each file with its hunks and marks files over the cap', async () => {
    const { get } = await setup();
    const { body } = await get('/api/pulls/1/diff');
    const byPath = Object.fromEntries(body.files.map((f: { path: string }) => [f.path, f]));
    expect(byPath['README.md'].patch).toBe('@@ -1 +1,2 @@\n main\n+changed');
    expect(byPath['new.ts'].patch).toBe('@@ -0,0 +1 @@\n+export const a = 1;');
    expect(byPath['big.txt']).toMatchObject({ additions: 30000, tooLarge: true });
    expect(byPath['big.txt'].patch).toBeUndefined();
    expect((await get('/api/pulls/9/diff')).status).toBe(404);
  });

  it('leaves out changes made only of whitespace with ?whitespace=hide', async () => {
    const work = temp('ws');
    git(work, 'init', '-q', '-b', 'main');
    const base = commit(work, { 'a.ts': 'if (x) {\ny();\n}\n', 'b.ts': 'one\ntwo\n' });
    const head = commit(work, { 'a.ts': 'if (x) {\n  y();\n}\n', 'b.ts': 'one  \nthree\n' });
    const data = temp('ws-data');
    git(data, 'clone', '-q', '--bare', work, join(data, 'origin.git'));
    const store = openStore(data);
    await store.create({ workflow: 'w', job: 'j', bot: 'b', event: event('e1', 1), status: 'succeeded', base }, 'r-ws');
    await store.saveOutcome('r-ws', outcome([{ kind: 'push', status: 'applied', sha: head }]));
    const handle = api({ hubDir, store, pollMs: 10 });
    const read = async (path: string) => (await handle(new Request(`http://studio${path}`))).json();

    const shown = await read('/api/runs/r-ws/diff');
    expect(shown.files.map((f: { path: string }) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(shown.hiddenFiles).toBeUndefined();

    const hidden = await read('/api/runs/r-ws/diff?whitespace=hide');
    expect(hidden.hiddenFiles).toBe(1);
    expect(hidden.files).toEqual([
      expect.objectContaining({
        path: 'b.ts',
        additions: 1,
        deletions: 1,
        patch: '@@ -1,2 +1,2 @@\n one  \n-two\n+three',
      }),
    ]);
  });

  it('measures a merged request from where its target was when it merged', async () => {
    const { get, data, origin, main, head } = await setup();
    git(data, '--git-dir', origin, 'update-ref', 'refs/heads/main', head);
    appendFileSync(
      join(data, 'pulls.jsonl'),
      `${JSON.stringify({ ts: 'x', number: 1, op: 'merge', sha: head, 'into-sha': main })}\n`
    );
    const [pull] = (await get('/api/pulls')).body;
    expect(pull).toMatchObject({ state: 'merged', base: main });
    expect(pull.mergeable).toBeUndefined();
    expect(pull.files).toHaveLength(3);
  });

  it('GET /api/runs/:id/diff answers what a run pushed, a parked commit, or nothing', async () => {
    const { get, store, origin, head } = await setup();
    const pushed = (await get('/api/runs/r-implement/diff')).body;
    expect(pushed).toMatchObject({ commit: head, head });
    expect(pushed.files.map((f: { path: string }) => f.path)).toEqual(['README.md', 'big.txt', 'new.ts']);

    expect((await get('/api/runs/r-triage/diff')).body).toMatchObject({ files: [] });
    expect((await get('/api/runs/nope/diff')).status).toBe(404);

    const work = temp('park');
    git(work, 'clone', '-q', origin, '.');
    git(work, 'checkout', '-q', 'bothub/7');
    writeFileSync(join(work, 'parked.txt'), 'later\n');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'bothub: implement (parked)');
    git(work, 'push', '-q', 'origin', 'bothub/7');
    const parked = git(work, 'rev-parse', 'HEAD');
    await store.create(
      {
        workflow: 'issue',
        job: 'implement',
        bot: 'b',
        event: event('e8', 7),
        status: 'succeeded',
        closure: 'blocked',
        parked: 'bothub/7',
        startedAt: '2000-01-01T00:00:00.000Z',
      },
      'r-parked'
    );
    const diff = (await get('/api/runs/r-parked/diff')).body;
    expect(diff).toMatchObject({ commit: parked, base: head });
    expect(diff.files).toEqual([
      { path: 'parked.txt', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+later' },
    ]);
  });
});
