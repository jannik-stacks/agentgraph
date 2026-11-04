import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderTracker, Tracker, writeIssueFile } from '../src/tracker.ts';
import { Sandbox } from '../src/sandbox.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { getRunOrigin } from '../src/meta.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { fixture, plant, seeded } from './fixtures.ts';
import { commit, git } from './kit.ts';

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
  it('preserves owner JSON and refuses changed origin before tracing', async () => {
    const origin = { plugin: 'bench', version: 'v1', job: 'smoke', input: null };
    const meta = { engine: { origin }, bench: { brief: 'unchanged', status: 'asking' } };
    const run = { ...begin(w, { id: 'r1', issue: 3, started: 'now' }), meta };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.put(run);
        const refused = yield* Effect.result(
          store.put({ ...run, meta: { ...meta, engine: { origin: { ...origin, job: 'other' } } } })
        );
        const invalid = yield* Effect.result(store.put({ ...run, meta: { bench: undefined } as never }));
        return {
          refused: refused._tag,
          invalid: invalid._tag,
          run: yield* store.get('r1'),
          trace: yield* Stream.runCollect(store.read('r1')),
        };
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(result).toMatchObject({ refused: 'Failure', invalid: 'Failure', run: { meta } });
    expect(result.trace).toHaveLength(1);
  });

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
        return yield* Stream.runCollect(store.read('r1'));
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(lines[0]).toMatchObject({ step: 'triage', saved: run });
    expect(lines.slice(1, 3).map(l => l.at)).toEqual(['a', 'b']);
    expect(lines.slice(3)).toMatchObject([
      { saved: { status: 'waiting', reason: 'why' } },
      { saved: {}, cleared: ['reason'] },
    ]);
  });

  it('accepts an unchanged origin when JSON object keys have another order', async () => {
    const run = {
      ...begin(w, { id: 'r1', issue: 3, started: 'now' }),
      meta: {
        engine: { origin: { plugin: 'bench', version: 'v1', job: 'smoke', input: { a: 1, b: 2 } } },
      },
    };
    const next = { ...run, meta: { engine: { origin: { ...run.meta.engine.origin, input: { b: 2, a: 1 } } } } };
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.put(run);
        yield* store.put(next);
        return yield* store.get(run.id);
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(saved?.meta).toEqual(next.meta);
  });

  it.each([
    [-0, 0],
    [Object.create(null), {}],
  ])('keeps an origin stable across JSON encoding: %j', async (input, expected) => {
    const run = {
      ...begin(w, { id: 'r1', issue: 3, started: 'now' }),
      meta: { engine: { origin: { plugin: 'bench', version: 'v1', job: 'smoke', input } } },
    };
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.put(run);
        yield* store.put({ ...run, status: 'waiting' });
        return yield* store.get(run.id);
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(saved?.status).toBe('waiting');
    expect(getRunOrigin(saved?.meta)?.input).toEqual(expected);
  });

  it('traces a put before it saves the run, and lists only runs that were saved', async () => {
    const dir = temp();
    const run = begin(w, { id: 'r1', issue: 3, started: '2026-10-16T00:00:00Z' });
    const store = <A, E>(effect: Effect.Effect<A, E, Store>) =>
      Effect.runPromise(effect.pipe(Effect.provide(fileStore(dir))));
    await store(Effect.flatMap(Store, s => s.put(run)));
    chmodSync(join(dir, 'r1'), 0o555);
    const failed = await store(Effect.result(Effect.flatMap(Store, s => s.put({ ...run, status: 'waiting' }))));
    chmodSync(join(dir, 'r1'), 0o755);
    expect(failed._tag).toBe('Failure');
    const lines = await store(Effect.flatMap(Store, s => Stream.runCollect(s.read('r1'))));
    expect(lines.at(-1)).toMatchObject({ saved: { status: 'waiting' } });
    mkdirSync(join(dir, 'r2'));
    writeFileSync(join(dir, 'r2', 'trace.jsonl'), `${JSON.stringify({ at: 'a', step: 'triage', saved: run })}\n`);
    expect((await store(Effect.flatMap(Store, s => s.list()))).map(r => r.id)).toEqual(['r1']);
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
    expect(trace).toEqual([
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
          Effect.andThen(store.lock('run'), Effect.result(Effect.scoped(store.lock('run'))))
        );
        const again = yield* Effect.result(Effect.scoped(store.lock('run')));
        return { second: second._tag, again: again._tag };
      }).pipe(Effect.provide(fileStore(temp())))
    );
    expect(result).toEqual({ second: 'Failure', again: 'Success' });
  });

  it('lets exactly one of many racing stores take over a stale lock', async () => {
    const dir = temp();
    for (let round = 0; round < 10; round++) {
      mkdirSync(join(dir, '.locks'), { recursive: true });
      writeFileSync(join(dir, '.locks', 'run.lock'), `999999999:gone-${round}`);
      const takers = Array.from({ length: 8 }, () =>
        Effect.result(
          Effect.scoped(
            Effect.andThen(
              Effect.flatMap(Store, s => s.lock('run')),
              Effect.sleep('50 millis')
            ).pipe(Effect.provide(fileStore(dir)))
          )
        )
      );
      const taken = await Effect.runPromise(Effect.all(takers, { concurrency: 'unbounded' }));
      expect(taken.filter(t => t._tag === 'Success')).toHaveLength(1);
    }
  });

  it('takes over a stale lock whose last claimer died mid takeover', async () => {
    const dir = temp();
    const lock = join(dir, '.locks', 'run.lock');
    mkdirSync(join(dir, '.locks'), { recursive: true });
    writeFileSync(lock, '999999999:gone');
    writeFileSync(`${lock}.${createHash('sha256').update('999999999:gone').digest('hex')}.next`, '999999998:died');
    const taken = await Effect.runPromise(
      Effect.result(Effect.scoped(Effect.flatMap(Store, s => s.lock('run')))).pipe(Effect.provide(fileStore(dir)))
    );
    expect(taken._tag).toBe('Success');
  });
});

describe('folderTracker', () => {
  it('reads issues, filters by label and parent, labels, opens issues and refuses a merge whose head moved', async () => {
    const dir = temp();
    writeFileSync(join(dir, '1.md'), '---\ntitle: One\nstate: open\nauthor: a\nlabels: [ready]\n---\n\nFirst.\n');
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* Tracker;
        yield* tracker.apply(1, { kind: 'label', add: ['size:M'], remove: ['ready'] });
        const child = yield* tracker.apply(1, { kind: 'issue', title: 'Part', body: 'A part.', parent: 1 });
        const merge = yield* tracker.apply(1, { kind: 'merge', number: 1, head: 'x' });
        const missing = yield* Effect.result(tracker.issue(9));
        return {
          labelled: (yield* tracker.issues({ labels: ['size:M'] })).map(t => t.number),
          children: (yield* tracker.issues({ parent: 1 })).map(t => [t.number, t.title, t.body]),
          child: child.ok,
          merge: merge.reason,
          missing: missing._tag === 'Failure' && missing.failure.status,
          events: (yield* Stream.runCollect(tracker.since(''))).map(m => [m.kind, m.label, m.trusted]),
        };
      }).pipe(Effect.provide(folderTracker(dir)))
    );
    expect(out).toEqual({
      labelled: [1],
      children: [[2, 'Part', 'A part.']],
      child: true,
      merge: '#1 is not an open pull request',
      missing: 404,
      events: [
        ['label', 'ready', true],
        ['label', 'size:M', false],
      ],
    });
  });
});

describe('folderTracker files', () => {
  it('gives issues filed at once their own numbers, and adopts a dropped file once', async () => {
    const dir = temp();
    writeFileSync(join(dir, '1.md'), '---\ntitle: One\nauthor: a\nlabels: [ready]\n---\n');
    const numbers = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* Tracker;
        const [, ...events] = yield* Effect.all(
          [
            Effect.forEach([1, 2, 3], () => tracker.apply(1, { kind: 'issue', title: 'Part', body: '' }), {
              concurrency: 'unbounded',
            }),
            ...[1, 2, 3].map(() => Effect.map(tracker.issue(1), t => t.events.length)),
          ],
          { concurrency: 'unbounded' }
        );
        const human = yield* Effect.promise(() =>
          Promise.all([1, 2].map(() => writeIssueFile(dir, { title: 'Two', author: 'a', labels: [] }, '')))
        );
        return { events, human, all: (yield* tracker.issues()).map(t => t.number) };
      }).pipe(Effect.provide(folderTracker(dir)))
    );
    expect(numbers.events).toEqual([1, 1, 1]);
    expect(numbers.all.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(readdirSync(dir).filter(f => !/^\d+\.(md|jsonl)$/.test(f))).toEqual([]);
  });
});

describe('folderTracker push', () => {
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
        Effect.flatMap(Tracker, f =>
          f.apply(1, { kind: 'push', branch: 'agentgraph/1', message: 'add hello' }, checkout)
        ).pipe(Effect.provide(folderTracker(dir)))
      );
    return { dir, origin, work, checkout, push };
  };

  it('pushes from a worktree of a mirror clone, as the docker sandbox makes them', async () => {
    const { dir, origin, push } = setup();
    expect((await push()).ok).toBe(true);
    expect(git(dir, '--git-dir', origin, 'show', 'agentgraph/1:hello.txt')).toBe('hello');
  });

  it.each([false, true])('names held files and reports whether anything was pushed (held only: %s)', async only => {
    const { dir, origin, work, push } = setup();
    mkdirSync(join(work, '.github/workflows'), { recursive: true });
    writeFileSync(join(work, '.github/workflows/x.yml'), 'on: push\n');
    if (only) rmSync(join(work, 'hello.txt'));
    const applied = await push();
    expect(applied).toMatchObject({
      ok: false,
      held: ['.github/workflows/x.yml'],
      reason: expect.stringContaining(only ? 'Nothing pushed' : 'Not pushed'),
    });
    expect(Boolean(applied.url)).toBe(!only);
    expect(git(dir, '--git-dir', origin, 'ls-tree', '-r', '--name-only', only ? 'main' : 'agentgraph/1')).toBe(
      only ? '' : 'hello.txt'
    );
    expect(readFileSync(join(work, '.github/workflows/x.yml'), 'utf8')).toBe('on: push\n');
  });

  it('reports each held path once while later mixed and held-only pushes succeed', async () => {
    const { dir, origin, work, checkout } = setup();
    mkdirSync(join(work, '.github/workflows'), { recursive: true });
    writeFileSync(join(work, '.github/workflows/x.yml'), 'on: push\n');
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* Tracker;
        const proposal = { kind: 'push', branch: 'agentgraph/1', message: 'Add hello' } as const;
        const first = yield* tracker.apply(1, proposal, checkout);
        writeFileSync(join(work, 'other.txt'), 'other\n');
        const second = yield* tracker.apply(1, proposal, checkout);
        return [first, second, yield* tracker.apply(1, proposal, checkout)];
      }).pipe(Effect.provide(folderTracker(dir)))
    );
    expect(results.map(r => r.ok)).toEqual([false, true, true]);
    expect(results.map(r => r.held)).toEqual(Array.from({ length: 3 }, () => ['.github/workflows/x.yml']));
    expect(results[1]!.url).toContain('agentgraph/1@');
    expect(results[2]!.url).toBeUndefined();
    expect(results.slice(1).map(r => r.reason)).toEqual([undefined, undefined]);
    expect(git(dir, '--git-dir', origin, 'show', 'agentgraph/1:other.txt')).toBe('other');
    expect(git(dir, '--git-dir', origin, 'rev-list', '--count', 'agentgraph/1')).toBe('3');
  });

  it('keeps the previous commit when the next push has only held changes and names them in the pull request', async () => {
    const { dir, origin, work, checkout } = setup();
    const [first, second, opened] = await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* Tracker;
        const proposal = { kind: 'push', branch: 'agentgraph/1', message: 'Add hello' } as const;
        const first = yield* tracker.apply(1, proposal, checkout);
        mkdirSync(join(work, '.github/workflows'), { recursive: true });
        writeFileSync(join(work, '.github/workflows/x.yml'), 'on: push\n');
        const second = yield* tracker.apply(1, proposal, checkout);
        const opened = yield* tracker.apply(
          1,
          { kind: 'pull_request', branch: proposal.branch, base: 'main', title: 'Hello', body: 'Closes #1' },
          checkout
        );
        return [first, second, opened];
      }).pipe(Effect.provide(folderTracker(dir)))
    );
    expect(first).toMatchObject({ ok: true, held: [] });
    expect(second).toMatchObject({
      ok: false,
      held: ['.github/workflows/x.yml'],
      reason: expect.stringContaining('Nothing pushed'),
    });
    expect(second!.url).toBeUndefined();
    expect(git(dir, '--git-dir', origin, 'rev-parse', 'agentgraph/1')).toBe(first!.url!.split('@').at(-1));
    expect(readFileSync(opened!.url!, 'utf8')).toContain('Not pushed: `.github/workflows/x.yml`');
  });

  it('refuses a push onto a branch that moved away from what the checkout builds on, as moved', async () => {
    const { dir, origin, push } = setup();
    git(dir, '--git-dir', origin, 'branch', 'agentgraph/1', 'main');
    git(join(dir, 'seed'), 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
    git(join(dir, 'seed'), 'push', '-q', '-f', 'origin', 'HEAD:agentgraph/1');
    expect(await push()).toMatchObject({ ok: false, moved: true });
  });

  it('runs no code a session planted in its worktree', async () => {
    const { dir, work, origin, push } = setup();
    const { marker } = plant(work);
    expect((await push()).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(dir, '--git-dir', origin, 'show', 'agentgraph/1:hello.txt')).toBe('hello');
  });
});

describe('folderTracker issue', () => {
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
    const t = await Effect.runPromise(
      Effect.flatMap(Tracker, f => f.issue(8)).pipe(Effect.provide(folderTracker(dir)))
    );
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

describe('hostSandbox', () => {
  it('runs a command in a dir, streams its lines and times out', async () => {
    const dir = temp();
    const command = { cmd: 'sh', dir, env: { WHO: 'bot' }, network: 'none' as const, minutes: 1 };
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const exit = yield* sandbox.exec({ ...command, args: ['-c', 'echo "$WHO"; exit 3'] });
        const lines = yield* Stream.runCollect(sandbox.lines({ ...command, args: ['-c', 'echo a; echo b'] }));
        const late = yield* Effect.result(sandbox.exec({ ...command, args: ['-c', 'sleep 5'], minutes: 0.001 }));
        return { exit, lines, late: late._tag === 'Failure' && late.failure.reason };
      }).pipe(Effect.scoped, Effect.provide(hostSandbox(dir)))
    );
    expect(out).toEqual({ exit: { code: 3, output: 'bot\n' }, lines: ['a', 'b', { code: 0 }], late: 'timeout' });
  });

  it('kills a command that runs past its minutes', async () => {
    const dir = temp();
    const command = { cmd: 'sh', dir, env: {}, network: 'none' as const, minutes: 0.005 };
    const killed = async (pid: string) => {
      const n = Number(readFileSync(join(dir, pid), 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(n, 0)).toThrow());
    };
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const exec = yield* Effect.flip(sandbox.exec({ ...command, args: ['-c', 'echo $$ > exec; exec sleep 5'] }));
        const lines = yield* Effect.flip(
          Stream.runDrain(sandbox.lines({ ...command, args: ['-c', 'echo $$ > lines; exec sleep 5'] }))
        );
        return [exec, lines].map(e => [e.reason, e.detail]);
      }).pipe(Effect.scoped, Effect.provide(hostSandbox(dir)))
    );
    expect(out).toEqual(Array(2).fill(['timeout', 'sh ran past 0.005 minutes']));
    await killed('exec');
    await killed('lines');
  });

  it('checks out an annotated tag and the remote head by the commit they name', async () => {
    const { root } = seeded('tagged', { 'README.md': 'hi\n' }, 'origin.git');
    dirs.push(root);
    const origin = join(root, 'origin.git');
    const head = git(origin, 'rev-parse', 'main');
    git(origin, 'tag', '-a', '-m', 'one', 'v1', 'main');
    const bases = await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const read = (ref: string) =>
          Effect.map(sandbox.checkout(ref), work => [work.base, git(work.dir, 'rev-parse', 'HEAD')]);
        return [yield* read('v1'), yield* read('origin')];
      }).pipe(Effect.scoped, Effect.provide(hostSandbox(origin)))
    );
    expect(bases).toEqual([
      [head, head],
      [head, head],
    ]);
  });
});

describe('seeded', () => {
  it('points a copied origin at its own seed, not the template', () => {
    const files = { 'README.md': 'hi\n' };
    const first = seeded('remote', files, 'origin.git');
    const second = seeded('remote', files, 'origin.git');
    dirs.push(first.root, second.root);
    const origin = join(second.root, 'origin.git');
    expect(git(origin, 'config', 'remote.origin.url')).toBe(second.seed);
    const ahead = commit(second.seed, { 'more.txt': 'more\n' });
    git(origin, 'fetch', '-q', 'origin', 'main:main');
    expect(git(origin, 'rev-parse', 'main')).toBe(ahead);
    expect(git(join(first.root, 'origin.git'), 'rev-parse', 'main')).not.toBe(ahead);
  });
});
