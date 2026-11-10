import { Effect, Stream } from 'effect';
import { expect, it, vi } from 'vitest';
import { fileStore, readChecksSync, readRunSync, Store } from '../src/store.ts';
import { tmp, write } from './kit.ts';

const run = {
  id: 'r1',
  workflow: 'w',
  step: 's',
  status: 'running',
  tries: 0,
  rounds: {},
  sessions: {},
  started: 'now',
};
const at = { at: '2026-11-01T00:00:00Z', step: 's' };

const withStore = <A>(dir: string, f: (store: Store['Service']) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.flatMap(Store, f).pipe(Effect.provide(fileStore(dir))));

it('decodes a stored run and names the file when it does not decode', async () => {
  const dir = tmp('store-decode');
  write(dir, {
    'r1/run.json': JSON.stringify(run),
    'r2/run.json': JSON.stringify({ ...run, id: 'r2', status: 'asking' }),
  });
  expect(readRunSync(dir, 'r1')).toEqual(run);
  await expect(withStore(dir, s => s.getRecord('r2'))).rejects.toThrow(/r2\/run\.json.*status/s);
  expect(() => readRunSync(dir, 'r2')).toThrow(/r2\/run\.json/);
});

it('names the file and row of a trace or check line that does not decode, and skips an incomplete last row', async () => {
  const dir = tmp('store-decode');
  const outcome = { ...at, outcome: { kind: 'pass' }, run: { step: 's', status: 'running', tries: 0, rounds: {} } };
  const check = { ...at, check: { check: 'c', pass: true, ms: 1 }, version: 'v', usd: 0 };
  write(dir, {
    'r1/run.json': JSON.stringify(run),
    'r1/trace.jsonl': `${JSON.stringify(outcome)}\n${JSON.stringify({ ...at, verdict: {} })}\n`,
    'r1/checks.jsonl': `${JSON.stringify(check)}\n{"at":`,
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(readChecksSync(dir, 'r1')).toEqual([check]);
  expect(error).toHaveBeenCalledWith(expect.stringMatching(/skipped incomplete JSONL row at line 2/));
  await expect(withStore(dir, s => Stream.runCollect(s.read('r1')))).rejects.toThrow(/r1\/trace\.jsonl:2/);
});
