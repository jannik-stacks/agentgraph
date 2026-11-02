import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chunk, Effect, Stream } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { readJsonl } from '../bin/resume.ts';
import { writeIdleRunsCompressed, fileStore, pruneLogs, Store } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('compresses only idle ended runs, reads them as before, and unpacks on the next line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-compress-'));
  dirs.push(dir);
  const store = <A, E>(use: (s: Store['Type']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Store, use).pipe(Effect.provide(fileStore(dir))));
  const log = await store(s => s.log('lint: 1 error', false));
  const old = new Date(Date.now() - 30 * 86_400_000);
  const line = (step: string) => ({ at: old.toISOString(), step, saved: { step } });
  for (const [id, ended, touched] of [
    ['idle', true, old],
    ['recent', true, new Date()],
    ['open', false, old],
  ] as const) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'run.json'), JSON.stringify({ id, ...(ended && { ended: old.toISOString() }) }));
    writeFileSync(join(dir, id, 'trace.jsonl'), `${JSON.stringify(line('a'))}\n`);
    writeFileSync(join(dir, id, 'checks.jsonl'), `${JSON.stringify({ check: 'lint', log })}\n`);
    for (const file of ['trace.jsonl', 'checks.jsonl']) utimesSync(join(dir, id, file), touched, touched);
  }

  await writeIdleRunsCompressed(dir, 14);
  expect(readdirSync(join(dir, 'idle')).toSorted()).toEqual(['checks.jsonl.zst', 'run.json', 'trace.jsonl.zst']);
  expect(readdirSync(join(dir, 'recent'))).toContain('trace.jsonl');
  expect(readdirSync(join(dir, 'open'))).toContain('trace.jsonl');
  const read = () => store(s => Effect.map(Stream.runCollect(s.read('idle')), Chunk.toArray));
  expect(await read()).toEqual([line('a')]);
  expect(await store(s => s.readChecks('idle'))).toEqual([{ check: 'lint', log }]);
  expect(readJsonl(join(dir, 'idle', 'trace.jsonl'))).toEqual([line('a')]);
  rmSync(join(dir, 'recent', 'checks.jsonl'));
  rmSync(join(dir, 'open', 'checks.jsonl'));
  expect(await pruneLogs(dir, true)).toEqual({ files: 0, bytes: 0 });

  await store(s => s.trace('idle', line('b')));
  expect(existsSync(join(dir, 'idle', 'trace.jsonl.zst'))).toBe(false);
  expect(await read()).toEqual([line('a'), line('b')]);
});
