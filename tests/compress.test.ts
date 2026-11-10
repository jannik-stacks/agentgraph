import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { readJsonl } from '../bin/resume.ts';
import { writeIdleRunsCompressed, fileStore, pruneLogs, Store } from '../src/store.ts';
import { makeRun } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('compresses only idle ended runs, reads them as before, and unpacks on the next line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-compress-'));
  dirs.push(dir);
  const store = <A, E>(use: (s: Store['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Store, use).pipe(Effect.provide(fileStore(dir))));
  const log = await store(s => s.log('lint: 1 error', false));
  const old = new Date(Date.now() - 30 * 86_400_000);
  const line = (step: string) => ({ at: old.toISOString(), step, saved: { step } });
  const check = {
    at: old.toISOString(),
    step: 'a',
    check: { check: 'lint', pass: false, ms: 0 },
    version: 'v1',
    usd: 0,
    log,
  };
  for (const [id, ended, touched] of [
    ['idle', true, old],
    ['recent', true, new Date()],
    ['open', false, old],
  ] as const) {
    mkdirSync(join(dir, id));
    writeFileSync(
      join(dir, id, 'run.json'),
      JSON.stringify(makeRun({ id, ...(ended && { ended: old.toISOString() }) }))
    );
    writeFileSync(join(dir, id, 'trace.jsonl'), `${JSON.stringify(line('a'))}\n`);
    writeFileSync(join(dir, id, 'checks.jsonl'), `${JSON.stringify(check)}\n`);
    for (const file of ['trace.jsonl', 'checks.jsonl']) utimesSync(join(dir, id, file), touched, touched);
  }

  await writeIdleRunsCompressed(dir, 14);
  expect(readdirSync(join(dir, 'idle')).toSorted()).toEqual(['checks.jsonl.zst', 'run.json', 'trace.jsonl.zst']);
  expect(readdirSync(join(dir, 'recent'))).toContain('trace.jsonl');
  expect(readdirSync(join(dir, 'open'))).toContain('trace.jsonl');
  const read = () => store(s => Stream.runCollect(s.read('idle')));
  expect(await read()).toEqual([line('a')]);
  expect(await store(s => s.readChecks('idle'))).toEqual([check]);
  expect(readJsonl(join(dir, 'idle', 'trace.jsonl'))).toEqual([line('a')]);
  rmSync(join(dir, 'recent', 'checks.jsonl'));
  rmSync(join(dir, 'open', 'checks.jsonl'));
  expect(await pruneLogs(dir, true)).toEqual({ files: 0, bytes: 0 });

  await store(s => s.trace('idle', line('b')));
  expect(existsSync(join(dir, 'idle', 'trace.jsonl.zst'))).toBe(false);
  expect(await read()).toEqual([line('a'), line('b')]);
});

it('keeps the whole history when one store appends across repeated compressions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-compress-'));
  dirs.push(dir);
  const layer = fileStore(dir);
  const store = <A, E>(use: (s: Store['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Store, use).pipe(Effect.provide(layer)));
  const old = new Date(Date.now() - 30 * 86_400_000);
  const line = (step: string) => ({ at: old.toISOString(), step, saved: { step } });
  mkdirSync(join(dir, 'run'));
  writeFileSync(join(dir, 'run', 'run.json'), JSON.stringify(makeRun({ id: 'run', ended: old.toISOString() })));
  const traceFile = join(dir, 'run', 'trace.jsonl');
  const appendThenCompress = async (step: string) => {
    await store(s => s.trace('run', line(step)));
    utimesSync(traceFile, old, old);
    await writeIdleRunsCompressed(dir, 14);
    expect(existsSync(`${traceFile}.zst`)).toBe(true);
  };
  await appendThenCompress('a');
  await appendThenCompress('b');
  await appendThenCompress('c');
  expect(await store(s => Stream.runCollect(s.read('run')))).toEqual([line('a'), line('b'), line('c')]);
});
