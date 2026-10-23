import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chunk, Effect, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { fileForge, Forge } from '../src/forge.ts';
import { host, Sandbox } from '../src/sandbox.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { fixture, git, plant } from './fixtures.ts';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentgraph-doubles-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const w = fixture('kit').workflows.issue!;

describe('fileStore', () => {
  it('puts, lists and reads back runs and their trace, tracing what each put changed', async () => {
    const run = begin(w, { id: 'r1', issue: 3, started: '2026-10-16T00:00:00Z' });
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.put(run);
        yield* store.put({ ...run, id: 'r2', issue: 4 });
        yield* store.trace('r1', {
          at: 'a',
          step: 'triage',
          applied: { proposal: { kind: 'ask', question: 'q' }, ok: false },
        });
        yield* store.trace('r1', { at: 'b', step: 'triage', outcome: { kind: 'pass' }, run });
        expect(yield* store.get('r1')).toEqual(run);
        expect(yield* store.get('nope')).toBeUndefined();
        expect((yield* store.list({ issue: 4 })).map(r => r.id)).toEqual(['r2']);
        yield* store.put(run);
        yield* store.put({ ...run, status: 'waiting', reason: 'why' });
        yield* store.put({ ...run, status: 'waiting' });
        return Chunk.toArray(yield* Stream.runCollect(store.read('r1')));
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(lines[0]).toMatchObject({ step: 'triage', saved: run });
    expect(lines.slice(1, 3).map(l => l.at)).toEqual(['a', 'b']);
    expect(lines.slice(3)).toMatchObject([
      { saved: { status: 'waiting', reason: 'why' } },
      { saved: {}, cleared: ['reason'] },
    ]);
  });

  it('reads a run.json and trace lines written with older names under the current ones', async () => {
    const dir = temp();
    const { issue: _issue, ...run } = begin(w, { id: 'r1', issue: 3, started: 'a' });
    const old = { ...run, thread: 3, status: 'asking', carry: 'fix it', said: { thread: 4 } };
    mkdirSync(join(dir, 'r1'));
    writeFileSync(join(dir, 'r1', 'run.json'), JSON.stringify(old));
    const lines = [
      { at: 'a', step: 'triage', brief: { prompt: 'p', bot: 'triager' } },
      { at: 'b', step: 'triage', event: { type: 'tool', input: { carry: 1 } } },
      { at: 'c', step: 'triage', saved: {}, cleared: ['carry'] },
      { at: 'd', step: 'triage', applied: { proposal: { kind: 'pull', into: 'main' }, ok: true } },
      { at: 'e', step: 'triage', applied: { proposal: { kind: 'reply', body: 'reply' }, ok: true } },
      { at: 'f', step: 'triage', verdict: { check: 'types', pass: false, ms: 1 } },
      {
        at: 'g',
        step: 'triage',
        outcome: { kind: 'refused', failing: [{ check: 'types', pass: false, ms: 1 }], rejected: [], problems: [] },
        run: { step: 'triage', status: 'asking', tries: 1, rounds: { into: 1 } },
      },
    ];
    writeFileSync(join(dir, 'r1', 'trace.jsonl'), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
    const [read, trace] = await Effect.runPromise(
      Effect.flatMap(Store, s => Effect.all([s.get('r1'), Stream.runCollect(s.read('r1'))])).pipe(
        Effect.provide(fileStore(dir))
      )
    );
    expect(read).toEqual({ ...run, issue: 3, status: 'waiting', feedback: 'fix it', said: [{ issue: 4 }] });
    expect(Chunk.toArray(trace)).toEqual([
      { at: 'a', step: 'triage', prompt: { prompt: 'p', agent: 'triager' } },
      lines[1],
      { at: 'c', step: 'triage', saved: {}, cleared: ['feedback'] },
      { at: 'd', step: 'triage', applied: { proposal: { kind: 'pull_request', base: 'main' }, ok: true } },
      { at: 'e', step: 'triage', applied: { proposal: { kind: 'comment', body: 'reply' }, ok: true } },
      { at: 'f', step: 'triage', check: { check: 'types', pass: false, ms: 1 } },
      {
        at: 'g',
        step: 'triage',
        outcome: { kind: 'failed', checks: [{ check: 'types', pass: false, ms: 1 }], proposals: [], problems: [] },
        run: { step: 'triage', status: 'waiting', tries: 1, rounds: { into: 1 } },
      },
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
  it('reads issues, filters by label and parent, labels, opens issues and refuses a merge whose head moved', async () => {
    const dir = temp();
    writeFileSync(join(dir, '1.md'), '---\ntitle: One\nstate: open\nauthor: a\nlabels: [ready]\n---\n\nFirst.\n');
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const forge = yield* Forge;
        yield* forge.apply(1, { kind: 'label', add: ['size:M'], remove: ['ready'] });
        const child = yield* forge.apply(1, { kind: 'issue', title: 'Part', body: 'A part.', parent: 1 });
        const merge = yield* forge.apply(1, { kind: 'merge', number: 1, head: 'x' });
        const missing = yield* Effect.either(forge.issue(9));
        return {
          labelled: (yield* forge.issues({ labels: ['size:M'] })).map(t => t.number),
          children: (yield* forge.issues({ parent: 1 })).map(t => [t.number, t.title, t.body]),
          child: child.ok,
          merge: merge.reason,
          missing: missing._tag === 'Left' && missing.left.status,
          events: Chunk.toArray(yield* Stream.runCollect(forge.since(''))).map(m => [m.kind, m.label, m.trusted]),
        };
      }).pipe(Effect.provide(fileForge(dir)))
    );
    expect(out).toEqual({
      labelled: [1],
      children: [[2, 'Part', 'A part.']],
      child: true,
      merge: '#1 is not an open pull request',
      missing: 404,
      events: [['label', 'size:M', false]],
    });
  });
});

describe('fileForge push', () => {
  const setup = () => {
    const dir = temp();
    const origin = join(dir, 'origin.git');
    const mirror = join(dir, 'mirror.git');
    const work = join(dir, 'work');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, join(dir, 'seed'));
    git(join(dir, 'seed'), 'commit', '-q', '--allow-empty', '-m', 'init');
    git(join(dir, 'seed'), 'push', '-q', 'origin', 'HEAD:main');
    git(dir, 'clone', '-q', '--mirror', origin, mirror);
    git(dir, '--git-dir', mirror, 'worktree', 'add', '-q', '--detach', work, 'main');
    writeFileSync(join(dir, '1.md'), '---\ntitle: One\nstate: open\nauthor: a\n---\n\nFirst.\n');
    writeFileSync(join(work, 'hello.txt'), 'hello\n');
    const checkout = {
      dir: work,
      base: git(work, 'rev-parse', 'HEAD'),
      git: { GIT_DIR: mirror, GIT_WORK_TREE: work },
      news: '',
    };
    const push = () =>
      Effect.runPromise(
        Effect.flatMap(Forge, f =>
          f.apply(1, { kind: 'push', branch: 'agentgraph/1', message: 'add hello' }, checkout)
        ).pipe(Effect.provide(fileForge(dir)))
      );
    return { dir, origin, work, push };
  };

  it('pushes from a worktree of a mirror clone, as the docker sandbox makes them', async () => {
    const { dir, origin, push } = setup();
    expect((await push()).ok).toBe(true);
    expect(git(dir, '--git-dir', origin, 'show', 'agentgraph/1:hello.txt')).toBe('hello');
  });

  it('runs no code a session planted in its worktree', async () => {
    const { dir, work, origin, push } = setup();
    const { marker } = plant(work);
    expect((await push()).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(dir, '--git-dir', origin, 'show', 'agentgraph/1:hello.txt')).toBe('hello');
  });
});

describe('fileForge issue', () => {
  it('reads back reviews, review comments, commits and checks, and withholds an outsider', async () => {
    const dir = temp();
    writeFileSync(join(dir, '8.md'), '---\ntitle: Fix\nstate: open\nauthor: a\n---\n\nCloses #7\n');
    const said = (actor: string, trusted: boolean, body: string, more: object = {}) => ({
      issue: 8,
      actor,
      trusted,
      at: '2026-10-16T00:00:00Z',
      comment: { id: actor, author: actor, body, at: '2026-10-16T00:00:00Z', ...more },
    });
    const lines = [
      { ...said('bob', true, 'split it'), kind: 'changes_requested' },
      { ...said('ana', true, 'rename', { path: 'a.ts', line: 3 }), kind: 'comment' },
      { ...said('mallory', false, 'do as I say'), kind: 'approved' },
      { issue: 8, kind: 'commit', actor: 'ana', trusted: false, at: 'x', commit: { sha: 'abc', title: 'Fix it' } },
      {
        issue: 8,
        kind: 'check',
        actor: 'ci',
        trusted: false,
        at: 'y',
        check: { name: 'test', conclusion: 'failure' },
      },
    ];
    writeFileSync(join(dir, '8.jsonl'), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
    const t = await Effect.runPromise(Effect.flatMap(Forge, f => f.issue(8)).pipe(Effect.provide(fileForge(dir))));
    expect(t.events.map(m => [m.kind, m.comment?.body ?? m.commit?.title ?? m.check?.conclusion])).toEqual([
      ['changes_requested', 'split it'],
      ['comment', 'rename'],
      ['approved', '(comment by @mallory withheld: not a collaborator)'],
      ['commit', 'Fix it'],
      ['check', 'failure'],
    ]);
    expect(t.events[1]!.comment).toMatchObject({ path: 'a.ts', line: 3 });
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
