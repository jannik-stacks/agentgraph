import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chunk, Effect, Layer, Redacted, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { drive, sweep, tick } from '../src/engine.ts';
import { start as main } from '../src/main.ts';
import { harnesses } from '../src/harnesses.ts';
import { fileForge, Forge, type Message, type Proposal } from '../src/forge.ts';
import { host, Sandbox, type Command } from '../src/sandbox.ts';
import type { Settings } from '../src/services.ts';
import { scripted, Session, type AgentEvent, type SessionSpec } from '../src/session.ts';
import { fileStore, Store, type Trace } from '../src/store.ts';
import { begin, reenter, transition, type Run } from '../src/workflow.ts';
import { hubOf } from './fixtures.ts';

const hub = hubOf('acme-app', {
  types: { run: '! grep -q TODO hello.txt' },
  safety: { run: '! test -e secret.txt' },
  claims: { judge: 'claim-checker' },
});
const w = hub.workflows.issue!;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

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
      `${JSON.stringify({ thread: 7, kind: 'comment', actor: 'morgan', trusted: true, at, comment: { id: at, author: 'morgan', body, at } } satisfies Message)}\n`
    );
  human('/bothub', '2026-10-16T00:00:00.000Z');
  return { root, origin: join(root, 'origin.git'), forge, data: join(root, 'data'), human };
};

const start = (session: string): AgentEvent => ({ type: 'start', session, model: 'test', home: `/homes/${session}` });
const write = (path: string, content: string): AgentEvent => ({
  type: 'tool',
  id: path,
  name: 'write',
  input: { path, content },
  ok: true,
});
const reply = (...proposals: Proposal[]): AgentEvent => ({
  type: 'end',
  final: `Done.\n\n\`\`\`bothub\n${proposals.map(p => JSON.stringify(p)).join('\n')}\n\`\`\``,
  ended: 'stop',
  exit: 0,
});
const push: Proposal = { kind: 'push', branch: 'bothub/7', message: 'Add hello' };
const pull: Proposal = { kind: 'pull', branch: 'bothub/7', into: 'main', title: 'Add hello', body: 'Closes #7' };
const judged: AgentEvent[] = [
  start('j'),
  { type: 'usage', input: 4, output: 2, usd: 0.25 },
  { type: 'text', text: 'PASS, no claims' },
];

/** The file doubles, with every session spec and every sandbox command recorded, both also in `order`. */
const services = (where: ReturnType<typeof world>, turns: AgentEvent[][]) => {
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

const fresh = (): Run => begin(w, { id: 'run-7', thread: 7, started: '2026-10-16T00:00:01.000Z' });

describe('drive', () => {
  it('walks a whole run: retry in the same session, a fresh review sending it back, a round cap, an answer, a merge', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'reply', body: 'Brief: add hello.txt' })],
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
      [start('r4'), reply({ kind: 'reply', body: 'Ready to merge.' })],
    ]);

    const asked = await run(drive(w, fresh(), hub));
    expect(asked).toMatchObject({ step: 'review', status: 'asking', reason: 'still not right', usd: 0.5 + 3 * 0.25 });
    expect(asked.rounds).toEqual({ review: 2 });
    expect(asked.sessions.implement).toEqual({ id: 'i1', home: '/homes/i1' });

    // the refused try pushed nothing; the passing one did, and opened pull request #8
    const forge = await run(Effect.flatMap(Forge, f => f.thread(7)));
    expect(forge.comments.map(c => c.body)).toEqual([
      '/bothub',
      'Brief: add hello.txt',
      'still not right\n\nAnswer with `/bothub <your answer>`, or `/bothub stop` to end the run.',
    ]);
    const pr = await run(Effect.flatMap(Forge, f => f.thread(8)));
    expect(pr.pull).toMatchObject({ branch: 'bothub/7', into: 'main' });
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
    const briefs = trace.flatMap(t => ('brief' in t ? [t.brief] : []));
    expect(briefs).toEqual(specs);
    const first = trace.findIndex(t => 'brief' in t && t.step === 'implement');
    expect(trace[first + 1]).toMatchObject({ step: 'implement', event: { type: 'start', session: 'i1' } });
    const replayed = trace.reduce<Partial<Run>>((run, t) => {
      if (!('saved' in t)) return run;
      const next: Partial<Run> = { ...run, ...t.saved };
      for (const k of t.cleared ?? []) delete next[k];
      return next;
    }, {});
    expect(replayed).toEqual(asked);
    const resumed = trace.flatMap(t => ('saved' in t && t.saved.sessions ? [t.saved.sessions] : []));
    expect(resumed).toContainEqual(expect.objectContaining({ implement: { id: 'i1', home: '/homes/i1' } }));
    const sessions = trace.flatMap(t => ('session' in t ? [t.session] : []));
    expect(sessions[1]).toEqual({ id: 'i1', resumed: false, ended: 'stop', exit: 0, usd: 0.5 });
    expect(sessions[2]).toMatchObject({ id: 'i1', resumed: true, ended: 'stop', exit: 0 });
    expect(sessions[3]).toMatchObject({ id: 'j', resumed: false, ended: 'stop', exit: 0 });
    const types = trace.flatMap(t => ('verdict' in t && t.verdict.check === 'types' ? [t] : []));
    expect(types[0]).toMatchObject({ verdict: { pass: false }, exit: 1 });
    expect(types[1]).toMatchObject({ verdict: { pass: true }, exit: 0 });
    const outcomes = trace.flatMap(t => ('outcome' in t ? [[t.step, t.outcome.kind, t.run.tries, t.run.rounds]] : []));
    expect(outcomes).toEqual([
      ['triage', 'pass', 0, {}],
      ['implement', 'refused', 1, {}],
      ['implement', 'pass', 0, {}],
      ['review', 'back', 0, { review: 1 }],
      ['implement', 'pass', 0, { review: 1 }],
      ['review', 'back', 0, { review: 2 }],
      ['implement', 'pass', 0, { review: 2 }],
      ['review', 'back', 0, { review: 2 }],
    ]);

    // a human answers on the thread: the review runs again and the run waits for the merge
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
      thread: 7,
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
      [start('t1'), reply({ kind: 'reply', body: 'Brief' })],
      [start('i1'), write('hello.txt', 'hello\n'), write('secret.txt', 'key\n'), reply(push, pull)],
    ]);
    const stopped = await run(drive(w, fresh(), hub));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped', tries: 0 });
    expect(stopped.reason).toMatch(/^safety: /);
    expect(specs).toHaveLength(2);
    expect(() => git(where.origin, 'rev-parse', '--verify', '-q', 'bothub/7')).toThrow();
    const thread = await run(Effect.flatMap(Forge, f => f.thread(7)));
    expect(thread.comments.at(-1)?.body).toBe(stopped.reason);
    const runs = await run(Effect.flatMap(Store, s => s.list({ status: 'stopped' })));
    expect(runs.map(r => r.id)).toEqual(['run-7']);
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
      Object.keys(hub.bots)
        .map(bot => `${bot}=${key}`)
        .join(',')
    );
    const session = harnesses({ data: where.data, proxy: { url: 'http://proxy', keys } }).pipe(Layer.provide(sandbox));
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), sandbox, session);
    await Effect.runPromise(drive(w, fresh(), hub).pipe(Effect.provide(layer)));
    const text = readFileSync(join(where.data, 'run-7', 'trace.jsonl'), 'utf8');
    expect(text).toContain('"brief"');
    expect(text).toContain('BOTHUB_LLM_API_KEY=***');
    expect(text).not.toContain(key);
  }, 30_000);
});

describe('setup', () => {
  const stopping = (): AgentEvent[][] => [
    [start('t1'), reply({ kind: 'reply', body: 'Brief' })],
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

const say = (where: ReturnType<typeof world>, m: Message) =>
  appendFileSync(join(where.forge, `${m.thread}.jsonl`), `${JSON.stringify(m)}\n`);

describe('tick', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });

  it('begins a run from a trusted command, drives it, and begins again only on a new command', async () => {
    const where = world();
    const at = '2026-10-16T00:00:01.000Z';
    say(where, {
      thread: 7,
      kind: 'comment',
      actor: 'mallory[bot]',
      trusted: false,
      at,
      comment: { id: 'x', author: 'mallory[bot]', body: '/bothub', at },
    });
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply(push)],
      [start('b'), reply({ kind: 'reply', body: 'Nothing left to do.' })],
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
        const asked = yield* drive(flow, begin(flow, { id: 'run-7', thread: 7, started: fresh().started }), small);
        const saved = git(where.origin, 'show', `${kept}:hello.txt`);
        return [asked, yield* drive(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small), saved];
      })
    );
    expect(asked).toMatchObject({ step: 'implement', status: 'asking', reason: 'Hello or hi?' });
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
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Add hello\nstate: open\nauthor: bothub[bot]\n---\n\nCloses #7\n'
    );
    mkdirSync(join(where.forge, '8'));
    writeFileSync(join(where.forge, '8', 'pull.json'), JSON.stringify({ branch: 'bothub/7', into: 'main', head: 'x' }));
    return Effect.flatMap(Store, s =>
      s.put({
        ...begin(merging.workflows.issue, { id: 'run-7', thread: 7, started: '2026-10-16T00:00:01.000Z' }),
        step: 'merge',
        status: 'waiting',
        sessions: { implement: { id: 'a', home: '/homes/a' } },
      })
    );
  };
  const comment = (thread: number, actor: string, trusted: boolean, body: string, at: string): Message => ({
    thread,
    kind: 'comment',
    actor,
    trusted,
    at,
    comment: { id: at, author: actor, body, at },
  });

  it('wakes a run waiting at merge on a mention in its pull request and resumes the work session there', async () => {
    const where = world();
    say(where, comment(8, 'morgan', true, '@bothub please undo the greeting', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply(push, { kind: 'reply', body: 'Undone.' })],
    ]);
    const touched = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    expect(touched.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'waiting']]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.resume?.id).toBe('a');
    expect(specs[0]!.prompt).toBe('the merge step sent this back: please undo the greeting');
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain('Undone.');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).not.toContain('Undone.');
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
      [start('r'), reply({ kind: 'reply', body: 'Looks right.' })],
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
      say(where, { thread: 7, kind: 'merged', actor: 'morgan', trusted: true, at: later });
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
    const parked = (thread: number, status: Run['status']): Run => ({
      ...begin(small.workflows.issue!, { id: `run-${thread}`, thread, started: at }),
      status,
    });
    const answer = '2026-10-16T00:00:05.000Z';
    say(where, {
      thread: 8,
      kind: 'comment',
      actor: 'morgan',
      trusted: true,
      at: answer,
      comment: { id: 'a', author: 'morgan', body: '/bothub hi', at: answer },
    });
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply({ kind: 'reply', body: 'Done.' })],
      [start('b'), write('hello.txt', 'hello\n'), reply({ kind: 'reply', body: 'Done.' })],
    ]);
    for (const r of [parked(8, 'asking'), parked(9, 'waiting')]) {
      mkdirSync(join(where.data, r.id), { recursive: true });
      writeFileSync(join(where.data, r.id, 'run.json'), JSON.stringify(r));
    }
    const touched = await run(sweep(small));
    expect(touched.map(r => r.thread).sort()).toEqual([7, 8]);
    expect(touched.find(r => r.thread === 9)).toBeUndefined();
    expect(specs).toHaveLength(2);
    expect(specs.map(s => s.prompt).join('\n')).toContain('hi');
    expect(await run(Effect.flatMap(Store, s => s.read('run-9').pipe(Stream.runCollect)))).toHaveProperty('length', 0);
  }, 30_000);
});
