import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { type checkLogs, fileStore, Store } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const data = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-logs-'));
  dirs.push(dir);
  return dir;
};

/** Logs one passing output twice and one failing output under `logs`; answers the refs, their texts and the files kept. */
const logged = (logs: (typeof checkLogs)[number]) => {
  const dir = data();
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      const refs = [
        yield* store.log('ok\n'.repeat(1000), true),
        yield* store.log('ok\n'.repeat(1000), true),
        yield* store.log('lint: 1 error', false),
      ];
      const texts = yield* Effect.forEach(refs, r => (r ? store.logOf(r.hash) : Effect.succeed(undefined)));
      const files = readdirSync(dir).includes('logs') ? readdirSync(join(dir, 'logs')).length : 0;
      return { refs, texts, files };
    }).pipe(Effect.provide(fileStore(dir, logs)))
  );
};

describe('check logs', () => {
  it('keeps every output once, gzipped, and resolves each ref to the full text', async () => {
    const { refs, texts, files } = await logged('all');
    expect(refs[0]).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 3000 });
    expect(refs[1]).toEqual(refs[0]);
    expect(texts).toEqual(['ok\n'.repeat(1000), 'ok\n'.repeat(1000), 'lint: 1 error']);
    expect(files).toBe(2);
  });

  it('keeps only failing output under failed', async () => {
    const { refs, texts, files } = await logged('failed');
    expect(refs.slice(0, 2)).toEqual([undefined, undefined]);
    expect(texts[2]).toBe('lint: 1 error');
    expect(files).toBe(1);
  });

  it('keeps nothing under off', async () => {
    const { refs, files } = await logged('off');
    expect(refs).toEqual([undefined, undefined, undefined]);
    expect(files).toBe(0);
  });

  it('answers nothing for a hash it does not hold or that is not one', async () => {
    const dir = data();
    const read = (hash: string) =>
      Effect.runPromise(Effect.flatMap(Store, s => s.logOf(hash)).pipe(Effect.provide(fileStore(dir))));
    expect(await read('0'.repeat(64))).toBeUndefined();
    expect(await read('../run.json')).toBeUndefined();
  });
});
