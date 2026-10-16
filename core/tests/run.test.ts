import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chunk, Effect, Layer, Redacted, Stream, TestClock, TestContext } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { drive, sweep, tick } from '../src/engine.ts';
import { start as main } from '../src/main.ts';
import { harnesses } from '../src/harnesses.ts';
import { fileForge, Forge, ForgeError, type Event, type Proposal } from '../src/forge.ts';
import { host, Sandbox, type Command } from '../src/sandbox.ts';
import type { Settings } from '../src/services.ts';
import { scripted, Session, type SessionEvent, type SessionSpec } from '../src/session.ts';
import { fileStore, Store, type Trace } from '../src/store.ts';
import { begin, reenter, transition, type Run } from '../src/workflow.ts';
import { git, hubOf } from './fixtures.ts';

const hub = hubOf('acme-app', {
  types: { run: '! grep -q TODO hello.txt' },
  safety: { run: '! test -e secret.txt' },
  claims: { agent: 'claim-checker' },
});
const w = hub.workflows.issue!;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A bare origin with one commit on main, a forge with issue #7 and its `/bothub` comment, and a data dir. */
const world = () => {
  const root = mkdtempSync(join(tmpdir(), 'bothub-core-run-'));
  dirs.push(root);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'demo\n');
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ scripts: { test: '! grep -q TODO hello.txt' } }));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(root, 'clone', '-q', '--bare', seed, 'origin.git');
  const forge = join(root, 'forge');
  mkdirSync(forge);
  writeFileSync(
    join(forge, '7.md'),
    '---\ntitle: Add a greeting\nstate: open\nauthor: morgan\nlabels: []\n---\n\nAdd hello.txt.\n'
  );
  const human = (body: string, at: string) =>
    appendFileSync(
      join(forge, '7.jsonl'),
      `${JSON.stringify({ issue: 7, kind: 'comment', actor: 'morgan', trusted: true, at, comment: { id: at, author: 'morgan', body, at } } satisfies Event)}\n`
    );
  human('/bothub', '2026-10-16T00:00:00.000Z');
  return { root, origin: join(root, 'origin.git'), forge, data: join(root, 'data'), human };
};

const start = (session: string): SessionEvent => ({ type: 'start', session, model: 'test', home: `/homes/${session}` });
const write = (path: string, content: string): SessionEvent => ({
  type: 'tool',
  id: path,
  name: 'write',
  input: { path, content },
  ok: true,
});
const reply = (...proposals: Proposal[]): SessionEvent => ({
  type: 'end',
  final: `Done.\n\n\`\`\`bothub\n${proposals.map(p => JSON.stringify(p)).join('\n')}\n\`\`\``,
  ended: 'stop',
  exit: 0,
});
const push: Proposal = { kind: 'push', branch: 'bothub/7', message: 'Add hello' };
const pull: Proposal = {
  kind: 'pull_request',
  branch: 'bothub/7',
  base: 'main',
  title: 'Add hello',
  body: 'Closes #7',
};
const judged: SessionEvent[] = [
  start('j'),
  { type: 'usage', input: 4, output: 2, usd: 0.25 },
  { type: 'text', text: 'PASS, no claims' },
];

/** The file doubles, with every session spec and every sandbox command recorded, both also in `order`. */
const services = (where: ReturnType<typeof world>, turns: SessionEvent[][]) => {
  const specs: SessionSpec[] = [];
  const commands: Command[] = [];
  const order: (SessionSpec | Command)[] = [];
  const recording = Layer.effect(
    Session,
    Effect.map(Session, s => ({ open: (spec: SessionSpec) => (specs.push(spec), order.push(spec), s.open(spec)) }))
  ).pipe(Layer.provide(scripted(turns)));
  const sandbox = Layer.effect(
    Sandbox,
    Effect.map(Sandbox, s => ({ ...s, exec: (c: Command) => (commands.push(c), order.push(c), s.exec(c)) }))
  ).pipe(Layer.provide(host(where.origin)));
  const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), sandbox, recording);
  const run = <A, E>(effect: Effect.Effect<A, E, Forge | Store | Session | Sandbox>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { specs, commands, order, run };
};

const traceOf = (data: string, id: string) =>
  readFileSync(join(data, id, 'trace.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Trace);

const bodies = (t: { events: Event[] }) => t.events.flatMap(m => (m.comment ? [m.comment.body] : []));

const fresh = (): Run => begin(w, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' });

describe('drive', () => {
  it('walks a whole run: retry in the same session, a fresh review sending it back, a round cap, an answer, a merge', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), write('hello.txt', 'TODO\n'), { type: 'usage', input: 10, output: 5, usd: 0.5 }, reply(push, pull)],
      [start('i1'), write('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'back', why: 'say hello world' })],
      [start('i1'), write('hello.txt', 'hello world\n'), reply(push)],
      judged,
      [start('r2'), reply({ kind: 'back', why: 'add a newline' })],
      [start('i1'), write('hello.txt', 'hello world\n\n'), reply(push)],
      judged,
      [start('r3'), reply({ kind: 'back', why: 'still not right' })],
      [start('r4'), reply({ kind: 'comment', body: 'Ready to merge.' })],
    ]);

    const asked = await run(drive(w, fresh(), hub));
    expect(asked).toMatchObject({ step: 'review', status: 'waiting', reason: 'still not right', usd: 0.5 + 3 * 0.25 });
    expect(asked.rounds).toEqual({ review: 2 });
    expect(asked.sessions.implement).toMatchObject({ id: 'i1', home: '/homes/i1', seen: { at: expect.any(String) } });

    // the failed try pushed nothing; the passing one did, and opened pull request #8
    const forge = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(bodies(forge)).toEqual([
      '/bothub',
      'Waiting for an answer at review:\n\nstill not right\n\nAnswer with `/bothub <your answer>`, or `/bothub stop` to end the run.\n\nCost so far: $1.25.\n\nPull request: ' +
        join(where.forge, '8.md'),
      'Brief: add hello.txt',
      'still not right\n\nAnswer with `/bothub <your answer>`, or `/bothub stop` to end the run.',
    ]);
    expect(forge.labels).toEqual(['bothub:waiting']);
    const pr = await run(Effect.flatMap(Forge, f => f.issue(8)));
    expect(pr.pull).toMatchObject({ branch: 'bothub/7', base: 'main' });
    expect(git(where.origin, 'show', 'bothub/7:hello.txt')).toBe('hello world');
    expect(pr.pull?.head).toBe(git(where.origin, 'rev-parse', 'bothub/7'));
    expect(existsSync(join(where.forge, '8', 'diff.patch'))).toBe(true);

    // retry and ways back resume the implementor's session; review is fresh every time
    expect(specs.map(s => s.resume?.id)).toEqual([
      undefined,
      undefined,
      'i1',
      undefined,
      undefined,
      'i1',
      undefined,
      undefined,
      'i1',
      undefined,
      undefined,
    ]);
    expect(specs[2]!.prompt).toMatch(/^types: /);
    expect(specs[5]!.prompt).toBe('the review step sent this back: say hello world');
    expect(specs[1]!.prompt).toContain('Add hello.txt.');
    expect(specs[4]!.prompt).toContain('no hunk needs a change before it can merge');
    expect(specs[4]!.prompt).toContain('+hello');

    const trace = traceOf(where.data, 'run-7');
    const prompts = trace.flatMap(t => ('prompt' in t ? [t.prompt] : []));
    expect(prompts).toEqual(specs);
    const first = trace.findIndex(t => 'prompt' in t && t.step === 'implement');
    expect(trace[first + 1]).toMatchObject({ step: 'implement', event: { type: 'start', session: 'i1' } });
    const replayed = trace.reduce<Partial<Run>>((run, t) => {
      if (!('saved' in t)) return run;
      const next: Partial<Run> = { ...run, ...t.saved };
      for (const k of t.cleared ?? []) delete next[k];
      return next;
    }, {});
    expect(replayed).toEqual(asked);
    const resumed = trace.flatMap(t => ('saved' in t && t.saved.sessions ? [t.saved.sessions] : []));
    expect(resumed).toContainEqual(
      expect.objectContaining({ implement: expect.objectContaining({ id: 'i1', home: '/homes/i1' }) })
    );
    const sessions = trace.flatMap(t => ('session' in t ? [t.session] : []));
    expect(sessions[1]).toEqual({ id: 'i1', resumed: false, ended: 'stop', exit: 0, usd: 0.5 });
    expect(sessions[2]).toMatchObject({ id: 'i1', resumed: true, ended: 'stop', exit: 0 });
    expect(sessions[3]).toMatchObject({ id: 'j', resumed: false, ended: 'stop', exit: 0 });
    const types = trace.flatMap(t => ('check' in t && t.check.check === 'types' ? [t] : []));
    expect(types[0]).toMatchObject({ check: { pass: false }, exit: 1 });
    expect(types[1]).toMatchObject({ check: { pass: true }, exit: 0 });
    const outcomes = trace.flatMap(t => ('outcome' in t ? [[t.step, t.outcome.kind, t.run.tries, t.run.rounds]] : []));
    expect(outcomes).toEqual([
      ['triage', 'pass', 0, {}],
      ['implement', 'failed', 1, {}],
      ['implement', 'pass', 0, {}],
      ['review', 'back', 0, { review: 1 }],
      ['implement', 'pass', 0, { review: 1 }],
      ['review', 'back', 0, { review: 2 }],
      ['implement', 'pass', 0, { review: 2 }],
      ['review', 'back', 0, { review: 2 }],
    ]);

    // a human answers on the issue: the review runs again and the run waits for the merge
    where.human('/bothub it is fine, ship it', '2026-10-17T00:00:00.000Z');
    const said = await run(
      Effect.flatMap(Forge, f => Stream.runCollect(f.since('2026-10-16T23:00:00.000Z'))).pipe(Effect.map(Chunk.toArray))
    );
    const answer = said.flatMap(m => reenter(w, asked, m) ?? [])[0]!;
    expect(answer).toEqual({ kind: 'answer', text: 'it is fine, ship it' });
    const waiting = await run(drive(w, transition(w, asked, answer), hub));
    expect(waiting).toMatchObject({ step: 'merge', status: 'waiting', rounds: { review: 1 } });
    expect(specs.at(-1)!.prompt).toContain('it is fine, ship it');

    const merged = {
      issue: 7,
      kind: 'merged',
      actor: 'morgan',
      trusted: true,
      at: '2026-10-18T00:00:00.000Z',
    } as const;
    expect(transition(w, waiting, reenter(w, waiting, merged)!)).toMatchObject({ status: 'done' });
  }, 30_000);

  it('ends the run at once when a stop check fails: no try spent, nothing lands, the findings posted', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), write('hello.txt', 'hello\n'), write('secret.txt', 'key\n'), reply(push, pull)],
    ]);
    const stopped = await run(drive(w, fresh(), hub));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped', tries: 0 });
    expect(stopped.reason).toMatch(/^safety: /);
    expect(specs).toHaveLength(2);
    expect(() => git(where.origin, 'rev-parse', '--verify', '-q', 'bothub/7')).toThrow();
    const issue = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(bodies(issue)[1]).toBe(`Stopped at implement: ${stopped.reason}\n\nCost so far: $0.00.`);
    expect(issue.labels).toEqual(['bothub:stopped']);
    const runs = await run(Effect.flatMap(Store, s => s.list({ status: 'stopped' })));
    expect(runs.map(r => r.id)).toEqual(['run-7']);
  }, 30_000);

  it('stops the run once its summed session cost passes usd-per-run', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), { type: 'usage', input: 1, output: 1, usd: 0.5 }, reply({ kind: 'comment', body: 'Brief' })],
    ]);
    const capped = { ...hub, limits: { ...hub.limits, usdPerRun: 0.1 } };
    const stopped = await run(drive(w, fresh(), capped));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped', usd: 0.5 });
    expect(stopped.reason).toBe("Spent $0.50, over the hub's usd-per-run of 0.1.");
    expect(specs).toHaveLength(1);
  }, 30_000);

  it('stops the run with the reason when a session cannot run', async () => {
    const where = world();
    const { run } = services(where, []);
    const stopped = await run(drive(w, fresh(), hub));
    expect(stopped).toMatchObject({ step: 'triage', status: 'stopped' });
    expect(stopped.reason).toBe('Stopped by a runner error (SessionStop). The details are in the trace of run run-7.');
    const stops = traceOf(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(stops).toContainEqual({ kind: 'stop', why: 'SessionStop: no scripted session left' });
    const sessions = traceOf(where.data, 'run-7').flatMap(t => ('session' in t ? [t.session] : []));
    expect(sessions).toEqual([{ resumed: false, ended: 'provider', usd: 0 }]);
  }, 30_000);

  it('never writes a proxy key into the trace, even when the harness prints it', async () => {
    const where = world();
    const key = 'sk-bh-fake-0123456789abcdef';
    const sandbox = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, s => ({
        ...s,
        lines: () =>
          Stream.fromIterable([
            JSON.stringify({ type: 'text', sessionID: 's1', part: { type: 'text', text: `the key is ${key}` } }),
            JSON.stringify({
              type: 'tool_use',
              sessionID: 's1',
              part: {
                type: 'tool',
                tool: 'bash',
                callID: 'c1',
                state: { status: 'completed', input: { command: 'env' }, output: `BOTHUB_LLM_API_KEY=${key}` },
              },
            }),
            'bothub-exit 0',
          ]),
      }))
    ).pipe(Layer.provide(host(where.origin)));
    const keys = Redacted.make(
      Object.keys(hub.agents)
        .map(agent => `${agent}=${key}`)
        .join(',')
    );
    const session = harnesses({ data: where.data, proxy: { url: 'http://proxy', keys } }).pipe(Layer.provide(sandbox));
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), sandbox, session);
    await Effect.runPromise(drive(w, fresh(), hub).pipe(Effect.provide(layer)));
    const text = readFileSync(join(where.data, 'run-7', 'trace.jsonl'), 'utf8');
    expect(text).toContain('"prompt"');
    expect(text).toContain('BOTHUB_LLM_API_KEY=***');
    expect(text).not.toContain(key);
  }, 30_000);
});

describe('setup', () => {
  const stopping = (): SessionEvent[][] => [
    [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
    [start('i1'), write('hello.txt', 'hello\n'), write('secret.txt', 'key\n'), reply(push, pull)],
  ];

  it('runs once per checkout with network before the first step', async () => {
    const where = world();
    const { order, commands, run } = services(where, stopping());
    await run(drive(w, fresh(), { ...hub, setup: 'test -e README.md' }));
    const setups = commands.filter(c => c.args.includes('test -e README.md'));
    expect(setups).toHaveLength(1);
    expect(order[0]).toBe(setups[0]);
    expect(setups[0]).toMatchObject({ cmd: 'sh', network: 'proxy' });
    expect(commands.length).toBeGreaterThan(1);
    expect(commands.slice(1).every(c => c.network === 'none')).toBe(true);
  }, 30_000);

  it('stops the run as infra with the output when setup fails, before any step', async () => {
    const where = world();
    const { specs, run } = services(where, []);
    const stopped = await run(drive(w, fresh(), { ...hub, setup: 'echo registry unreachable; exit 3' }));
    expect(stopped).toMatchObject({ step: 'triage', status: 'stopped', tries: 0 });
    expect(specs).toHaveLength(0);
    const stops = traceOf(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(stops).toContainEqual({ kind: 'stop', why: 'SandboxError: setup exited 3: registry unreachable' });
  }, 30_000);

  it('runs nothing with network when the hub has no setup', async () => {
    const where = world();
    const { commands, run } = services(where, stopping());
    await run(drive(w, fresh(), hub));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some(c => c.network === 'proxy')).toBe(false);
  }, 30_000);
});

const say = (where: ReturnType<typeof world>, m: Event) =>
  appendFileSync(join(where.forge, `${m.issue}.jsonl`), `${JSON.stringify(m)}\n`);

const comment = (issue: number, actor: string, trusted: boolean, body: string, at: string): Event => ({
  issue,
  kind: 'comment',
  actor,
  trusted,
  at,
  comment: { id: at, author: actor, body, at },
});
const check = (issue: number, name: string, conclusion: string, at: string): Event => ({
  issue,
  kind: 'check',
  actor: 'ci',
  trusted: false,
  at,
  check: { name, conclusion },
});

/** Pull request #8 on run 7's branch. */
const pullRequest = (where: ReturnType<typeof world>, base = 'b1') => {
  writeFileSync(
    join(where.forge, '8.md'),
    '---\ntitle: Add hello\nstate: open\nauthor: bothub[bot]\n---\n\nCloses #7\n'
  );
  mkdirSync(join(where.forge, '8'), { recursive: true });
  writeFileSync(
    join(where.forge, '8', 'pull.json'),
    JSON.stringify({ branch: 'bothub/7', base: 'main', head: 'x', baseSha: base })
  );
};

describe('tick', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });

  it('begins a run from a trusted command, drives it, and begins again only on a new command', async () => {
    const where = world();
    const at = '2026-10-16T00:00:01.000Z';
    say(where, {
      issue: 7,
      kind: 'comment',
      actor: 'mallory[bot]',
      trusted: false,
      at,
      comment: { id: 'x', author: 'mallory[bot]', body: '/bothub', at },
    });
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply(push)],
      [start('b'), reply({ kind: 'comment', body: 'Nothing left to do.' })],
    ]);
    const first = await run(tick(small));
    expect(first.map(r => [r.id, r.status])).toEqual([['issue-7-20261016000000000', 'done']]);
    expect(git(where.origin, 'show', 'bothub/7:hello.txt')).toBe('hello');
    expect(await run(tick(small))).toEqual([]);
    where.human('/bothub once more', '2026-10-17T00:00:00.000Z');
    const second = await run(tick(small));
    expect(second.map(r => [r.id, r.status])).toEqual([['issue-7-20261017000000000', 'done']]);
    expect(specs).toHaveLength(2);
    expect(specs[1]!.prompt).toContain('@morgan: /bothub once more');
    expect(readFileSync(join(where.forge, '7.reactions'), 'utf8')).toBe(
      'eyes 2026-10-16T00:00:00.000Z\neyes 2026-10-17T00:00:00.000Z\n'
    );
  }, 30_000);

  it('keeps the worktree files of a parked run and puts them back when it reenters', async () => {
    const where = world();
    const flow = small.workflows.issue!;
    const { run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Hello or hi?' })],
      [start('a'), write('bye.txt', 'bye\n'), reply(push)],
    ]);
    const kept = 'refs/bothub/runs/run-7';
    const [asked, done, saved] = await run(
      Effect.gen(function* () {
        const asked = yield* drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small);
        const saved = git(where.origin, 'show', `${kept}:hello.txt`);
        return [asked, yield* drive(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small), saved];
      })
    );
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Hello or hi?' });
    expect(done).toMatchObject({ status: 'done' });
    expect(saved).toBe('hello');
    expect(git(where.origin, 'show', 'bothub/7:hello.txt')).toBe('hello');
    expect(git(where.origin, 'show', 'bothub/7:bye.txt')).toBe('bye');
    expect(git(where.origin, 'log', '--format=%s', 'main..bothub/7')).toBe('Add hello');
    expect(git(where.origin, 'rev-parse', `${kept}^`)).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(git(where.origin, 'show', `${kept}^2:hello.txt`)).toBe('hello');
  }, 30_000);

  const issue = small.workflows.issue!;
  const merging = {
    ...small,
    workflows: {
      issue: {
        ...issue,
        steps: [
          ...issue.steps,
          { name: 'merge', does: { wait: 'human' as const }, checks: [], tries: 1, back: { to: 'implement' } },
        ],
      },
    },
  };
  /** Run 7 waiting at merge with its implement session kept, and pull request #8 on its branch. */
  const waiting = (where: ReturnType<typeof world>) => {
    pullRequest(where);
    return Effect.flatMap(Store, s =>
      s.put({
        ...begin(merging.workflows.issue, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
        step: 'merge',
        status: 'waiting',
        sessions: { implement: { id: 'a', home: '/homes/a' } },
      })
    );
  };

  it('asks instead of waiting for a merge when no pull request is open on the branch', async () => {
    const where = world();
    const flow = merging.workflows.issue;
    const { specs, run } = services(where, []);
    const start = { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), step: 'merge' };
    const parked = await run(drive(flow, start, merging));
    expect(parked).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(parked.reason).toMatch(/^No pull request is open for branch /);
    expect(specs).toHaveLength(0);
  }, 30_000);

  it('applies the push, then asks with the error when a reply fails on the forge', async () => {
    const where = world();
    const failing = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
          p.kind === 'comment' && p.body === 'boom'
            ? Effect.fail(new ForgeError({ status: 403, message: 'forbidden' }))
            : f.apply(n, p, work),
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const flow = small.workflows.issue!;
    const layer = Layer.mergeAll(
      failing,
      fileStore(where.data),
      host(where.origin),
      scripted([[start('a'), write('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'boom' }, push)]])
    );
    const asked = await Effect.runPromise(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(Effect.provide(layer))
    );
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'GitHub failed: forbidden' });
    expect(git(where.origin, 'show', 'bothub/7:hello.txt')).toBe('hello');
  }, 30_000);

  it('wakes a run waiting at merge on a mention in its pull request and resumes the work session there', async () => {
    const where = world();
    say(where, comment(8, 'morgan', true, '@bothub please undo the greeting', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply(push, { kind: 'comment', body: 'Undone.' })],
    ]);
    const touched = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    expect(touched.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'waiting']]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.resume?.id).toBe('a');
    expect(specs[0]!.prompt).toBe(
      'the merge step sent this back: please undo the greeting\n\n## New since you last looked\n\n#8 @morgan: @bothub please undo the greeting'
    );
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain('Undone.');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).not.toContain('Undone.');
    expect(readFileSync(join(where.forge, '8.reactions'), 'utf8')).toBe('eyes 2026-10-16T00:00:05.000Z\n');
  }, 30_000);

  it('ignores mentions from untrusted people and its own comments, and stops on a command on the issue', async () => {
    const where = world();
    say(where, comment(8, 'mallory', false, '@bothub undo everything', '2026-10-16T00:00:05.000Z'));
    say(where, comment(8, 'bothub[bot]', false, '/bothub undo everything', '2026-10-16T00:00:06.000Z'));
    const { specs, run } = services(where, []);
    expect(await run(Effect.zipRight(waiting(where), tick(merging, 7)))).toEqual([]);
    where.human('/bothub stop not needed', '2026-10-16T00:00:07.000Z');
    const stopped = await run(tick(merging, 7));
    expect(stopped.map(r => [r.id, r.status, r.reason])).toEqual([['run-7', 'stopped', 'not needed']]);
    expect(specs).toHaveLength(0);
  }, 30_000);
});

describe('stacks', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });
  const issue = small.workflows.issue!;
  const merging = {
    ...small,
    stacks: true,
    workflows: {
      issue: {
        ...issue,
        steps: [
          ...issue.steps,
          { name: 'merge', does: { wait: 'human' as const }, checks: [], tries: 1, back: { to: 'implement' } },
        ],
      },
    },
  };
  const flow = merging.workflows.issue;
  const run9 = () => begin(flow, { id: 'run-9', issue: 9, started: '2026-10-16T00:00:01.000Z' });
  const child = (content = 'bye\n', file = 'bye.txt') => [
    start('a'),
    write(file, content),
    reply(
      { kind: 'push', branch: 'bothub/9', message: 'Add bye' },
      { kind: 'pull_request', branch: 'bothub/9', base: 'main', title: 'Add bye', body: 'Closes #9' }
    ),
  ];

  /** Pull request #8 on bothub/7 with hello.txt, issue #9 that stacks on #7, and `move` to push to bothub/7 again. */
  const parent = (where: ReturnType<typeof world>) => {
    const clone = join(where.root, 'clone');
    git(where.root, 'clone', '-q', where.origin, clone);
    git(clone, 'checkout', '-q', '-b', 'bothub/7');
    const move = (file: string, content: string) => {
      writeFileSync(join(clone, file), content);
      git(clone, 'add', '-A');
      git(clone, 'commit', '-q', '-m', `Write ${file}`);
      git(clone, 'push', '-q', 'origin', 'bothub/7');
      const head = git(clone, 'rev-parse', 'HEAD');
      writeFileSync(join(where.forge, '8', 'pull.json'), JSON.stringify({ branch: 'bothub/7', base: 'main', head }));
      return head;
    };
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Add hello\nstate: open\nauthor: bothub[bot]\n---\n\nCloses #7\n'
    );
    mkdirSync(join(where.forge, '8'), { recursive: true });
    const head = move('hello.txt', 'hello\n');
    writeFileSync(
      join(where.forge, '9.md'),
      '---\ntitle: Say bye\nstate: open\nauthor: morgan\n---\n\nAdd bye.txt.\n\nStacks on #7\n'
    );
    return { head, move };
  };
  const pr10 = (where: ReturnType<typeof world>) => ({
    pull: JSON.parse(readFileSync(join(where.forge, '10', 'pull.json'), 'utf8')),
    body: readFileSync(join(where.forge, '10.md'), 'utf8'),
    diff: readFileSync(join(where.forge, '10', 'diff.patch'), 'utf8'),
  });
  const saved = (where: ReturnType<typeof world>) =>
    JSON.parse(readFileSync(join(where.data, 'run-9', 'run.json'), 'utf8')) as Run;

  it('opens the pull request of an issue that stacks on #7 on its branch, with only its own change', async () => {
    const where = world();
    const { head } = parent(where);
    const { specs, run } = services(where, [child()]);
    const parked = await run(drive(flow, run9(), merging));
    expect(parked).toMatchObject({
      step: 'merge',
      status: 'waiting',
      base: { pull: 8, branch: 'bothub/7', sha: head },
    });
    expect(specs[0]!.prompt).toContain('pull requests go into bothub/7.');
    const pr = pr10(where);
    expect(pr.pull).toMatchObject({ branch: 'bothub/9', base: 'bothub/7' });
    expect(pr.body).toContain('Closes #9\n\nStacks on #8');
    expect(pr.diff).toContain('bye.txt');
    expect(pr.diff).not.toContain('hello.txt');
    expect(git(where.origin, 'rev-parse', 'bothub/9~1')).toBe(head);
  }, 30_000);

  it('with stacks off, opens the same issue as an independent pull request off main', async () => {
    const where = world();
    parent(where);
    const { specs, run } = services(where, [child()]);
    const parked = await run(drive(flow, run9(), { ...merging, stacks: false }));
    expect(parked.base).toBeUndefined();
    expect(specs[0]!.prompt).toContain('pull requests go into main.');
    const pr = pr10(where);
    expect(pr.pull).toMatchObject({ branch: 'bothub/9', base: 'main' });
    expect(pr.body).not.toContain('Stacks on');
    expect(git(where.origin, 'rev-parse', 'bothub/9~1')).toBe(git(where.origin, 'rev-parse', 'main'));
  }, 30_000);

  it('rebases the branch onto the new head when #8 moves, keeping its own commit on top', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child()]);
    await run(drive(flow, run9(), merging));
    const moved = move('more.txt', 'more\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'bothub/9~1')).toBe(moved);
    expect(git(where.origin, 'log', '--format=%s', 'bothub/7..bothub/9')).toBe('Add bye');
    expect(saved(where)).toMatchObject({ status: 'waiting', base: { sha: moved } });
    const pr = pr10(where);
    expect(pr.pull.head).toBe(git(where.origin, 'rev-parse', 'bothub/9'));
    expect(pr.diff).not.toContain('more.txt');
    const before = git(where.origin, 'rev-parse', 'bothub/9');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'bothub/9')).toBe(before);
  }, 30_000);

  it('says on the issue when the branch does not rebase cleanly and leaves it where it was', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child('hello and bye\n', 'hello.txt')]);
    await run(drive(flow, run9(), merging));
    const before = git(where.origin, 'rev-parse', 'bothub/9');
    const moved = move('hello.txt', 'hi\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'bothub/9')).toBe(before);
    expect(readFileSync(join(where.forge, '9.jsonl'), 'utf8')).toContain('#8 moved and bothub/9 could not follow');
    expect(saved(where).base?.sha).toBe(moved);
  }, 30_000);
});

describe('start with one issue', () => {
  it('reads the App env file, loads the hub, drives the issue to the merge wait, then reenters on the merge', async () => {
    const where = world();
    const key = join(where.root, 'app.pem');
    writeFileSync(key, 'PEM');
    writeFileSync(
      join(where.root, 'app.env'),
      `BOTHUB_APP_ID=42\nBOTHUB_APP_SLUG=stx-bothub\nBOTHUB_APP_KEY_FILE="${key}"\nBOTHUB_INSTALLATION_ID=7\n`
    );
    const env = { BOTHUB_APP_ENV: join(where.root, 'app.env'), BOTHUB_PROXY_KEYS: 'implementor=k1,reviewer=k2' };
    Object.assign(process.env, env);
    const seen: Settings[] = [];
    const turns = [
      [start('i'), write('hello.txt', 'TODO\n'), reply(push)],
      [start('i'), write('hello.txt', 'hello\n'), reply(push)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ];
    const doubles = (s: Settings) => {
      seen.push(s);
      return Layer.mergeAll(fileForge(where.forge), fileStore(s.data), host(where.origin), scripted(turns));
    };
    const one = { hub: join(import.meta.dirname, '..', '..', 'examples', 'sandbox'), issue: 7, data: where.data };
    try {
      const parked = await main(one, doubles);
      expect(parked.map(r => [r.step, r.status, r.tries])).toEqual([['merge', 'waiting', 0]]);
      expect(seen[0]).toMatchObject({ repo: 'acme/sandbox', data: where.data, app: { id: '42' } });
      expect(Redacted.value(seen[0]!.app.key)).toBe('PEM');
      expect(Redacted.value(seen[0]!.proxy.keys)).toBe('implementor=k1,reviewer=k2');
      expect(git(where.origin, 'show', 'bothub/7:hello.txt')).toBe('hello');

      const later = new Date(Date.now() + 1000).toISOString();
      say(where, { issue: 7, kind: 'merged', actor: 'morgan', trusted: true, at: later });
      const done = await main(one, doubles);
      expect(done.map(r => [r.id, r.status])).toEqual([[parked[0]!.id, 'done']]);
    } finally {
      for (const name of Object.keys(env)) delete process.env[name];
    }
  }, 30_000);
});

describe('sweep', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });

  it('drives a new issue and a parked one with a new answer, and skips one waiting with nothing new', async () => {
    const where = world();
    rmSync(join(where.forge, '7.jsonl'));
    for (const n of [8, 9])
      writeFileSync(
        join(where.forge, `${n}.md`),
        `---\ntitle: Issue ${n}\nstate: open\nauthor: morgan\nlabels: []\n---\n\nBody ${n}.\n`
      );
    const at = '2026-10-16T00:00:00.000Z';
    const parked = (issue: number, status: Run['status']): Run => ({
      ...begin(small.workflows.issue!, { id: `run-${issue}`, issue, started: at }),
      status,
    });
    const answer = '2026-10-16T00:00:05.000Z';
    say(where, {
      issue: 8,
      kind: 'comment',
      actor: 'morgan',
      trusted: true,
      at: answer,
      comment: { id: 'a', author: 'morgan', body: '/bothub hi', at: answer },
    });
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'Done.' })],
      [start('b'), write('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'Done.' })],
    ]);
    for (const r of [parked(8, 'waiting'), parked(9, 'waiting')]) {
      mkdirSync(join(where.data, r.id), { recursive: true });
      writeFileSync(join(where.data, r.id, 'run.json'), JSON.stringify(r));
    }
    const touched = await run(sweep(small));
    expect(touched.map(r => r.issue).sort()).toEqual([7, 8]);
    expect(touched.find(r => r.issue === 9)).toBeUndefined();
    expect(specs).toHaveLength(2);
    expect(specs.map(s => s.prompt).join('\n')).toContain('hi');
    expect(await run(Effect.flatMap(Store, s => s.read('run-9').pipe(Stream.runCollect)))).toHaveProperty('length', 0);
  }, 30_000);
});

describe('coworker', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });
  const flow = small.workflows.issue!;
  const begun = () => begin(flow, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' });

  it('prompts a fresh session with the issue, its pull request and its checks', async () => {
    const where = world();
    pullRequest(where);
    say(where, comment(8, 'ana', true, 'mind the edge case', '2026-10-16T00:00:02.000Z'));
    say(where, check(8, 'test', 'failure', '2026-10-16T00:00:03.000Z'));
    const { specs, run } = services(where, [[start('a'), write('hello.txt', 'hello\n'), reply(push)]]);
    await run(drive(flow, begun(), small));
    expect(specs[0]!.prompt).toContain('## Pull request #8 Add hello');
    expect(specs[0]!.prompt).toContain('#7 @morgan: /bothub');
    expect(specs[0]!.prompt).toContain('#8 @ana: mind the edge case');
    expect(specs[0]!.prompt).toContain('#8 check test: failure');
  }, 30_000);

  /** Run 7 parked on a question in its kept implement session, with pull request #8 on base b1. */
  const parked = async (where: ReturnType<typeof world>, turns: SessionEvent[][]) => {
    pullRequest(where);
    const s = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })], ...turns]);
    const asked = await s.run(drive(flow, begun(), small));
    expect(asked).toMatchObject({ status: 'waiting', sessions: { implement: { id: 'a' } } });
    return { ...s, asked };
  };
  const later = (s: number) => `2099-01-01T00:00:0${s}.000Z`;

  it('catches a resumed session up on what people said and pushed while it was parked, and nothing older', async () => {
    const where = world();
    const { specs, run, asked } = await parked(where, [[start('a'), reply({ kind: 'comment', body: 'ok' })]]);
    say(where, comment(7, 'morgan', true, '/bothub hello', later(1)));
    say(where, {
      issue: 8,
      kind: 'commit',
      actor: 'ana',
      trusted: false,
      at: later(2),
      commit: { sha: 'abcdef123', title: 'Tweak the greeting' },
    });
    await run(drive(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small));
    expect(specs[1]!.resume?.id).toBe('a');
    expect(specs[1]!.prompt).toBe(
      'hello\n\n## New since you last looked\n\n#7 @morgan: /bothub hello\n\n#8 @ana pushed abcdef1 Tweak the greeting'
    );
  }, 30_000);

  it('resumes with only the feedback when nothing is new, and names a moved base and a flipped check', async () => {
    const where = world();
    say(where, check(8, 'test', 'failure', '2026-10-16T00:00:00.500Z'));
    const { specs, run, asked } = await parked(where, [
      [start('a'), reply({ kind: 'ask', question: 'And now?' })],
      [start('a'), reply({ kind: 'comment', body: 'ok' })],
    ]);
    const again = await run(drive(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small));
    expect(specs[1]!.prompt).toBe('hello');
    pullRequest(where, 'b2');
    say(where, check(8, 'test', 'success', later(3)));
    await run(drive(flow, transition(flow, again, { kind: 'answer', text: 'go on' }), small));
    expect(specs[2]!.prompt).toBe(
      'go on\n\n## New since you last looked\n\nThe base main moved to b2.\n\n#8 check test: success'
    );
  }, 30_000);

  it('refreshes the news file outside the checkout every minute, keeps it on a failed refresh, and never writes through links in the checkout', async () => {
    const where = world();
    const seen: string[] = [];
    const wait = (ms: number) => Effect.promise(() => new Promise(r => setTimeout(r, ms)));
    let file = '';
    const news = (_dir: string) => readFileSync(file, 'utf8');
    const target = join(where.forge, 'victim.txt');
    writeFileSync(target, 'keep\n');
    const minute = (dir: string, until: (text: string) => boolean) =>
      Effect.gen(function* () {
        yield* wait(50);
        yield* TestClock.adjust('1 minute');
        for (let i = 0; i < 40 && !until(news(dir)); i++) yield* wait(25);
        seen.push(news(dir));
      });
    const session = Layer.succeed(Session, {
      open: (spec: SessionSpec) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            file = /(\S+) holds what is new/.exec(spec.prompt)![1]!;
            expect(file.startsWith(spec.dir)).toBe(false);
            mkdirSync(join(spec.dir, '.bothub'));
            symlinkSync(target, join(spec.dir, '.bothub', 'news.md'));
            symlinkSync(where.forge, join(spec.dir, 'news'));
            seen.push(news(spec.dir));
            say(where, comment(7, 'ana', true, 'also say bye', later(1)));
            yield* minute(spec.dir, text => text.includes('also say bye'));
            renameSync(join(where.forge, '7.md'), join(where.forge, '7.away'));
            say(where, comment(7, 'ana', true, 'never seen', later(2)));
            yield* minute(spec.dir, () => false);
            renameSync(join(where.forge, '7.away'), join(where.forge, '7.md'));
            writeFileSync(join(spec.dir, 'hello.txt'), 'hello\n');
            rmSync(join(spec.dir, '.bothub'), { recursive: true });
            rmSync(join(spec.dir, 'news'));
          })
        ).pipe(Stream.flatMap(() => Stream.fromIterable([start('a'), reply(push)]))),
    });
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), host(where.origin), session);
    const done = await Effect.runPromise(
      drive(flow, begun(), small).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext))
    );
    expect(done.status).toBe('done');
    expect(seen).toEqual([
      'Nothing new yet.\n',
      '## New since you last looked\n\n@ana: also say bye\n',
      '## New since you last looked\n\n@ana: also say bye\n',
    ]);
    expect(git(where.origin, 'show', 'bothub/7:hello.txt')).toBe('hello');
    expect(git(where.origin, 'ls-tree', '-r', '--name-only', 'bothub/7')).not.toContain('.bothub');
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
  }, 30_000);

  const assigned = { ...small, workflows: { issue: { ...flow, on: { issues: { label: 'bothub' } } } } };
  const labelled = (actor: string, trusted: boolean, kind: 'label' | 'unlabel', at: string): Event => ({
    issue: 7,
    kind,
    actor,
    trusted,
    at,
    label: 'bothub',
  });

  it("begins a run on a maintainer's bothub label, not on an outsider's, and stops it when the label is removed", async () => {
    const where = world();
    say(where, labelled('mallory', false, 'label', '2026-10-16T00:00:01.000Z'));
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(await run(tick(assigned))).toEqual([]);
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:02.000Z'));
    const [asked] = await run(tick(assigned));
    expect(asked).toMatchObject({ issue: 7, status: 'waiting' });
    expect(specs).toHaveLength(1);
    say(where, labelled('mallory', false, 'unlabel', later(1)));
    expect(await run(tick(assigned))).toEqual([]);
    say(where, labelled('morgan', true, 'unlabel', later(2)));
    const [stopped] = await run(tick(assigned));
    expect(stopped).toMatchObject({ id: asked!.id, status: 'stopped', reason: 'the bothub label was removed' });
    expect(readFileSync(join(where.forge, '7.reactions'), 'utf8')).toBe('eyes #7\n');
    expect((await run(Effect.flatMap(Forge, f => f.issue(7)))).labels).toEqual(['bothub:stopped']);
  }, 30_000);

  it('begins on one issue only where the latest bothub label came from a maintainer', async () => {
    const where = world();
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:01.000Z'));
    say(where, labelled('mallory', false, 'unlabel', '2026-10-16T00:00:02.000Z'));
    say(where, labelled('mallory', false, 'label', '2026-10-16T00:00:03.000Z'));
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(await run(tick(assigned, 7, true))).toEqual([]);
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:04.000Z'));
    expect((await run(tick(assigned, 7, true))).map(r => r.status)).toEqual(['waiting']);
  }, 30_000);

  it('keeps one status comment through two tries and an ask, with the question as its own comment', async () => {
    const where = world();
    const { run } = services(where, [
      [start('a'), write('hello.txt', 'TODO\n'), reply(push)],
      [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })],
    ]);
    const asked = await run(drive(flow, begun(), small));
    expect(asked).toMatchObject({ status: 'waiting', tries: 1, comment: '7-3' });
    const issue = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(issue.labels).toEqual(['bothub:waiting']);
    expect(bodies(issue)).toEqual([
      '/bothub',
      'Waiting for an answer at implement:\n\nHello or hi?\n\nAnswer with `/bothub <your answer>`, or `/bothub stop` to end the run.\n\nCost so far: $0.00.',
      'Hello or hi?\n\nAnswer with `/bothub <your answer>`, or `/bothub stop` to end the run.',
    ]);
    const edits = traceOf(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.proposal.kind === 'comment' && t.applied.proposal.edit
        ? [t.applied.proposal.body]
        : []
    );
    expect(edits).toEqual([
      'Working on implement, try 2 of 2.\n\nCost so far: $0.00.',
      expect.stringMatching(/^Waiting for an answer/),
    ]);
  }, 30_000);

  it('replies where the human answered: on the pull request, and under a review comment in its issue', async () => {
    const where = world();
    pullRequest(where);
    const { run } = services(where, [
      [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })],
      [start('a'), reply({ kind: 'ask', question: 'And bye?' })],
      [start('a'), reply({ kind: 'comment', body: 'Said bye.' })],
    ]);
    const at = () => new Date(Date.now() + 1).toISOString();
    const review = comment(8, 'morgan', true, '/bothub yes, bye too', '');
    const [again, done] = await run(
      Effect.gen(function* () {
        yield* drive(flow, begun(), small);
        say(where, comment(8, 'morgan', true, '/bothub hello', at()));
        const [again] = yield* tick(small, 7);
        review.at = review.comment!.at = review.comment!.id = at();
        say(where, { ...review, comment: { ...review.comment!, path: 'hello.txt', line: 1 } });
        const [done] = yield* tick(small, 7);
        return [again, done];
      })
    );
    expect(again).toMatchObject({ status: 'waiting', said: { issue: 8 } });
    expect(done).toMatchObject({ status: 'done', said: { issue: 8, under: review.at } });
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'bothub[bot]').map(c => [c.body.split('\n')[0], c.under, c.path])).toEqual([
      ['And bye?', undefined, undefined],
      ['Said bye.', review.at, 'hello.txt'],
    ]);
    const issue = bodies(await run(Effect.flatMap(Forge, f => f.issue(7))));
    expect(issue.some(b => b.startsWith('And bye?') || b.startsWith('Said bye.'))).toBe(false);
  }, 30_000);
});
