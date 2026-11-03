import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { ensureInstance, writeImportedRun } from '../src/instance.ts';
import { getRunOrigin } from '../src/meta.ts';
import { fileStore, Store } from '../src/store.ts';
import { seeded } from './fixtures.ts';
import { git } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  const origin = join(i.forge, 'origin.git');
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
