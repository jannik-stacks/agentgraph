import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chunk, Effect, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { fileForge, Forge } from '../src/forge.ts';
import { host, Sandbox } from '../src/sandbox.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { fixture } from './fixtures.ts';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-core-doubles-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const w = fixture('acme-app').workflows.issue!;

describe('fileStore', () => {
  it('puts, lists and reads back runs and their trace, tracing what each put changed', async () => {
    const run = begin(w, { id: 'r1', thread: 3, started: '2026-10-16T00:00:00Z' });
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.put(run);
        yield* store.put({ ...run, id: 'r2', thread: 4 });
        yield* store.trace('r1', {
          at: 'a',
          step: 'triage',
          applied: { proposal: { kind: 'ask', question: 'q' }, ok: false },
        });
        yield* store.trace('r1', { at: 'b', step: 'triage', outcome: { kind: 'pass' }, run });
        expect(yield* store.get('r1')).toEqual(run);
        expect(yield* store.get('nope')).toBeUndefined();
        expect((yield* store.list({ thread: 4 })).map(r => r.id)).toEqual(['r2']);
        yield* store.put(run);
        yield* store.put({ ...run, status: 'asking', reason: 'why' });
        yield* store.put({ ...run, status: 'asking' });
        return Chunk.toArray(yield* Stream.runCollect(store.read('r1')));
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(lines[0]).toMatchObject({ step: 'triage', saved: run });
    expect(lines.slice(1, 3).map(l => l.at)).toEqual(['a', 'b']);
    expect(lines.slice(3)).toMatchObject([
      { saved: { status: 'asking', reason: 'why' } },
      { saved: {}, cleared: ['reason'] },
    ]);
  });

  it('holds a lock for its scope and refuses a second holder', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const second = yield* Effect.scoped(
          Effect.zipRight(store.lock('run'), Effect.either(Effect.scoped(store.lock('run'))))
        );
        const again = yield* Effect.either(Effect.scoped(store.lock('run')));
        return { second: second._tag, again: again._tag };
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(result).toEqual({ second: 'Left', again: 'Right' });
  });
});

describe('fileForge', () => {
  it('reads threads, filters by label and parent, labels, opens issues and refuses a merge whose head moved', async () => {
    const dir = temp();
    writeFileSync(join(dir, '1.md'), '---\ntitle: One\nstate: open\nauthor: a\nlabels: [ready]\n---\n\nFirst.\n');
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const forge = yield* Forge;
        yield* forge.apply(1, { kind: 'label', add: ['size:M'], remove: ['ready'] });
        const child = yield* forge.apply(1, { kind: 'issue', title: 'Part', body: 'A part.' });
        const merge = yield* forge.apply(1, { kind: 'merge', number: 1, head: 'x' });
        const missing = yield* Effect.either(forge.thread(9));
        return {
          labelled: (yield* forge.threads({ labels: ['size:M'] })).map(t => t.number),
          children: (yield* forge.threads({ parent: 1 })).map(t => [t.number, t.title, t.body]),
          child: child.ok,
          merge: merge.reason,
          missing: missing._tag === 'Left' && missing.left.status,
          messages: Chunk.toArray(yield* Stream.runCollect(forge.since(''))).map(m => [m.kind, m.label, m.trusted]),
        };
      }).pipe(Effect.provide(fileForge(dir)))
    );
    expect(out).toEqual({
      labelled: [1],
      children: [[2, 'Part', 'A part.']],
      child: true,
      merge: '#1 is not an open pull request',
      missing: 404,
      messages: [['label', 'size:M', false]],
    });
  });
});

describe('host', () => {
  it('runs a command in a dir, streams its lines and times out', async () => {
    const dir = temp();
    const command = { cmd: 'sh', dir, env: { WHO: 'bot' }, network: 'none' as const, minutes: 1 };
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const exit = yield* sandbox.exec({ ...command, args: ['-c', 'echo "$WHO"; exit 3'] });
        const lines = yield* Stream.runCollect(sandbox.lines({ ...command, args: ['-c', 'echo a; echo b'] }));
        const late = yield* Effect.either(sandbox.exec({ ...command, args: ['-c', 'sleep 5'], minutes: 0.001 }));
        return { exit, lines: Chunk.toArray(lines), late: late._tag === 'Left' && late.left.reason };
      }).pipe(Effect.scoped, Effect.provide(host(dir)))
    );
    expect(out).toEqual({ exit: { code: 3, output: 'bot\n' }, lines: ['a', 'b'], late: 'timeout' });
  });
});
