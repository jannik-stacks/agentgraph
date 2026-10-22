import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Chunk, Effect, Exit, FiberRef, Layer, Redacted, Stream, TestClock, TestContext } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { drive, gate, settle, sweep, tick } from '../src/engine.ts';
import { answerWith } from '../src/context.ts';
import { start as main, temporary } from '../src/main.ts';
import { harnesses } from '../src/harnesses.ts';
import { fileForge, Forge, ForgeError, provenance, type Event, type Mark, type Proposal } from '../src/forge.ts';
import { host, Sandbox, type Command } from '../src/sandbox.ts';
import type { Settings } from '../src/services.ts';
import { scripted, Session, type SessionEvent, type SessionSpec } from '../src/session.ts';
import { fileStore, Store, type Trace } from '../src/store.ts';
import type { Hub } from '../src/hub.ts';
import { begin, cancelled, reenter, transition, type Run, type Step } from '../src/workflow.ts';
import { git, hubOf } from './fixtures.ts';

const foot = (...lines: string[]) =>
  `<details><summary><sub>agentgraph</sub></summary>\n<sub>${lines.join(' ')}</sub>\n</details>`;
const replyHint = answerWith;
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

/** A bare origin with one commit on main, a forge with issue #7 and its `/agent` comment, and a data dir. */
const world = () => {
  const root = mkdtempSync(join(tmpdir(), 'agentgraph-run-'));
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
  human('/agent', '2026-10-16T00:00:00.000Z');
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
  final: `Done.\n\n\`\`\`agentgraph\n${proposals.map(p => JSON.stringify(p)).join('\n')}\n\`\`\``,
  ended: 'stop',
  exit: 0,
});
const push: Proposal = { kind: 'push', branch: 'agentgraph/7', message: 'Add hello' };
const pull: Proposal = {
  kind: 'pull_request',
  branch: 'agentgraph/7',
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
const services = (
  where: ReturnType<typeof world>,
  turns: SessionEvent[][],
  slug?: string,
  opened: (spec: SessionSpec) => unknown = () => undefined
) => {
  const specs: SessionSpec[] = [];
  const commands: Command[] = [];
  const order: (SessionSpec | Command)[] = [];
  const marks: [Proposal['kind'], Mark | undefined][] = [];
  const recording = Layer.effect(
    Session,
    Effect.map(Session, s => ({
      open: (spec: SessionSpec) => (specs.push(spec), order.push(spec), opened(spec), s.open(spec)),
    }))
  ).pipe(Layer.provide(scripted(turns)));
  const sandbox = Layer.effect(
    Sandbox,
    Effect.map(Sandbox, s => ({
      ...s,
      exec: (c: Command) => (commands.push(c), order.push(c), s.exec(c)),
    }))
  ).pipe(Layer.provide(host(where.origin)));
  const named = Layer.effect(
    Forge,
    Effect.map(Forge, f => ({
      ...f,
      ...(slug && { slug: Effect.succeed(slug) }),
      apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
        Effect.zipRight(
          Effect.map(FiberRef.get(provenance), mark => marks.push([p.kind, mark])),
          f.apply(n, p, work)
        ),
    }))
  ).pipe(Layer.provide(fileForge(where.forge)));
  const layer = Layer.mergeAll(named, fileStore(where.data), sandbox, recording);
  const run = <A, E>(effect: Effect.Effect<A, E, Forge | Store | Session | Sandbox>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { specs, commands, order, marks, run };
};

const traceOf = (data: string, id: string) =>
  readFileSync(join(data, id, 'trace.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Trace);

/** The 👀 a run gave and took back, in order, as the reaction id each took back or undefined when it gave one. */
const reactions = (data: string, id: string) =>
  traceOf(data, id).flatMap(t =>
    'applied' in t && t.applied.proposal.kind === 'react' ? [[t.applied.ok, t.applied.proposal.remove]] : []
  );

const bodies = (t: { events: Event[] }) => t.events.flatMap(m => (m.comment ? [m.comment.body] : []));

const fresh = (): Run => begin(w, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' });

describe('drive', () => {
  it('walks a whole run: retry in the same session, a fresh review sending it back, a round cap, an answer, a merge', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), write('hello.txt', 'TODO\n'), { type: 'usage', input: 10, output: 5, usd: 0.5 }, reply(push, pull)],
      judged,
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
    expect(asked).toMatchObject({ step: 'review', status: 'waiting', reason: 'still not right', usd: 0.5 + 4 * 0.25 });
    expect(asked.rounds).toEqual({ review: 2 });
    expect(asked.sessions.implement).toMatchObject({ id: 'i1', home: '/homes/i1', seen: { at: expect.any(String) } });

    // the failed try pushed nothing; the passing one did, and opened pull request #8
    const forge = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(bodies(forge)).toEqual([
      '/agent',
      'Waiting for an answer to the question below, at review.\n\nPull request: ' +
        join(where.forge, '8.md') +
        `\n\n${foot(replyHint)}`,
      'Brief: add hello.txt',
      'still not right',
    ]);
    expect(forge.labels).toEqual(['agentgraph:waiting']);
    const pr = await run(Effect.flatMap(Forge, f => f.issue(8)));
    expect(pr.pull).toMatchObject({ branch: 'agentgraph/7', base: 'main' });
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello world');
    expect(pr.pull?.head).toBe(git(where.origin, 'rev-parse', 'agentgraph/7'));
    expect(existsSync(join(where.forge, '8', 'diff.patch'))).toBe(true);

    // retry and ways back resume the implementor's session; review is fresh every time
    expect(specs.map(s => s.resume?.id)).toEqual([
      undefined,
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
    expect(specs[2]!.prompt).toContain('+TODO');
    expect(specs[3]!.prompt).toMatch(/^types: /);
    expect(specs[6]!.prompt).toBe('the review step sent this back: say hello world');
    expect(specs[1]!.prompt).toContain('Add hello.txt.');
    expect(specs[5]!.prompt).toContain('no hunk needs a change before it can merge');
    expect(specs[5]!.prompt).toContain('+hello');

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
    expect(sessions[2]).toMatchObject({ id: 'j', resumed: false, ended: 'stop', exit: 0 });
    expect(sessions[3]).toMatchObject({ id: 'i1', resumed: true, ended: 'stop', exit: 0 });
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
    where.human('/agent it is fine, ship it', '2026-10-17T00:00:00.000Z');
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

  it('writes to the forge under the run, its step and the session that proposed the write', async () => {
    const where = world();
    const { marks, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), write('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'back', why: 'say hello world' })],
    ]);
    await run(drive(w, fresh(), hub));
    const at = (step: string, session?: string) => ({ run: 'run-7', step, ...(session && { session }) });
    expect(marks).toEqual([
      ['label', at('triage')],
      ['comment', at('triage')],
      ['comment', at('triage', 't1')],
      ['comment', at('implement')],
      ['push', at('implement', 'i1')],
      ['pull_request', at('implement', 'i1')],
      ['comment', at('review')],
      ['comment', at('implement', 'i1')],
      ['comment', at('implement', 'i1')],
      ['label', at('implement', 'i1')],
      ['comment', at('implement', 'i1')],
    ]);
  }, 30_000);

  it('shows how to reply under a review comment', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('r'), reply({ kind: 'comment', body: 'Looked.' })]]);
    await run(drive(w, begin(w, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }), hub));
    expect(specs[0]!.prompt).toContain('"under":"<id of the review comment you answer>"');
  }, 30_000);

  it('opens one session over all items when a step fans out past 20', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('r'), reply({ kind: 'comment', body: 'Looked.' })]]);
    const fan = {
      ...w,
      steps: [{ name: 'review', does: { agent: 'reviewer' }, checks: [], tries: 1, each: { run: 'seq 21' } }],
    };
    const done = await run(drive(fan, begin(fan, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }), hub));
    expect(done.status).toBe('done');
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('1\n\n2\n\n');
    expect(specs[0]!.prompt).toContain('\n\n21');
  }, 30_000);

  it('shows a judging agent the diff host git sees, whatever attributes the checkout sets', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), write('.gitattributes', '* -diff\n'), write('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'ask', question: 'Done?' })],
    ]);
    await run(drive(w, fresh(), hub));
    expect(specs[2]!.agent).toBe('claim-checker');
    expect(specs[2]!.prompt).toContain('+hello');
    expect(specs[2]!.prompt).not.toContain('Binary files');
  }, 30_000);

  it('ends the run at once when a stop check fails: no try spent, nothing lands, the findings posted', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), write('hello.txt', 'hello\n'), write('secret.txt', 'key\n'), reply(push, pull)],
      judged,
    ]);
    const stopped = await run(drive(w, fresh(), hub));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped', tries: 0 });
    expect(stopped.reason).toMatch(/^safety: /);
    expect(specs).toHaveLength(3);
    expect(() => git(where.origin, 'rev-parse', '--verify', '-q', 'agentgraph/7')).toThrow();
    const issue = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(bodies(issue)[1]).toBe(`Stopped at implement: ${stopped.reason}\n\n${foot('Cost: $0.25.')}`);
    expect(issue.labels).toEqual(['agentgraph:stopped']);
    const runs = await run(Effect.flatMap(Store, s => s.list({ status: 'stopped' })));
    expect(runs.map(r => r.id)).toEqual(['run-7']);
  }, 30_000);

  it('traces a ref to the full output of every check it ran, which the store resolves', async () => {
    const where = world();
    const { run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), write('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
    ]);
    const loud = hubOf('acme-app', {
      types: { run: 'echo types ok' },
      safety: { run: 'echo secret.txt found; exit 1' },
      claims: { agent: 'claim-checker' },
    });
    await run(drive(w, fresh(), loud));
    const logged = traceOf(where.data, 'run-7').flatMap(t => ('check' in t && t.log ? [t] : []));
    const texts = await run(Effect.forEach(logged, t => Effect.flatMap(Store, s => s.logOf(t.log!.hash))));
    const byName = logged.map((t, i) => [t.check.check, t.check.pass, texts[i]] as const);
    expect(byName.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['claims', true, 'PASS, no claims'],
      ['safety', false, 'secret.txt found\n'],
      ['types', true, 'types ok\n'],
    ]);
    expect(logged.map(t => t.log!.bytes)).toEqual(texts.map(t => Buffer.byteLength(t!)));
  }, 30_000);

  it('measures a rework of its own open pull request from the pull request base, so a check sees earlier commits too', async () => {
    const where = world();
    const clone = join(where.root, 'clone');
    git(where.root, 'clone', '-q', where.origin, clone);
    git(clone, 'checkout', '-q', '-b', 'agentgraph/8');
    writeFileSync(join(clone, 'CHAT.md'), 'early\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'Touch CHAT.md');
    git(clone, 'push', '-q', 'origin', 'agentgraph/8');
    mkdirSync(join(where.forge, '8'), { recursive: true });
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Add hello\nstate: open\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
    );
    writeFileSync(
      join(where.forge, '8', 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/8', base: 'main', head: git(clone, 'rev-parse', 'HEAD') })
    );
    const { run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), write('hello.txt', 'hello\n'), reply({ ...push, branch: 'agentgraph/8' })],
    ]);
    const scoped = hubOf('acme-app', {
      safety: { run: '! git diff --name-only $AGENTGRAPH_BASE | grep -qx CHAT.md' },
    });
    const stopped = await run(drive(w, begin(w, { id: 'run-8', issue: 8, started: fresh().started }), scoped));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped' });
    expect(stopped.reason).toMatch(/^safety: /);
  }, 30_000);

  it('lets a check read the issue as the agent saw it, its number and the reply', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), write('hello.txt', 'hello\n'), reply(push, pull)],
    ]);
    const reads = hubOf('acme-app', {
      safety: { run: 'cat "$AGENTGRAPH_CONTEXT"; echo "issue $AGENTGRAPH_ISSUE"; cat "$AGENTGRAPH_REPLY"; exit 1' },
    });
    const stopped = await run(drive(w, fresh(), reads));
    expect(stopped.reason).toContain('## #7 Add a greeting\n\nAdd hello.txt.');
    expect(stopped.reason).toContain(': Brief: add hello.txt');
    expect(stopped.reason).toContain('issue 7\nDone.');
    const seen = stopped.reason!.slice('safety: '.length, stopped.reason!.indexOf('issue 7'));
    expect(specs[1]!.prompt).toContain(seen.trim());
  });

  it('prompts a step with its skill, then the skills it uses, in order', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('t1'), reply({ kind: 'ask', question: 'Which file?' })]]);
    const rules = { name: 'rules', path: 'skills/rules.md', body: 'Keep it small.' };
    const uses = { ...hub.skills.triage!, uses: ['rules', 'implement'] };
    await run(drive(w, fresh(), { ...hub, skills: { ...hub.skills, rules, triage: uses } }));
    expect(specs[0]!.prompt).toContain('You are triage.\n\nKeep it small.\n\nYou are implement.');
  });

  it('fails an implementing try that changed nothing, with feedback, instead of passing it on', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), reply({ kind: 'comment', body: 'This already appears to be implemented.' })],
      [start('i1'), reply({ kind: 'ask', question: 'Is it done already?' })],
    ]);
    const asked = await run(drive(w, fresh(), hub));
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Is it done already?' });
    expect(specs[2]!.prompt).toContain('no change was made');
    const outcomes = traceOf(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(outcomes).toContainEqual(
      expect.objectContaining({ kind: 'failed', problems: [expect.stringMatching(/^no change was made/)] })
    );
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

  it('parks the run at its step when a session cannot run, and an answer tries that step again', async () => {
    const where = world();
    const { run } = services(where, []);
    const parked = await run(drive(w, { ...fresh(), feedback: 'fix the typo' }, hub));
    expect(parked).toMatchObject({ step: 'triage', status: 'waiting', feedback: 'fix the typo' });
    expect(parked.reason).toBe(
      'Stopped by a runner error (SessionStop). The details are in the trace of run run-7. Reply to try triage again from where it was.'
    );
    const stops = traceOf(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(stops).toContainEqual({ kind: 'ask', question: 'SessionStop: no scripted session left' });
    const sessions = traceOf(where.data, 'run-7').flatMap(t => ('session' in t ? [t.session] : []));
    expect(sessions[0]).toEqual({ resumed: false, ended: 'provider', usd: 0 });
    const again = services(where, [[start('t1'), reply({ kind: 'ask', question: 'Which file?' })]]);
    const resumed = await again.run(drive(w, transition(w, parked, { kind: 'answer', text: 'go on' }), hub));
    expect(resumed).toMatchObject({ step: 'triage', status: 'waiting', reason: 'Which file?' });
    expect(again.specs[0]!.prompt).toContain('go on');
    expect(again.specs[0]!.prompt).toContain('fix the typo');
    expect(resumed.retried).toBeUndefined();
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
                state: { status: 'completed', input: { command: 'env' }, output: `AGENTGRAPH_LLM_API_KEY=${key}` },
              },
            }),
            'agentgraph-exit 0',
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
    expect(text).toContain('AGENTGRAPH_LLM_API_KEY=***');
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
    const setup = traceOf(where.data, 'run-7').flatMap(t => ('setup' in t ? [t] : []));
    expect(setup).toEqual([expect.objectContaining({ step: 'triage', setup: { ms: expect.any(Number), exit: 0 } })]);
  }, 30_000);

  it('parks the run as infra with the output when setup fails, before any step', async () => {
    const where = world();
    const { specs, run } = services(where, []);
    const failing = { ...hub, setup: 'echo registry unreachable; exit 3' };
    const parked = await run(Effect.flatMap(drive(w, fresh(), failing), r => drive(w, r, failing)));
    expect(parked).toMatchObject({ step: 'triage', status: 'waiting', tries: 0 });
    expect(specs).toHaveLength(0);
    const stops = traceOf(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(stops).toContainEqual({ kind: 'ask', question: 'SandboxError: setup exited 3: registry unreachable' });
    expect(traceOf(where.data, 'run-7').some(t => 'setup' in t && t.setup.exit === 3)).toBe(true);
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
    '---\ntitle: Add hello\nstate: open\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
  );
  mkdirSync(join(where.forge, '8'), { recursive: true });
  writeFileSync(
    join(where.forge, '8', 'pull.json'),
    JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: 'x', baseSha: base })
  );
};

describe('a run branch that moved', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });
  const flow = {
    ...small.workflows.issue!,
    steps: small.workflows.issue!.steps.map(s => ({ ...s, checks: ['types'] })),
  };

  it.each([false, true])(
    'rebases saved edits onto the branch tip before the agent starts (conflict: %s)',
    async conflict => {
      const where = world();
      git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
      const first = services(where, [
        [start('a'), write('hello.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })],
      ]);
      const parked = await first.run(
        drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small)
      );
      const mover = join(where.root, 'mover');
      git(where.root, 'clone', '-q', where.origin, mover);
      writeFileSync(join(mover, conflict ? 'hello.txt' : 'other.txt'), 'upstream\n');
      git(mover, 'add', '-A');
      git(mover, 'commit', '-qm', 'Other session');
      git(mover, 'push', '-q', 'origin', 'HEAD:agentgraph/7');
      const tip = git(mover, 'rev-parse', 'HEAD');
      let before = '';
      const next = services(
        where,
        [[start('a'), ...(conflict ? [write('hello.txt', 'resolved\n')] : []), reply(push)]],
        undefined,
        spec => {
          before = readFileSync(join(spec.dir, 'hello.txt'), 'utf8');
          if (!conflict) expect(readFileSync(join(spec.dir, 'other.txt'), 'utf8')).toBe('upstream\n');
        }
      );
      const { reason: _reason, ...resumed } = parked;
      const done = await next.run(drive(flow, { ...resumed, status: 'running' }, small));
      expect(done.status).toBe('done');
      expect(next.specs).toHaveLength(1);
      expect(before).toMatch(conflict ? /<<<<<<<[\s\S]*upstream[\s\S]*pending/ : /^pending\n$/);
      if (conflict) expect(next.specs[0]!.prompt).toContain('Resolve each conflict');
      expect(git(where.origin, 'rev-parse', 'agentgraph/7^')).toBe(tip);
      expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe(conflict ? 'resolved' : 'pending');
      const rebases = traceOf(where.data, 'run-7').flatMap(t =>
        'applied' in t && t.applied.proposal.kind === 'rebase' ? [t.applied.ok] : []
      );
      expect(rebases).toEqual([!conflict]);
    },
    30_000
  );

  it.each([0, 1])(
    'replays saved work onto the rebased tip before try %s',
    async tries => {
      const where = world();
      const seed = join(where.root, 'seed');
      writeFileSync(join(seed, 'hello.txt'), 'hello\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-qm', 'Greeting');
      git(seed, 'push', '-q', where.origin, 'HEAD:agentgraph/7');
      const first = services(where, [
        [start('a'), write('pending.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })],
      ]);
      const parked = await first.run(
        drive(flow, { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), tries }, small)
      );
      const from = git(where.origin, 'rev-parse', 'main');
      git(seed, 'checkout', '-q', '--detach', from);
      writeFileSync(join(seed, 'other.txt'), 'upstream\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-qm', 'Base moved');
      git(seed, 'push', '-q', where.origin, 'HEAD:main');
      const onto = git(seed, 'rev-parse', 'HEAD');
      await first.run(
        Effect.scoped(
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            const forge = yield* Forge;
            const work = yield* sandbox.checkout('main', 'agentgraph/7');
            expect(yield* forge.apply(7, { kind: 'rebase', branch: 'agentgraph/7', from, onto }, work)).toMatchObject({
              ok: true,
            });
          })
        )
      );
      const tip = git(where.origin, 'rev-parse', 'agentgraph/7');
      const next = services(where, [[start('a'), reply(push)]], undefined, spec => {
        expect(readFileSync(join(spec.dir, 'other.txt'), 'utf8')).toBe('upstream\n');
        expect(readFileSync(join(spec.dir, 'pending.txt'), 'utf8')).toBe('pending\n');
      });
      const done = await next.run(drive(flow, { ...parked, status: 'running', onto: { sha: onto } }, small));
      expect(done.status).toBe('done');
      expect(next.specs).toHaveLength(1);
      const pushes = traceOf(where.data, 'run-7').flatMap(t =>
        'applied' in t && t.applied.proposal.kind === 'push' ? [t.applied.ok] : []
      );
      expect(pushes).toEqual([true]);
      expect(git(where.origin, 'show', 'agentgraph/7:pending.txt')).toBe('pending');
      expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
      expect(traceOf(where.data, 'run-7')).toContainEqual(
        expect.objectContaining({
          applied: expect.objectContaining({
            proposal: expect.objectContaining({ kind: 'rebase', onto: tip }),
            ok: true,
          }),
        })
      );
    },
    30_000
  );

  it('returns a refused push to the agent without posting its replies or other writes', async () => {
    const where = world();
    const attempted: Proposal[] = [];
    const failing = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          attempted.push(p);
          return p.kind === 'push'
            ? Effect.succeed({ proposal: p, ok: false, reason: 'branch moved' })
            : f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const skipped: Proposal[] = [
      { kind: 'comment', body: 'Fixed', under: 'review-1' },
      { kind: 'comment', body: 'Changes landed' },
      { kind: 'label', add: ['done'] },
      { kind: 'issue', title: 'Follow up', body: '## Done when\nDetails', relation: 'follow-up' } as Proposal,
    ];
    const session = scripted([
      [start('a'), write('hello.txt', 'hello\n'), reply(...skipped, push)],
      [start('a'), reply({ kind: 'ask', question: 'Retry later' })],
    ]);
    const layer = Layer.mergeAll(failing, fileStore(where.data), host(where.origin), session);
    const done = await Effect.runPromise(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(Effect.provide(layer))
    );
    expect(done).toMatchObject({ status: 'waiting', reason: 'Retry later' });
    expect(attempted.some(p => skipped.some(s => JSON.stringify(s) === JSON.stringify(p)))).toBe(false);
    const failed = traceOf(where.data, 'run-7').flatMap(t =>
      'outcome' in t && t.outcome.kind === 'failed' ? [t.outcome] : []
    );
    expect(failed[0]!.proposals.map(a => a.proposal)).toEqual([push, ...skipped]);
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).not.toContain('Changes landed');
  }, 30_000);
});

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
      comment: { id: 'x', author: 'mallory[bot]', body: '/agent', at },
    });
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply(push)],
      [start('b'), reply({ kind: 'comment', body: 'Nothing left to do.' })],
    ]);
    const first = await run(tick(small));
    expect(first.map(r => [r.id, r.status])).toEqual([['issue-7-20261016000000000', 'done']]);
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(await run(tick(small))).toEqual([]);
    where.human('/agent once more', '2026-10-17T00:00:00.000Z');
    const second = await run(tick(small));
    expect(second.map(r => [r.id, r.status])).toEqual([['issue-7-20261017000000000', 'done']]);
    expect(specs).toHaveLength(2);
    expect(specs[1]!.prompt).toContain('@morgan: /agent once more');
    expect(readFileSync(join(where.forge, '7.reactions'), 'utf8')).toBe('');
    expect(reactions(where.data, first[0]!.id)).toEqual([
      [true, undefined],
      [true, '2026-10-16T00:00:00.000Z'],
    ]);
    expect(reactions(where.data, second[0]!.id)).toEqual([
      [true, undefined],
      [true, '2026-10-17T00:00:00.000Z'],
    ]);
  }, 30_000);

  it.each([
    [true, 'files changed but nothing was pushed'],
    [false, 'a pass needs a pull request or an ask'],
  ])(
    'fails a commanded first try that only comments while no pull request holds its work (edits %s)',
    async (edits, why) => {
      const where = world();
      const { specs, run } = services(where, [
        [start('a'), ...(edits ? [write('hello.txt', 'hello\n')] : []), reply({ kind: 'comment', body: 'Looked.' })],
        [start('a'), reply({ kind: 'ask', question: 'Push it?' })],
      ]);
      const [asked] = await run(tick(small));
      expect(asked).toMatchObject({ status: 'waiting', reason: 'Push it?' });
      expect(specs[0]!.prompt).not.toContain('answer it with comment proposals only');
      expect(specs[1]!.prompt).toContain(why);
    },
    30_000
  );

  it('goes on past a commanded first step that may only comment while no pull request holds the work', async () => {
    const where = world();
    const flow = small.workflows.issue!;
    const triaged = {
      ...small,
      agents: {
        ...small.agents,
        triager: { ...small.agents.implementor!, name: 'triager', returns: ['comment' as const] },
      },
      workflows: {
        issue: {
          ...flow,
          steps: [{ ...flow.steps[0]!, name: 'triage', does: { agent: 'triager' }, checks: [] }, flow.steps[0]!],
        },
      },
    };
    const { specs, run } = services(where, [
      [start('a'), reply({ kind: 'comment', body: 'Looks like a parser bug.' })],
      [start('b'), reply({ kind: 'ask', question: 'Which parser?' })],
    ]);
    const [asked] = await run(tick(triaged));
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Which parser?' });
    expect(specs[0]!.prompt).not.toContain('answer it with comment proposals only');
  }, 30_000);

  it('applies nothing from a reply with an invented reply kind and asks for every proposal again', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply(push, pull, { kind: 'reply', body: 'Done.' } as never)],
      [start('a'), reply({ kind: 'ask', question: 'Again?' })],
    ]);
    await run(tick(small));
    expect(specs[1]!.prompt).toContain('use comment, it is posted under the thread you are answering');
    expect(specs[1]!.prompt).toContain('nothing from this reply was applied: send every proposal again');
    expect(git(where.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
  }, 30_000);

  it('keeps the worktree files of a parked run and puts them back when it reenters', async () => {
    const where = world();
    const flow = small.workflows.issue!;
    const { run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Hello or hi?' })],
      [start('a'), write('bye.txt', 'bye\n'), reply(push)],
    ]);
    const kept = 'refs/agentgraph/runs/run-7';
    const [asked, done, saved] = await run(
      Effect.gen(function* () {
        const asked = yield* drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small);
        const saved = git(where.origin, 'show', `${kept}:hello.txt`);
        return [asked, yield* drive(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small), saved];
      })
    );
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Hello or hi?' });
    console.log(done!.step, done!.reason, JSON.stringify(bodies(await run(Effect.flatMap(Forge, f => f.issue(7))))));
    expect(saved).toBe('hello');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(git(where.origin, 'show', 'agentgraph/7:bye.txt')).toBe('bye');
    expect(git(where.origin, 'log', '--format=%s', 'main..agentgraph/7')).toBe('Add hello');
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

  it('takes an approval that came before a later trace line of the waiting run, such as a rebase', async () => {
    const where = world();
    const at = (s: number) => `2026-10-16T00:00:0${s}.000Z`;
    const settled = { kind: 'pass' as const };
    say(where, { issue: 8, kind: 'approved', actor: 'morgan', trusted: true, at: at(5) });
    const { run } = services(where, []);
    await run(waiting(where));
    await run(
      Effect.flatMap(Store, s =>
        s.trace(
          'run-7',
          {
            at: at(2),
            step: 'implement',
            outcome: settled,
            run: { step: 'merge', status: 'waiting', tries: 0, rounds: {} },
          },
          { at: at(9), step: 'merge', applied: { proposal: { kind: 'label', add: ['x'] }, ok: true } }
        )
      )
    );
    const touched = await run(tick(merging, 7));
    expect(touched.map(r => [r.id, r.status])).toEqual([['run-7', 'done']]);
  }, 30_000);

  it('passes on an approval without taking the follow-up asks that came with it', async () => {
    const where = world();
    say(where, comment(8, 'morgan', true, '@agent please file a follow-up for the docs', '2026-10-16T00:00:05.000Z'));
    say(where, { issue: 8, kind: 'approved', actor: 'morgan', trusted: true, at: '2026-10-16T00:00:06.000Z' });
    const { specs, run } = services(where, [[start('b'), reply({ kind: 'comment', body: 'Filed.' })]]);
    await run(waiting(where));
    const touched = await run(tick(merging, 7));
    expect(touched.find(r => r.id === 'run-7')).toMatchObject({ status: 'done', said: [{ issue: 8 }] });
    expect(specs.map(s => s.prompt).join()).toContain('please file a follow-up for the docs');
  }, 30_000);

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
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
  }, 30_000);

  it('sends a run waiting at merge back when the aside a mention starts proposes back, resuming its fork', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent please undo the greeting', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('f'), reply({ kind: 'comment', body: 'Will undo.' }, { kind: 'back', why: 'undo the greeting' })],
      [start('f'), write('hello.txt', 'hello\n'), reply(push, { kind: 'comment', body: 'Undone.' })],
    ]);
    const touched = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    expect(touched.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'waiting']]);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ resume: { id: 'a' }, fork: true });
    expect(specs[0]!.prompt).toContain('please undo the greeting');
    expect(specs[1]!.resume?.id).toBe('f');
    expect(specs[1]!.fork).toBeUndefined();
    expect(specs[1]!.prompt).toMatch(
      /^the merge step sent this back: undo the greeting\n\n## New since you last looked/
    );
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain('Will undo.');
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain('Undone.');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).not.toContain('Undone.');
    const marks = traceOf(where.data, 'run-7').filter(t => t.step === 'merge');
    expect(marks.flatMap(t => ('prompt' in t && t.aside ? [t.aside] : []))).toEqual([
      { issue: 8, comment: '2026-10-16T00:00:05.000Z' },
    ]);
    expect(marks.flatMap(t => ('session' in t ? [!!t.session.aside] : []))).toEqual([true]);
    expect(readFileSync(join(where.forge, '8.reactions'), 'utf8')).toBe('');
    expect(reactions(where.data, 'run-7')).toEqual([
      [true, undefined],
      [true, '2026-10-16T00:00:05.000Z'],
    ]);
  }, 30_000);

  it('retries an aside that errors once, then answers the human with a short comment and moves on', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent why the greeting?', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, []);
    await run(waiting(where));
    const stored = () => run(Effect.flatMap(Store, st => st.list({ issue: 7 }))).then(rs => rs[0]!);
    await run(tick(merging, 7));
    const first = await stored();
    expect(first).toMatchObject({ step: 'merge', status: 'waiting', retried: true });
    expect(first.seen).not.toBe('2026-10-16T00:00:05.000Z');
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).not.toContain('Could not answer');
    await run(tick(merging, 7));
    const second = await stored();
    expect(second).toMatchObject({ step: 'merge', status: 'waiting', seen: '2026-10-16T00:00:05.000Z' });
    expect(second.retried).toBeUndefined();
    expect(specs).toHaveLength(2);
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain(
      'Could not answer: SessionStop. Reply again to retry.'
    );
  }, 30_000);

  it('answers a waiting run started by a label on a command, without starting the command workflow', async () => {
    const where = world();
    const triage = { ...merging.workflows.issue, name: 'triage', on: { issues: { label: 'triage' } } };
    const both = { ...merging, workflows: { ...merging.workflows, triage } };
    say(where, comment(7, 'morgan', true, '/agent the second one', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'Thanks.' })],
    ]);
    await run(
      Effect.flatMap(Store, s =>
        s.put({
          ...begin(triage, { id: 'triage-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
          status: 'waiting',
          reason: 'Which one?',
        })
      )
    );
    const touched = await run(tick(both, 7));
    expect(touched.map(r => r.id)).toEqual(['triage-7']);
    expect((await run(Effect.flatMap(Store, s => s.list({ issue: 7 })))).map(r => r.workflow)).toEqual(['triage']);
    expect(specs.map(s => s.prompt).join('\n')).toContain('the second one');
  });

  it('takes a burst on a waiting run as one answer, and a label starts nothing while another run holds the issue', async () => {
    const where = world();
    const triage = { ...merging.workflows.issue, name: 'triage', on: { issues: { label: 'triage' } } };
    const fix = { ...merging.workflows.issue, name: 'fix', on: { issues: { label: 'fix' } } };
    const all = { ...merging, workflows: { ...merging.workflows, triage, fix } };
    say(where, comment(7, 'morgan', true, '/agent the second one', '2026-10-16T00:00:05.000Z'));
    say(where, comment(7, 'ana', true, '/agent and keep it short', '2026-10-16T00:00:06.000Z'));
    say(where, { issue: 7, kind: 'label', actor: 'ana', trusted: true, at: '2026-10-16T00:00:07.000Z', label: 'fix' });
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Short how?' })]]);
    const asked = { ...begin(triage, { id: 'triage-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }) };
    await run(Effect.flatMap(Store, s => s.put({ ...asked, status: 'waiting', reason: 'Which one?' })));
    await run(tick(all, 7));
    expect((await run(Effect.flatMap(Store, s => s.list({ issue: 7 })))).map(r => r.workflow)).toEqual(['triage']);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('the second one\n\nand keep it short');
  });

  it('waits for an issue to settle before a burst starts work, and never starts again on what a run took in', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('a'), write('hello.txt', 'hello\n'), reply(push, pull)]]);
    where.human('/agent hello', new Date().toISOString());
    expect(await run(tick(small, undefined, false, settle))).toEqual([]);
    const [done] = await run(tick(small));
    console.log(done!.step, done!.reason, JSON.stringify(bodies(await run(Effect.flatMap(Forge, f => f.issue(7))))));
    expect(done!.seen! >= done!.started).toBe(true);
    expect(await run(tick(small))).toEqual([]);
    expect(specs).toHaveLength(1);
  }, 30_000);

  it('answers a question at merge from a fork of the work session, under its thread, and keeps waiting', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const at = '2026-10-16T00:00:05.000Z';
    const asked = 'so the greeting was already documented in the README?';
    say(where, {
      ...comment(8, 'morgan', true, `/agent ${asked}`, at),
      comment: { id: 'r1', author: 'morgan', body: `/agent ${asked}`, at, path: 'hello.txt', line: 1 },
    });
    const { specs, run } = services(where, [
      [
        start('f'),
        { type: 'usage', input: 4, output: 2, usd: 0.5 },
        reply({ kind: 'comment', body: 'No, README.md only says demo.' }),
      ],
    ]);
    const touched = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    expect(touched).toMatchObject([{ id: 'run-7', step: 'merge', status: 'waiting', usd: 0.5 }]);
    expect(touched[0]!.sessions).toEqual({ implement: { id: 'a', home: '/homes/a' } });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ resume: { id: 'a', home: '/homes/a' }, fork: true });
    expect(specs[0]!.prompt).toContain(asked);
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under])).toEqual([
      ['No, README.md only says demo.', 'r1'],
    ]);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(git(where.origin, 'rev-parse', 'main'));
  }, 30_000);

  it('answers a burst of review comments once, under the newest thread, and holds none of them once answered', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const line = (id: string, body: string, at: string): Event => ({
      ...comment(8, 'morgan', true, body, at),
      comment: { id, author: 'morgan', body, at, path: 'hello.txt', line: 1 },
    });
    say(where, line('r1', '/agent why hello?', '2026-10-16T00:00:05.000Z'));
    say(where, line('r2', '/agent and CHAT.md?', '2026-10-16T00:00:06.000Z'));
    const { run } = services(where, [[start('f'), reply({ kind: 'comment', body: 'Both asked for.' })]]);
    const [answered] = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under])).toEqual([
      ['Both asked for.', 'r2'],
    ]);
    expect(answered!.said).toEqual([{ issue: 8 }]);
  }, 30_000);

  it('replies to a plain comment on a thread with a finished run, not to one for someone else or on another thread', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '9.md'),
      '---\ntitle: Other\nstate: open\nauthor: morgan\nlabels: []\n---\n\nOther.\n'
    );
    say(where, comment(9, 'morgan', true, 'where is the PR?', '2026-10-16T00:00:02.000Z'));
    say(where, comment(7, 'morgan', true, '@alice can you look?', '2026-10-16T00:00:03.000Z'));
    say(where, comment(7, 'mallory', false, 'where is the PR?', '2026-10-16T00:00:04.000Z'));
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'No PR yet.' })]]);
    const done = { ...begin(issue, { id: 'issue-7-done', issue: 7, started: '2026-10-16T00:00:01.000Z' }) };
    await run(Effect.flatMap(Store, s => s.put({ ...done, status: 'done' })));
    const twice = {
      ...small,
      workflows: { issue: { ...issue, steps: [...issue.steps, { ...issue.steps[0]!, name: 'again' }] } },
    };
    expect(await run(tick(twice))).toEqual([]);
    where.human('/agent where is the PR?', '2026-10-16T00:00:05.000Z');
    const touched = await run(tick(twice));
    expect(touched.map(r => [r.id, r.status, r.said])).toEqual([['issue-7-20261016000005000', 'done', [{ issue: 7 }]]]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('@morgan: /agent where is the PR?');
    expect(specs[0]!.prompt).toContain('When it does not ask for work, answer it with comment proposals only');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).toContain('No PR yet.');
  });

  it('ignores mentions from untrusted people and its own comments, and stops on a command on the issue', async () => {
    const where = world();
    say(where, comment(8, 'mallory', false, '/agent undo everything', '2026-10-16T00:00:05.000Z'));
    say(where, comment(8, 'agentgraph[bot]', false, '/agent undo everything', '2026-10-16T00:00:06.000Z'));
    const { specs, run } = services(where, []);
    expect(await run(Effect.zipRight(waiting(where), tick(merging, 7)))).toEqual([]);
    where.human('/agent stop not needed', '2026-10-16T00:00:07.000Z');
    const stopped = await run(tick(merging, 7));
    expect(stopped.map(r => [r.id, r.status, r.reason])).toEqual([['run-7', 'stopped', 'not needed']]);
    expect(specs).toHaveLength(0);
  }, 30_000);

  it('restarts a finished run at the step a command names, keeping its answers', async () => {
    const where = world();
    const answers = [{ asked: 'Hello or hi?', said: 'hello' }];
    const { specs, run } = services(where, [[start('i'), reply({ kind: 'ask', question: 'Which file?' })]]);
    await run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'stopped', answers })));
    where.human('/agent restart implement', '2026-10-16T00:01:00.000Z');
    const touched = await run(tick(hub));
    expect(touched.map(r => [r.id, r.step, r.status, r.answers])).toEqual([
      ['issue-7-20261016000100000', 'implement', 'waiting', answers],
    ]);
    expect(specs.map(s => s.agent)).toEqual(['implementor']);
  }, 30_000);

  it('restarts a waiting run from the first step: the old run stops and a new one begins', async () => {
    const where = world();
    const answers = [{ asked: 'Hello or hi?', said: 'hello' }];
    const { run } = services(where, [[start('t'), reply({ kind: 'ask', question: 'Which file?' })]]);
    await run(
      Effect.flatMap(Store, s =>
        s.put({ ...fresh(), step: 'implement', status: 'waiting', reason: 'Hello or hi?', answers })
      )
    );
    where.human('/agent restart', '2026-10-16T00:01:00.000Z');
    await run(tick(hub));
    const stored = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored.map(r => [r.id, r.step, r.status, r.reason]).sort()).toEqual([
      ['issue-7-20261016000100000', 'triage', 'waiting', 'Which file?'],
      ['run-7', 'implement', 'stopped', 'a human restarted it'],
    ]);
    expect(stored.find(r => r.id !== 'run-7')!.answers).toEqual(answers);
  }, 30_000);

  it('ends a run waiting at merge done when its pull request is merged and its issue closed with it', async () => {
    const where = world();
    const { run } = services(where, []);
    await run(waiting(where));
    const at = '2026-10-16T00:00:05.000Z';
    for (const n of [7, 8]) {
      const file = join(where.forge, `${n}.md`);
      writeFileSync(file, readFileSync(file, 'utf8').replace('state: open', `state: ${n === 7 ? 'closed' : 'merged'}`));
    }
    say(where, { issue: 7, kind: 'closed', actor: 'morgan', trusted: true, at });
    say(where, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at });
    const swept = await run(sweep(merging));
    expect(swept.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'done']]);
  });
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
      { kind: 'push', branch: 'agentgraph/9', message: 'Add bye' },
      { kind: 'pull_request', branch: 'agentgraph/9', base: 'main', title: 'Add bye', body: 'Stacks on #7. Closes #9' }
    ),
  ];

  /** Pull request #8 on agentgraph/7 with hello.txt, issue #9 that stacks on #7, and `move` to push to agentgraph/7 again. */
  const parent = (where: ReturnType<typeof world>) => {
    const clone = join(where.root, 'clone');
    git(where.root, 'clone', '-q', where.origin, clone);
    git(clone, 'checkout', '-q', '-b', 'agentgraph/7');
    const move = (file: string, content: string) => {
      writeFileSync(join(clone, file), content);
      git(clone, 'add', '-A');
      git(clone, 'commit', '-q', '-m', `Write ${file}`);
      git(clone, 'push', '-q', 'origin', 'agentgraph/7');
      const head = git(clone, 'rev-parse', 'HEAD');
      writeFileSync(
        join(where.forge, '8', 'pull.json'),
        JSON.stringify({ branch: 'agentgraph/7', base: 'main', head })
      );
      return head;
    };
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Add hello\nstate: open\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
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
      base: { pull: 8, branch: 'agentgraph/7', sha: head },
    });
    expect(specs[0]!.prompt).toContain('pull requests go into agentgraph/7.');
    const pr = pr10(where);
    expect(pr.pull).toMatchObject({ branch: 'agentgraph/9', base: 'agentgraph/7' });
    expect(pr.body).toMatch(/\n\nCloses #9\n\nStacks on #8\n?$/);
    expect(pr.diff).toContain('bye.txt');
    expect(pr.diff).not.toContain('hello.txt');
    expect(git(where.origin, 'rev-parse', 'agentgraph/9~1')).toBe(head);
  }, 30_000);

  it('with stacks off, opens the same issue as an independent pull request off main', async () => {
    const where = world();
    parent(where);
    const { specs, run } = services(where, [child()]);
    const parked = await run(drive(flow, run9(), { ...merging, stacks: false }));
    expect(parked.base).toBeUndefined();
    expect(specs[0]!.prompt).toContain('pull requests go into main.');
    const pr = pr10(where);
    expect(pr.pull).toMatchObject({ branch: 'agentgraph/9', base: 'main' });
    expect(pr.body).not.toContain('Stacks on');
    expect(git(where.origin, 'rev-parse', 'agentgraph/9~1')).toBe(git(where.origin, 'rev-parse', 'main'));
  }, 30_000);

  it('rebases the branch onto the new head when #8 moves, keeping its own commit on top', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child()]);
    await run(drive(flow, run9(), merging));
    const moved = move('more.txt', 'more\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9~1')).toBe(moved);
    expect(git(where.origin, 'log', '--format=%s', 'agentgraph/7..agentgraph/9')).toBe('Add bye');
    expect(saved(where)).toMatchObject({ status: 'waiting', base: { sha: moved } });
    const pr = pr10(where);
    expect(pr.pull.head).toBe(git(where.origin, 'rev-parse', 'agentgraph/9'));
    expect(pr.diff).not.toContain('more.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/9');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9')).toBe(before);
  }, 30_000);

  it('says on the issue when the branch does not rebase cleanly and leaves it where it was', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child('hello and bye\n', 'hello.txt')]);
    await run(drive(flow, run9(), merging));
    const before = git(where.origin, 'rev-parse', 'agentgraph/9');
    const moved = move('hello.txt', 'hi\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9')).toBe(before);
    expect(readFileSync(join(where.forge, '9.jsonl'), 'utf8')).toContain('#8 moved and agentgraph/9 could not follow');
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
      `AGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_SLUG=stx-agentgraph\nAGENTGRAPH_APP_KEY_FILE="${key}"\nAGENTGRAPH_INSTALLATION_ID=7\n`
    );
    const sandbox = join(import.meta.dirname, '..', 'examples', 'sandbox');
    const env = {
      AGENTGRAPH_APP_ENV: join(where.root, 'app.env'),
      AGENTGRAPH_PROXY_KEYS: 'implementor=k1,reviewer=k2',
      AGENTGRAPH_HUB: sandbox,
    };
    Object.assign(process.env, env);
    const seen: Settings[] = [];
    const fix: Proposal = { ...push, message: 'feat: add hello' };
    const turns = [
      [start('i'), write('hello.txt', 'TODO\n'), reply(fix)],
      [start('i'), write('hello.txt', 'hello\n'), reply(fix)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ];
    const doubles = (s: Settings) => {
      seen.push(s);
      return Layer.mergeAll(fileForge(where.forge), fileStore(s.data), host(where.origin), scripted(turns));
    };
    const one = { hub: sandbox, issue: 7, data: where.data };
    writeFileSync(join(where.forge, '7.jsonl'), '');
    say(where, {
      issue: 7,
      kind: 'label',
      label: 'agent:ready',
      actor: 'morgan',
      trusted: true,
      at: new Date().toISOString(),
    });
    try {
      const parked = await main(one, doubles);
      expect(parked.map(r => [r.step, r.status, r.tries])).toEqual([['merge', 'waiting', 0]]);
      expect(seen[0]).toMatchObject({
        repo: 'acme/sandbox',
        data: where.data,
        forge: { id: '42' },
      });
      expect(Redacted.value((seen[0]!.forge as { key: Redacted.Redacted }).key)).toBe('PEM');
      expect(Redacted.value(seen[0]!.proxy.keys)).toBe('implementor=k1,reviewer=k2');
      expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');

      const later = new Date(Date.now() + 1000).toISOString();
      say(where, { issue: 7, kind: 'merged', actor: 'morgan', trusted: true, at: later });
      const done = await main(one, doubles);
      expect(done.map(r => [r.id, r.status])).toEqual([[parked[0]!.id, 'done']]);
    } finally {
      for (const name of Object.keys(env)) delete process.env[name];
    }
  }, 30_000);
});

describe('temporary', () => {
  it('names a data dir under a temp dir, by its own path or through a link, and its mirror', () => {
    const home = mkdtempSync(join(homedir(), '.agentgraph-test-'));
    dirs.push(home);
    const linked = join(home, 'data');
    symlinkSync('/tmp', linked);
    expect(temporary('/tmp/bothub-data')).toEqual(['/tmp/bothub-data', '/tmp/bothub-data/mirror.git']);
    expect(temporary(linked)).toEqual([linked, join(linked, 'mirror.git')]);
    expect(temporary(join(homedir(), 'bothub-data'))).toEqual([]);
  });
});

describe('sweep', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });

  it('drives a commanded issue and a parked one with a new answer, and skips an unmarked one and one waiting with nothing new', async () => {
    const where = world();
    for (const n of [8, 9, 10])
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
      comment: { id: 'a', author: 'morgan', body: '/agent hi', at: answer },
    });
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Done?' })],
      [start('b'), write('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Done?' })],
    ]);
    for (const r of [parked(8, 'waiting'), parked(9, 'waiting')]) {
      mkdirSync(join(where.data, r.id), { recursive: true });
      writeFileSync(join(where.data, r.id, 'run.json'), JSON.stringify(r));
    }
    const touched = await run(sweep(small));
    expect(touched.map(r => r.issue).sort()).toEqual([7, 8]);
    expect(touched.find(r => r.issue === 9)).toBeUndefined();
    expect(await run(Effect.flatMap(Store, s => s.list({ issue: 10 })))).toEqual([]);
    expect(specs).toHaveLength(2);
    expect(specs.map(s => s.prompt).join('\n')).toContain('hi');
    expect(await run(Effect.flatMap(Store, s => s.read('run-9').pipe(Stream.runCollect)))).toHaveProperty('length', 0);
  }, 30_000);

  it('resumes a finished run on a comment that the repo-wide look has already passed', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '9.md'),
      '---\ntitle: Issue 9\nstate: open\nauthor: morgan\nlabels: []\n---\n\nBody 9.\n'
    );
    const done = (issue: number, started: string): Run => ({
      ...begin(small.workflows.issue!, { id: `run-${issue}`, issue, started }),
      status: 'done',
    });
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'gh-pages it is.' })]]);
    await run(
      Effect.flatMap(Store, s =>
        Effect.forEach([done(7, '2026-10-16T00:00:00.000Z'), done(9, '2026-10-19T00:00:00.000Z')], s.put)
      )
    );
    where.human('/agent use gh-pages', '2026-10-17T00:00:00.000Z');
    expect(await run(tick(small))).toEqual([]);
    const touched = await run(sweep(small));
    expect(touched.map(r => [r.id, r.status])).toEqual([['issue-7-20261017000000000', 'done']]);
    expect(specs[0]!.prompt).toContain('use gh-pages');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).toContain('gh-pages it is.');
  }, 30_000);

  it('looks at issues side by side, up to limits.parallel', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Issue 8\nstate: open\nauthor: morgan\nlabels: []\n---\n\nBody.\n'
    );
    say(where, comment(8, 'morgan', true, '/agent', '2026-10-16T00:00:00.000Z'));
    let open = 0;
    let most = 0;
    const slow = Layer.succeed(Session, {
      open: () =>
        Stream.fromEffect(
          Effect.acquireUseRelease(
            Effect.sync(() => (most = Math.max(most, ++open))),
            () => Effect.sleep('200 millis'),
            () => Effect.sync(() => open--)
          )
        ).pipe(Stream.flatMap(() => Stream.make(start('s'), reply({ kind: 'ask', question: 'Which file?' })))),
    });
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), host(where.origin), slow);
    const touched = await Effect.runPromise(sweep(small).pipe(Effect.provide(layer)));
    expect(touched.map(r => [r.issue, r.status]).sort()).toEqual([
      [7, 'waiting'],
      [8, 'waiting'],
    ]);
    expect(most).toBe(2);
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
    expect(specs[0]!.prompt).toContain('#7 @morgan: /agent');
    expect(specs[0]!.prompt).toContain('#8 @ana: mind the edge case');
    expect(specs[0]!.prompt).toContain('#8 check test: failure');
    expect(specs[0]!.prompt).not.toContain('holds what is new');
    expect(specs[0]!.read).toBeUndefined();
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
    say(where, comment(7, 'morgan', true, '/agent hello', later(1)));
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
      'hello\n\n## New since you last looked\n\n#7 @morgan: /agent hello\n\n#8 @ana pushed abcdef1 Tweak the greeting'
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
            expect(spec.read).toEqual([dirname(file)]);
            mkdirSync(join(spec.dir, '.agentgraph'));
            symlinkSync(target, join(spec.dir, '.agentgraph', 'news.md'));
            symlinkSync(where.forge, join(spec.dir, 'news'));
            seen.push(news(spec.dir));
            say(where, comment(7, 'ana', true, 'also say bye', later(1)));
            yield* minute(spec.dir, text => text.includes('also say bye'));
            renameSync(join(where.forge, '7.md'), join(where.forge, '7.away'));
            say(where, comment(7, 'ana', true, 'never seen', later(2)));
            yield* minute(spec.dir, () => false);
            renameSync(join(where.forge, '7.away'), join(where.forge, '7.md'));
            writeFileSync(join(spec.dir, 'hello.txt'), 'hello\n');
            rmSync(join(spec.dir, '.agentgraph'), { recursive: true });
            rmSync(join(spec.dir, 'news'));
          })
        ).pipe(Stream.flatMap(() => Stream.fromIterable([start('a'), reply(push)]))),
    });
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), host(where.origin), session);
    const agents = Object.fromEntries(Object.entries(small.agents).map(([k, a]) => [k, { ...a, tools: ['read'] }]));
    const done = await Effect.runPromise(
      drive({ ...flow, concurrency: 'queue' }, begun(), { ...small, agents }).pipe(
        Effect.provide(layer),
        Effect.provide(TestContext.TestContext)
      )
    );
    expect(done.status).toBe('done');
    expect(seen).toEqual([
      'Nothing new yet.\n',
      '## New since you last looked\n\n@ana: also say bye\n',
      '## New since you last looked\n\n@ana: also say bye\n',
    ]);
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(git(where.origin, 'ls-tree', '-r', '--name-only', 'agentgraph/7')).not.toContain('.agentgraph');
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
  }, 30_000);

  /**
   * The doubles, where the first session says `m` on the forge while it works. With `cut`, it then lets a minute pass and
   * works until it is cut short; else it plays the first turn.
   */
  const during = (where: ReturnType<typeof world>, m: Event, turns: SessionEvent[][], cut = false) => {
    const specs: SessionSpec[] = [];
    const session = Layer.effect(
      Session,
      Effect.map(Session, s => ({
        open: (spec: SessionSpec) => {
          if (specs.push(spec) > 1) return s.open(spec);
          const said = Stream.execute(Effect.sync(() => say(where, m)));
          if (!cut) return Stream.concat(said, s.open(spec));
          const minute = Effect.gen(function* () {
            yield* Effect.promise(() => new Promise(r => setTimeout(r, 50)));
            yield* TestClock.adjust('1 minute');
            return yield* Effect.never;
          });
          return Stream.make(start('a')).pipe(Stream.concat(said), Stream.concat(Stream.execute(minute)));
        },
      }))
    ).pipe(Layer.provide(scripted(turns)));
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), host(where.origin), session);
    const go = (w: typeof flow) =>
      Effect.runPromise(drive(w, begun(), small).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)));
    return { specs, go };
  };
  const bye = comment(7, 'ana', true, '/agent say bye too', later(1));
  const greet = [start('a'), write('hello.txt', 'hello\n'), reply(push)];

  it('steer: a comment made while the session works reaches it in one more turn of the same session', async () => {
    const where = world();
    const { specs, go } = during(where, bye, [greet, [start('a'), reply(push)]]);
    const done = await go(flow);
    expect(done).toMatchObject({ status: 'done', seen: later(1) });
    expect(specs).toHaveLength(2);
    expect(specs[1]!.resume?.id).toBe('a');
    expect(specs[1]!.prompt).toContain('@ana: /agent say bye too');
    expect(specs[1]!.prompt).toContain('end your reply with the whole agentgraph block again');
  }, 30_000);

  it('queue: a comment made while the session works applies once the try ends, as an answer would', async () => {
    const where = world();
    const asks = [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })];
    const { specs, go } = during(where, bye, [asks, greet]);
    const done = await go({ ...flow, concurrency: 'queue' });
    expect(done).toMatchObject({ status: 'done', answers: [{ asked: 'Hello or hi?', said: 'say bye too' }] });
    expect(specs).toHaveLength(2);
    expect(specs[1]!.prompt.startsWith('say bye too')).toBe(true);
  }, 30_000);

  it('cancel: a comment cuts the session short and the step starts again at once with it, in the same session', async () => {
    const where = world();
    const { specs, go } = during(where, bye, [greet], true);
    const done = await go({ ...flow, concurrency: 'cancel' });
    expect(done).toMatchObject({ status: 'done', tries: 0, seen: later(1) });
    expect(specs).toHaveLength(2);
    expect(specs[1]!.resume?.id).toBe('a');
    expect(specs[1]!.prompt.startsWith('say bye too')).toBe(true);
    const ends = traceOf(where.data, done.id).flatMap(t => ('session' in t ? [t.session.ended] : []));
    expect(ends[0]).toBe('human');
  }, 30_000);

  it('cancel parks a working run with its session, and stop ends it, whatever the concurrency', async () => {
    const parked = await during(world(), comment(7, 'ana', true, '/agent cancel', later(1)), [], true).go(flow);
    expect(parked).toMatchObject({ status: 'waiting', reason: cancelled, sessions: { implement: { id: 'a' } } });
    const stop = comment(7, 'ana', true, '/agent stop wrong issue', later(1));
    const stopped = await during(world(), stop, [], true).go({ ...flow, concurrency: 'queue' });
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'wrong issue' });
  }, 30_000);

  const assigned = { ...small, workflows: { issue: { ...flow, on: { issues: { label: 'agentgraph' } } } } };
  const labelled = (actor: string, trusted: boolean, kind: 'label' | 'unlabel', at: string): Event => ({
    issue: 7,
    kind,
    actor,
    trusted,
    at,
    label: 'agentgraph',
  });

  it("begins a run on a maintainer's agentgraph label, not on an outsider's, and stops it when the label is removed", async () => {
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
    expect(stopped).toMatchObject({ id: asked!.id, status: 'stopped', reason: 'the agentgraph label was removed' });
    expect(readFileSync(join(where.forge, '7.reactions'), 'utf8')).toBe('');
    expect(reactions(where.data, asked!.id)).toEqual([
      [true, undefined],
      [true, '#7'],
    ]);
    expect((await run(Effect.flatMap(Forge, f => f.issue(7)))).labels).toEqual(['agentgraph:stopped']);
  }, 30_000);

  it('begins on one issue only where the latest agentgraph label came from a maintainer', async () => {
    const where = world();
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:01.000Z'));
    say(where, labelled('mallory', false, 'unlabel', '2026-10-16T00:00:02.000Z'));
    say(where, labelled('mallory', false, 'label', '2026-10-16T00:00:03.000Z'));
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(await run(tick(assigned, 7, true))).toEqual([]);
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:04.000Z'));
    expect((await run(tick(assigned, 7, true))).map(r => r.status)).toEqual(['waiting']);
  }, 30_000);

  const ready = {
    ...small,
    workflows: { issue: { ...flow, on: { issue_comment: {}, issues: { label: 'agent:ready' } } } },
  };
  const marked = (actor: string, trusted: boolean, at: string): Event => ({
    issue: 7,
    kind: 'label',
    actor,
    trusted,
    at,
    label: 'agent:ready',
  });

  it("starts a mention workflow on a maintainer's agent:ready, never on a bot's or an outsider's, and once per issue", async () => {
    const where = world();
    writeFileSync(join(where.forge, '7.jsonl'), '');
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(await run(sweep(ready))).toEqual([]);
    say(where, marked('stx-agentgraph[bot]', false, '2026-10-16T00:00:01.000Z'));
    say(where, marked('mallory', false, '2026-10-16T00:00:02.000Z'));
    expect(await run(sweep(ready))).toEqual([]);
    say(where, marked('morgan', true, '2026-10-16T00:00:03.000Z'));
    const [asked] = await run(sweep(ready));
    expect(asked).toMatchObject({ issue: 7, workflow: 'issue', status: 'waiting' });
    expect(specs).toHaveLength(1);
    await run(Effect.flatMap(Store, s => s.put({ ...asked!, status: 'done' })));
    say(where, { ...marked('morgan', true, later(1)), kind: 'unlabel' });
    say(where, marked('morgan', true, later(2)));
    expect(await run(sweep(ready))).toEqual([]);
    expect(specs).toHaveLength(1);
  }, 30_000);

  it('still starts a mention workflow on /agent when it also starts on a label', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect((await run(sweep(ready))).map(r => [r.issue, r.status])).toEqual([[7, 'waiting']]);
  }, 30_000);

  it('keeps one status comment through two tries and an ask, with the question in its own comment', async () => {
    const where = world();
    const { run } = services(where, [
      [start('a'), write('hello.txt', 'TODO\n'), reply(push)],
      [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })],
    ]);
    const asked = await run(drive(flow, begun(), small));
    expect(asked).toMatchObject({ status: 'waiting', tries: 1, comment: '7-3' });
    const issue = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(issue.labels).toEqual(['agentgraph:waiting']);
    expect(bodies(issue)).toEqual([
      '/agent',
      `Waiting for an answer to the question below, at implement.\n\n${foot(replyHint)}`,
      'Hello or hi?',
    ]);
    const edits = traceOf(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.proposal.kind === 'comment' && t.applied.proposal.edit
        ? [t.applied.proposal.body]
        : []
    );
    expect(edits).toEqual([expect.stringMatching(/^Waiting for an answer/)]);
  }, 30_000);

  it.each([false, true])(
    'uses every check retry before asking a human (fixed: %s)',
    async fixed => {
      const where = world();
      const findings = '{"at":"hello.txt:1","why":"TODO remains"}';
      const checked = {
        ...small,
        checks: {
          ...small.checks,
          types: { ...small.checks.types!, run: `if grep -q TODO hello.txt; then echo '${findings}'; exit 1; fi` },
        },
      };
      const typed = {
        ...flow,
        steps: [{ name: 'implement', does: { agent: 'implementor' }, checks: ['types'], tries: 3 }],
      };
      const { specs, run } = services(where, [
        [start('a'), write('hello.txt', 'TODO\n'), reply(push)],
        [start('a'), reply(push)],
        [start('a'), ...(fixed ? [write('hello.txt', 'hello\n')] : []), reply(push)],
      ]);
      const done = await run(drive(typed, begin(typed, { id: 'run-7', issue: 7, started: fresh().started }), checked));
      expect(specs).toHaveLength(3);
      expect(specs[2]!.prompt).toContain(findings);
      expect(done).toMatchObject({ status: fixed ? 'done' : 'waiting', tries: fixed ? 2 : 3 });
      const issue = bodies(await run(Effect.flatMap(Forge, f => f.issue(7))));
      expect(issue.join('\n')).not.toContain(findings);
      if (!fixed) {
        expect(done.reason).toBe(
          'implement failed after 3 tries (checks: types).\n\ntypes: hello.txt:1: TODO remains\n\nHow should I proceed?'
        );
        expect(issue).toContain(done.reason);
      }
      const outcomes = traceOf(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome.kind] : []));
      expect(outcomes).toEqual(['failed', 'failed', fixed ? 'pass' : 'failed']);
    },
    30_000
  );

  it('opens a step that can send the change back on the whole diff of the branch', async () => {
    const where = world();
    const reviewed = {
      ...flow,
      steps: [
        { name: 'implement', does: { agent: 'implementor' }, checks: [], tries: 1 },
        { name: 'review', does: { agent: 'reviewer' }, checks: [], tries: 1, back: { to: 'implement', until: 'done' } },
      ],
    };
    const { specs, run } = services(where, [
      [start('a'), write('hello.txt', 'hello\n'), reply(push)],
      [start('r'), reply({ kind: 'comment', body: 'Fine.' })],
    ]);
    await run(drive(reviewed, begin(reviewed, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }), small));
    expect(specs[0]!.prompt).not.toContain('## The change on the branch');
    expect(specs[1]!.prompt).toMatch(/## The change on the branch\n\n````diff\n[\s\S]*\+hello\n````/);
  }, 30_000);

  it('tells a waiting run how to be answered in its status footer, and posts the question itself plain', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    await run(drive(flow, begun(), small));
    const issue = bodies(await run(Effect.flatMap(Forge, f => f.issue(7))));
    expect(issue.filter(b => b.includes('Hello or hi?'))).toEqual(['Hello or hi?']);
    expect(issue.filter(b => b.includes(replyHint))).toHaveLength(1);
  });

  it('moves the status below an answered question, so it never sits above a question already answered', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    await run(drive(flow, begun(), small));
    where.human('/agent hi', new Date().toISOString());
    await services(where, [[start('a'), reply({ kind: 'ask', question: 'Hi with a dot?' })]]).run(tick(small, 7));
    expect(bodies(await run(Effect.flatMap(Forge, f => f.issue(7))))).toEqual([
      '/agent',
      'Asked the question below at implement.',
      'Hello or hi?',
      '/agent hi',
      `Waiting for an answer to the question below, at implement.\n\n${foot(replyHint)}`,
      'Hi with a dot?',
    ]);
  }, 30_000);

  it('lets an agent answer a review comment by the id its context shows, on the pull request', async () => {
    const where = world();
    pullRequest(where);
    const at = '2026-10-16T00:00:03.000Z';
    const line = { id: 'r1', author: 'morgan', body: 'why hello?', at, path: 'hello.txt', line: 1 };
    say(where, { ...comment(8, 'morgan', true, 'why hello?', at), comment: line });
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'Asked for.', under: 'r1' })]]);
    await run(drive(flow, { ...begun(), said: [{ issue: 7 }] }, small));
    expect(specs[0]!.prompt).toContain('@morgan on hello.txt:1, id r1: why hello?');
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under, c.path])).toEqual([
      ['Asked for.', 'r1', 'hello.txt'],
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
    const review = comment(8, 'morgan', true, '/agent yes, bye too', '');
    const [again, done] = await run(
      Effect.gen(function* () {
        yield* drive(flow, begun(), small);
        say(where, comment(8, 'morgan', true, '/agent hello', at()));
        const [again] = yield* tick(small, 7);
        review.at = review.comment!.at = review.comment!.id = at();
        say(where, { ...review, comment: { ...review.comment!, path: 'hello.txt', line: 1 } });
        const [done] = yield* tick(small, 7);
        return [again, done];
      })
    );
    expect(again).toMatchObject({ status: 'waiting', said: [{ issue: 8 }] });
    expect(done).toMatchObject({ status: 'done', said: [{ issue: 8 }] });
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body.split('\n')[0], c.under, c.path])).toEqual([
      ['And bye?', undefined, undefined],
      ['Said bye.', review.at, 'hello.txt'],
    ]);
    const issue = bodies(await run(Effect.flatMap(Forge, f => f.issue(7))));
    expect(issue.some(b => b.startsWith('And bye?') || b.startsWith('Said bye.'))).toBe(false);
  }, 30_000);
});

describe('gate', () => {
  it('lets a check read the pending proposals from AGENTGRAPH_PROPOSALS', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = hubOf('hub', { types: { run: 'cat "$AGENTGRAPH_PROPOSALS"; exit 1' } });
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: where.origin, GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [push, pull],
    };
    const { outcome } = await run(gate(step, left, small));
    const findings = outcome.kind === 'failed' ? outcome.checks[0]!.findings : undefined;
    expect(JSON.parse(findings!)).toEqual([push, pull]);
  });

  it('passes a check whose each command finds no items as empty, saying it judged nothing', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = hubOf('hub', { types: { each: 'true', run: 'exit 1' } });
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: where.origin, GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const { outcome } = await run(gate(step, left, small));
    expect(outcome).toEqual({ kind: 'pass' });
    const checks = traceOf(where.data, 'run-7').flatMap(t =>
      'check' in t && t.check.check === 'types' ? [t.check] : []
    );
    expect(checks).toEqual([
      {
        check: 'types',
        pass: true,
        empty: true,
        findings: 'Judged nothing: each found no items.',
        ms: expect.any(Number),
      },
    ]);
  });

  it('fails a check without max as one finding past 20 items, opening no session', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = hubOf('acme-app', { claims: { each: 'seq 21', agent: 'claim-checker' } });
    const kit = { ...small, checks: { ...small.checks, claims: { ...small.checks.claims!, mode: 'block' as const } } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['claims'], tries: 3 };
    const { specs, run } = services(where, []);
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: where.origin, GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const { outcome } = await run(gate(step, left, kit));
    expect(outcome).toMatchObject({
      kind: 'failed',
      checks: [{ check: 'claims', findings: '21 items, more than 20' }],
    });
    expect(specs).toHaveLength(0);
  });

  it('fails a check as one error carrying stderr when its each command exits nonzero', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = hubOf('hub', { types: { each: 'echo at x.js:1 >&2; echo boom >&2; exit 1', run: 'exit 0' } });
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: where.origin, GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const { outcome } = await run(gate(step, left, small));
    expect(outcome.kind).toBe('failed');
    const checks = traceOf(where.data, 'run-7').flatMap(t =>
      'check' in t && t.check.check === 'types' ? [t.check] : []
    );
    expect(checks).toEqual([
      { check: 'types', pass: false, findings: 'each failed: at x.js:1\nboom', ms: expect.any(Number) },
    ]);
  });

  it('lets a check read the hub directory through AGENTGRAPH_HUB', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const hubDir = join(where.root, 'hubdir');
    mkdirSync(join(hubDir, 'scripts'), { recursive: true });
    writeFileSync(join(hubDir, 'scripts', 'x.sh'), 'echo from hub\n');
    const small = { ...hubOf('hub', { types: { run: 'sh "$AGENTGRAPH_HUB/scripts/x.sh"; exit 1' } }), dir: hubDir };
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: where.origin, GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const { outcome } = await run(gate(step, left, small));
    const findings = outcome.kind === 'failed' ? outcome.checks[0]!.findings : undefined;
    expect(findings?.trim()).toBe('from hub');
  });

  it('lets two agents on different harnesses and models review one try side by side', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = hubOf('hub');
    const agent = (name: string, harness: Hub['agents'][string]['harness'], model: string): Hub['agents'][string] => ({
      name,
      path: `${name}.md`,
      body: `You are ${name}.`,
      harness,
      model,
      tools: [],
      returns: [],
    });
    const check = (name: string, judge: string) => ({
      name,
      path: `${name}.md`,
      body: name,
      mode: 'block' as const,
      agent: judge,
    });
    const small = {
      ...base,
      agents: {
        ...base.agents,
        critic: agent('critic', 'claude', 'opus'),
        tester: agent('tester', 'opencode', 'smart'),
      },
      checks: { correct: check('correct', 'critic'), covered: check('covered', 'tester') },
    };
    const step = { name: 'implement', does: { agent: 'critic' }, checks: ['correct', 'covered'], tries: 3 };
    const specs: SessionSpec[] = [];
    const verdicts: Record<string, string> = { critic: 'FAIL off by one', tester: 'PASS' };
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => {
        specs.push(spec);
        return Stream.fromIterable<SessionEvent>([
          start(spec.agent),
          { type: 'end', final: verdicts[spec.agent]!, ended: 'stop', exit: 0 },
        ]);
      },
    });
    const layer = Layer.mergeAll(fileStore(where.data), host(where.origin), judges);
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const { outcome } = await Effect.runPromise(gate(step, left, small).pipe(Effect.provide(layer)));
    expect(specs.map(s => [s.agent, s.harness, s.model]).sort()).toEqual([
      ['critic', 'claude', 'opus'],
      ['tester', 'opencode', 'smart'],
    ]);
    expect(outcome).toMatchObject({ kind: 'failed', checks: [{ check: 'correct', findings: 'FAIL off by one' }] });
  });
  it('shows every check what a human answered during the run, judges in their prompt and scripts in AGENTGRAPH_CONTEXT', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const seen = join(where.root, 'seen.md');
    const small = hubOf('acme-app', {
      types: { run: `cp "$AGENTGRAPH_CONTEXT" ${seen}` },
      claims: { agent: 'claim-checker' },
    });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const specs: SessionSpec[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        specs.push(spec),
        Stream.fromIterable<SessionEvent>([start('j'), { type: 'end', final: 'PASS', ended: 'stop', exit: 0 }])
      ),
    });
    const left = {
      run: 'run-7',
      issue: 7,
      context: '## #7 Add a greeting',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
      answers: [{ asked: 'Keep the old regex?', said: 'yes, the old regex stays' }],
    };
    const layer = Layer.mergeAll(fileStore(where.data), host(where.origin), judges);
    await Effect.runPromise(gate(step, left, small).pipe(Effect.provide(layer)));
    const context = readFileSync(seen, 'utf8');
    expect(context).toContain('## #7 Add a greeting');
    expect(context).toContain('Asked: Keep the old regex?\n\nAnswered: yes, the old regex stays');
    expect(specs[0]!.prompt).toContain('Answered: yes, the old regex stays');
  });

  it('judges a try whose script check failed, so the findings of both come back together', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const kit = hubOf('acme-app', {
      types: { run: 'echo x.ts:1 error; exit 1' },
      claims: { agent: 'claim-checker' },
    });
    const small = { ...kit, checks: { ...kit.checks, claims: { ...kit.checks.claims!, mode: 'block' as const } } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const judges = Layer.succeed(Session, {
      open: () =>
        Stream.fromIterable<SessionEvent>([start('j'), { type: 'end', final: 'FAIL a claim', ended: 'stop', exit: 0 }]),
    });
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const layer = Layer.mergeAll(fileStore(where.data), host(where.origin), judges);
    const { outcome } = await Effect.runPromise(gate(step, left, small).pipe(Effect.provide(layer)));
    expect(outcome).toMatchObject({
      kind: 'failed',
      checks: [
        { check: 'types', findings: 'x.ts:1 error' },
        { check: 'claims', findings: 'FAIL a claim' },
      ],
    });
  });

  it('judges again only what changed: a pass on the same diff is kept, a fail or a new diff is judged', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const small = hubOf('acme-app', { claims: { each: 'echo a; echo b', agent: 'claim-checker' } });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['claims'], tries: 3 };
    const judgedItems: string[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => {
        const item = spec.prompt.includes('\n\nb\n\n') ? 'b' : 'a';
        judgedItems.push(item);
        const final = item === 'a' ? 'PASS' : 'FAIL b is off';
        return Stream.fromIterable<SessionEvent>([start('j'), { type: 'end', final, ended: 'stop', exit: 0 }]);
      },
    });
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const layer = Layer.mergeAll(fileStore(where.data), host(where.origin), judges);
    const once = () => Effect.runPromise(gate(step, left, small).pipe(Effect.provide(layer)));
    await once();
    await once();
    expect(judgedItems.sort()).toEqual(['a', 'b', 'b']);
    writeFileSync(join(dir, 'hello.txt'), 'hello\n');
    judgedItems.length = 0;
    await once();
    expect(judgedItems.sort()).toEqual(['a', 'b']);
    const copy = join(where.root, 'copy');
    git(where.root, 'clone', '-q', dir, copy);
    writeFileSync(join(copy, 'hello.txt'), 'hello\n');
    const moved = { ...left, dir: copy, git: { GIT_DIR: join(copy, '.git'), GIT_WORK_TREE: copy } };
    judgedItems.length = 0;
    await Effect.runPromise(gate(step, moved, small).pipe(Effect.provide(layer)));
    expect(judgedItems).toEqual(['b']);
    judgedItems.length = 0;
    const answered = { ...moved, answers: [{ asked: 'Is a fine?', said: 'Not any more.' }] };
    await Effect.runPromise(gate(step, answered, small).pipe(Effect.provide(layer)));
    expect(judgedItems.sort()).toEqual(['a', 'b']);
  });

  describe('a judge session that did not end normally', () => {
    const judged = async (
      ends: Extract<SessionEvent, { type: 'end' }>[],
      mode: 'block' | 'warn' | 'stop' = 'block',
      more: Hub['checks'] = {}
    ) => {
      const where = world();
      const dir = join(where.root, 'work');
      mkdirSync(dir);
      mkdirSync(join(where.root, 'news'));
      git(dir, 'init', '-q');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
      const base = hubOf('hub');
      const critic: Hub['agents'][string] = {
        name: 'critic',
        path: 'critic.md',
        body: 'critic',
        harness: 'claude',
        tools: [],
        returns: [],
      };
      const hub = {
        ...base,
        agents: { ...base.agents, critic },
        checks: { correct: { name: 'correct', path: 'c.md', body: 'c', mode, agent: 'critic' }, ...more },
      };
      const step = {
        name: 'implement',
        does: { agent: 'critic' },
        checks: ['correct', ...Object.keys(more)],
        tries: 3,
      };
      let opened = 0;
      const judges = Layer.succeed(Session, {
        open: (spec: SessionSpec) => Stream.fromIterable<SessionEvent>([start(spec.agent), ends[opened++]!]),
      });
      const layer = Layer.mergeAll(fileStore(where.data), host(where.origin), judges);
      const left = {
        run: 'run-7',
        issue: 7,
        context: '',
        reply: '',
        dir,
        base: 'HEAD',
        git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
        news: join(where.root, 'news', 'news.md'),
        proposals: [],
      };
      const exit = await Effect.runPromiseExit(gate(step, left, hub).pipe(Effect.provide(layer)));
      return { exit, opened, data: where.data };
    };
    const killed: Extract<SessionEvent, { type: 'end' }> = { type: 'end', final: 'Killed', ended: 'error', exit: 137 };
    const pass: Extract<SessionEvent, { type: 'end' }> = { type: 'end', final: 'PASS fine', ended: 'stop', exit: 0 };

    it('retries once and takes the second verdict', async () => {
      const { exit, opened } = await judged([killed, pass]);
      expect(opened).toBe(2);
      expect(Exit.isSuccess(exit) && exit.value.outcome).toEqual({ kind: 'pass' });
    });

    it('fails as an error that says it could not be judged, never as a finding', async () => {
      const { exit, opened } = await judged([killed, killed]);
      expect(opened).toBe(2);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('could not be judged');
    });

    it('records an error finding and goes on when the check only warns', async () => {
      const { exit, opened, data } = await judged([killed, killed], 'warn');
      expect(opened).toBe(2);
      expect(Exit.isSuccess(exit) && exit.value.outcome).toEqual({ kind: 'pass' });
      const found = traceOf(data, 'run-7').flatMap(t => ('check' in t ? [t.check] : []));
      expect(found).toMatchObject([
        { check: 'correct', pass: false, findings: expect.stringContaining('could not be judged') },
      ]);
    });

    it('parks the run when a stop check cannot be judged', async () => {
      const { exit } = await judged([killed, killed], 'stop');
      expect(Exit.isFailure(exit)).toBe(true);
    });

    it('stops on a failed stop check even when another check cannot be judged', async () => {
      const red = { name: 'red', path: 'r.md', body: '', mode: 'stop' as const, run: 'exit 1' };
      const { exit } = await judged([killed, killed], 'block', { red });
      expect(Exit.isSuccess(exit) && exit.value.outcome).toMatchObject({ kind: 'stop' });
    });

    it('treats a clean stop without a verdict line the same way', async () => {
      const mute = { ...pass, final: 'looks fine to me' };
      const { exit } = await judged([mute, mute]);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});

describe('a base that moved', () => {
  /** Run 7 waiting at merge on pull request #8. */
  const parked = async () => {
    const where = world();
    const first = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), write('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(await first.run(drive(w, fresh(), hub))).toMatchObject({ step: 'merge', status: 'waiting', hub: 'fixture' });
    return where;
  };
  /** Run 7 parked, then `main` gets one commit that writes each file. */
  const moved = async (...files: string[]) => {
    const where = await parked();
    const mover = join(where.root, 'mover');
    git(where.root, 'clone', '-q', where.origin, mover);
    for (const file of files) writeFileSync(join(mover, file), 'upstream\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-q', '-m', 'upstream');
    git(mover, 'push', '-q', 'origin', 'main');
    return where;
  };
  const behind = (where: ReturnType<typeof world>) => git(where.origin, 'rev-list', '--count', 'agentgraph/7..main');
  const rebases = (where: ReturnType<typeof world>) =>
    traceOf(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.proposal.kind === 'rebase' ? [t.applied.ok] : []
    );
  /** The hub with the merge step's fields replaced. */
  const merging = (fields: Partial<Step>, base = hub) => ({
    ...base,
    workflows: { issue: { ...w, steps: w.steps.map(s => (s.name === 'merge' ? { ...s, ...fields } : s)) } },
  });
  const ran = (commands: Command[], script: string) => commands.some(c => c.args.includes(script));
  const said = (where: ReturnType<typeof world>) =>
    readdirSync(where.forge)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => readFileSync(join(where.forge, f), 'utf8'))
      .join('');

  it('rebases a clean branch with no model and runs only its script checks when the change stays the same', async () => {
    const where = await moved('other.txt');
    expect(behind(where)).toBe('1');
    const { specs, commands, run } = services(where, []);
    await run(tick(hub));
    expect(behind(where)).toBe('0');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(specs).toHaveLength(0);
    expect(ran(commands, '! grep -q TODO hello.txt')).toBe(true);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(rebases(where)).toEqual([true]);
  }, 60_000);

  it('merges the base into the branch with a plain push by default', async () => {
    const where = await moved('other.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(merging({ follow: 'merge' })));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7^1')).toBe(before);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7^2')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(specs).toHaveLength(0);
    const diff = readFileSync(join(where.forge, '8', 'diff.patch'), 'utf8');
    expect(diff).toContain('hello.txt');
    expect(diff).not.toContain('other.txt');
  }, 60_000);

  it('judges after the script checks pass when the step names a judged check, and only then', async () => {
    const where = await moved('other.txt');
    const { specs, run } = services(where, [judged]);
    await run(tick(merging({ checks: ['types', 'claims'] })));
    expect(specs).toHaveLength(1);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });

    const red = await moved('other.txt');
    const failing = services(red, [[start('i2'), reply({ kind: 'ask', question: 'Why red?' })]]);
    const strict = { ...hub, checks: { ...hub.checks, types: { ...hub.checks.types!, run: 'exit 1' } } };
    await failing.run(tick(merging({ checks: ['types', 'claims'] }, strict)));
    expect(failing.specs.map(s => s.prompt)[0]).toMatch(/^the merge step sent this back: types/);
  }, 60_000);

  it.each([
    ['runs the setup before the checks', 'touch .ready', 'test -e .ready'],
    ['takes a check whose command is missing as infrastructure, not a red change', undefined, 'not-installed-tool'],
  ])(
    '%s and keeps the run waiting',
    async (_, setup, script) => {
      const where = await moved('other.txt');
      const { specs, run } = services(where, []);
      const checked = {
        ...hub,
        ...(setup && { setup }),
        checks: { ...hub.checks, types: { ...hub.checks.types!, run: script } },
      };
      await run(tick(merging({ checks: ['types'] }, checked)));
      expect(behind(where)).toBe('0');
      expect(specs).toHaveLength(0);
      const [stored] = await run(Effect.flatMap(Store, s => s.list()));
      expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
    },
    60_000
  );

  it('follows the base and checks nothing when the step lists no checks', async () => {
    const where = await moved('other.txt');
    const { commands, run } = services(where, []);
    await run(tick(merging({ checks: [] })));
    expect(behind(where)).toBe('0');
    expect(commands).toHaveLength(0);
  }, 60_000);

  it('sends a conflict back to implement, which resolves it on the new base and lands only its change', async () => {
    const where = await moved('hello.txt', 'other.txt');
    const seen: string[] = [];
    const { specs, run } = services(
      where,
      [
        [start('i1'), write('hello.txt', 'hello upstream\n'), reply(push)],
        judged,
        [start('r2'), reply({ kind: 'comment', body: 'Fine.' })],
      ],
      undefined,
      spec => existsSync(join(spec.dir, 'hello.txt')) && seen.push(readFileSync(join(spec.dir, 'hello.txt'), 'utf8'))
    );
    await run(tick(hub));
    expect(specs[0]!.prompt).toMatch(
      /^the merge step sent this back: agentgraph\/7 no longer rebases onto main at \w+: conflicts in hello.txt/
    );
    expect(seen[0]).toMatch(/^<<<<<<< [^\n]*\nupstream\n=======\nhello\n>>>>>>> /);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7~1')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello upstream');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
    const diff = readFileSync(join(where.forge, '8', 'diff.patch'), 'utf8');
    expect(diff).toContain('+hello upstream');
    expect(diff).not.toContain('other.txt');
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(stored!.onto).toBeUndefined();
    expect(said(where)).not.toContain('by hand');
  }, 60_000);

  it('fails a try that leaves conflict markers and pushes nothing', async () => {
    const where = await moved('hello.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, [
      [start('i1'), reply(push)],
      judged,
      [start('i1'), reply({ kind: 'ask', question: 'Which side?' })],
    ]);
    await run(tick(hub));
    expect(specs[2]!.prompt).toContain('conflict markers left in hello.txt');
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Which side?' });
    expect(stored!.onto).toBeDefined();
  }, 60_000);

  it('says a conflict on the issue once when the harness already had its try at that base head', async () => {
    const where = await moved('hello.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { run } = services(where, [[start('i1'), reply({ kind: 'ask', question: 'Stuck.' })]]);
    await run(tick(hub));
    const [asked] = await run(Effect.flatMap(Store, s => s.list()));
    const { onto: _onto, ...back } = asked!;
    await run(Effect.flatMap(Store, s => s.put({ ...back, step: 'merge', status: 'waiting' })));
    await run(tick(hub));
    await run(tick(hub));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(rebases(where)).toEqual([false, false]);
    expect(
      said(where).split('agentgraph/7 no longer rebases onto main: conflicts in hello.txt. Update it by hand.')
    ).toHaveLength(2);
  }, 60_000);

  it('says a conflict at the top of the pull request, not under a thread the run already answered', async () => {
    const where = await parked();
    const at = new Date().toISOString();
    const line = { id: 'r1', author: 'morgan', body: '/agent why hello?', at, path: 'hello.txt', line: 1 };
    say(where, { ...comment(8, 'morgan', true, '/agent why hello?', at), comment: line });
    const { run } = services(where, [[start('f'), reply({ kind: 'comment', body: 'Asked for.' })]]);
    await run(tick(hub));
    const mover = join(where.root, 'mover');
    git(where.root, 'clone', '-q', where.origin, mover);
    writeFileSync(join(mover, 'hello.txt'), 'upstream\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-q', '-m', 'upstream');
    git(mover, 'push', '-q', 'origin', 'main');
    const steps = w.steps.map(s => {
      const { back: _back, ...kept } = s;
      return s.name === 'merge' ? kept : s;
    });
    await run(tick({ ...hub, workflows: { issue: { ...w, steps } } }));
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body.split(':')[0], c.under])).toEqual([
      ['Looks right.', undefined],
      ['Asked for.', 'r1'],
      ['agentgraph/7 no longer rebases onto main', undefined],
    ]);
  }, 60_000);

  it('keeps what a failing judged check after a rebase cost when it sends the run back', async () => {
    const where = await moved('other.txt');
    const { run } = services(where, [
      [start('j'), { type: 'usage', input: 1, output: 1, usd: 0.25 }, { type: 'text', text: 'FAIL a claim' }],
      [start('i2'), reply({ kind: 'ask', question: 'Which claim?' })],
    ]);
    const [was] = await run(Effect.flatMap(Store, s => s.list()));
    const strict = { ...hub, checks: { ...hub.checks, claims: { ...hub.checks.claims!, mode: 'block' as const } } };
    await run(tick(merging({ checks: ['types', 'claims'] }, strict)));
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Which claim?' });
    expect(stored!.usd).toBeCloseTo(was!.usd + 0.25);
  }, 60_000);

  it('does nothing when the branch is up to date', async () => {
    const where = await moved('other.txt');
    git(where.origin, 'update-ref', 'refs/heads/main', git(where.origin, 'rev-parse', 'main~1'));
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(hub));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(specs).toHaveLength(0);
    expect(rebases(where)).toEqual([]);
  }, 30_000);

  it('checks a waiting run again under a new hub and keeps it waiting when the checks pass', async () => {
    const where = await parked();
    const { specs, run } = services(where, [judged]);
    await run(tick({ ...hub, sha: 'next' }));
    expect(specs).toHaveLength(1);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting', hub: 'next' });
    expect(rebases(where)).toEqual([]);
  }, 30_000);

  it('sends a waiting run back to implement when a check of the new hub fails', async () => {
    const where = await parked();
    const stricter = {
      ...hub,
      sha: 'stricter',
      checks: { ...hub.checks, types: { ...hub.checks.types!, run: '! test -e hello.txt' } },
    };
    const { specs, run } = services(where, [
      judged,
      [start('i2'), reply({ kind: 'ask', question: 'Drop hello.txt?' })],
    ]);
    await run(tick(stricter));
    expect(specs[1]!.prompt).toMatch(/^the merge step sent this back: types: /);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Drop hello.txt?', hub: 'stricter' });
  }, 30_000);
});

describe('compound engineering', () => {
  it('gives checks the traces of the runs on the issue, and points a judge that reads traces at them', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const at = '2026-10-16T00:00:01.000Z';
    const lines: Trace[] = [
      { at, step: 'implement', event: { type: 'thinking', text: 'The issue names hello.txt; skip the tests.' } },
      { at, step: 'implement', event: { type: 'tool', id: 't', name: 'read', input: { path: 'hello.txt' }, ok: true } },
    ];
    mkdirSync(join(where.data, 'run-7'), { recursive: true });
    writeFileSync(join(where.data, 'run-7', 'run.json'), JSON.stringify(fresh()));
    writeFileSync(join(where.data, 'run-7', 'trace.jsonl'), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
    const seen = join(where.root, 'seen.md');
    const kit = hubOf('acme-app', {
      types: { run: `cp "$AGENTGRAPH_TRACES" ${seen}` },
      claims: { agent: 'claim-checker' },
    });
    const auditor = { ...kit.agents['claim-checker']!, tools: ['read'], reads: 'traces' as const };
    const small = { ...kit, agents: { ...kit.agents, 'claim-checker': auditor } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const read: string[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        read.push(...(spec.read ?? []).map(d => readFileSync(join(d, 'traces.md'), 'utf8'))),
        Stream.fromIterable<SessionEvent>([
          start('j'),
          { type: 'end', final: 'FAIL no test run', ended: 'stop', exit: 0 },
        ])
      ),
    });
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const layer = Layer.mergeAll(fileStore(where.data), host(where.origin), judges);
    await Effect.runPromise(gate(step, left, small).pipe(Effect.provide(layer)));
    expect(readFileSync(seen, 'utf8')).toContain('1 thinking: The issue names hello.txt; skip the tests.');
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('2 tool read {"path":"hello.txt"} ok');
  });

  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });
  const { branch: _branch, ...unbranched } = small.workflows.issue!;
  const looking = {
    ...small,
    setup: 'touch setup-ran',
    workflows: { ...small.workflows, retro: { ...unbranched, name: 'retro', on: { feedback: {} } } },
  };
  const pushed = (issue: number, at: string): Event => ({
    issue,
    kind: 'commit',
    actor: 'morgan',
    trusted: true,
    at,
    commit: { sha: 'abcdef0123', title: 'Document the field' },
  });
  const done = () =>
    Effect.flatMap(Store, s =>
      s.put({ ...begin(small.workflows.issue!, { id: 'run-7', issue: 7, started: fresh().started }), status: 'done' })
    );
  const retros = Effect.map(
    Effect.flatMap(Store, s => s.list({ issue: 7 })),
    runs => runs.filter(r => r.workflow === 'retro')
  );

  it('starts one quiet retro on what people said or pushed where a run worked, and nothing from commands or bots', async () => {
    const where = world();
    say(where, comment(7, 'mallory', false, 'this is wrong', '2026-10-16T00:00:04.000Z'));
    say(where, pushed(7, '2026-10-16T00:00:05.000Z'));
    say(where, comment(7, 'morgan', true, '/agent stop', '2026-10-16T00:00:06.000Z'));
    say(where, {
      ...comment(7, 'morgan', true, 'Fine, but the new field needs docs.', '2026-10-16T00:00:07.000Z'),
      kind: 'approved',
    });
    const { specs, commands, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.status, r.started])).toEqual([
      ['retro', 'done', '2026-10-16T00:00:07.000Z'],
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain(
      '## What a person said or pushed\n\n@morgan pushed abcdef0 Document the field\n\n@morgan approved: Fine, but the new field needs docs.'
    );

    expect(commands.map(c => c.args.join(' ')).join('\n')).not.toContain('setup-ran');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(readFileSync(join(where.forge, '7.md'), 'utf8')).toContain('labels: []');
    expect(await run(tick(looking))).toEqual([]);
    say(where, pushed(7, '2026-10-16T00:00:08.000Z'));
    const again = await run(tick(looking));
    expect(again.map(r => [r.workflow, r.started])).toEqual([['retro', '2026-10-16T00:00:08.000Z']]);
    expect(specs.at(-1)!.prompt).toMatch(
      /## What a person said or pushed\n\n@morgan pushed abcdef0 Document the field\n\n(?!@morgan approved)/
    );
    expect((await run(retros)).map(r => r.workflow)).toEqual(['retro', 'retro']);
  }, 30_000);

  it('a live retro holds neither the issue nor its answers', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'Hi.' })]]);
    await run(done());
    const live = begin(looking.workflows.retro, { id: 'retro-7', issue: 7, started: '2026-10-16T00:00:02.000Z' });
    await run(Effect.flatMap(Store, s => s.put({ ...live, status: 'waiting', reason: 'parked' })));
    where.human('/agent once more', '2026-10-16T00:00:05.000Z');
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.started])).toContainEqual(['issue', '2026-10-16T00:00:05.000Z']);
    expect(specs[0]!.agent).toBe('implementor');
    expect((await run(retros)).find(r => r.id === 'retro-7')?.status).toBe('waiting');
  }, 30_000);

  it('starts the next retro while one works, so what is said meanwhile waits on nothing', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    const live = begin(looking.workflows.retro, { id: 'retro-7', issue: 7, started: '2026-10-16T00:00:02.000Z' });
    await run(Effect.flatMap(Store, s => s.put({ ...live, status: 'waiting', reason: 'parked' })));
    say(where, pushed(7, '2026-10-16T00:00:04.000Z'));
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.started])).toEqual([['retro', '2026-10-16T00:00:04.000Z']]);
    expect(specs[0]!.prompt).toContain('said or pushed\n\n@morgan pushed abcdef0 Document the field');
  }, 30_000);

  it('takes a stop with a reason as feedback, and a bare stop as a command', async () => {
    const where = world();
    say(where, comment(7, 'morgan', true, '/agent stop', '2026-10-16T00:00:04.000Z'));
    say(where, comment(7, 'morgan', true, '/agent stop you rewrote the whole module', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    expect((await run(tick(looking))).map(r => r.workflow)).toEqual(['retro']);
    expect(specs[0]!.prompt).toContain('said or pushed\n\n@morgan: /agent stop you rewrote the whole module\n');
  }, 30_000);

  it('looks up no open issue a run never worked on', async () => {
    const where = world();
    writeFileSync(join(where.forge, '12.md'), '---\ntitle: Other\nstate: open\nauthor: morgan\n---\n\nElse.\n');
    say(where, comment(12, 'morgan', true, 'Unrelated.', '2026-10-16T00:00:05.000Z'));
    const asked: number[] = [];
    const counted = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({ ...f, issue: (n: number) => (asked.push(n), f.issue(n)) }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const layer = Layer.mergeAll(counted, fileStore(where.data), host(where.origin), scripted([]));
    const go = <A, E>(e: Effect.Effect<A, E, Forge | Store | Session | Sandbox>) =>
      Effect.runPromise(e.pipe(Effect.provide(layer)));
    await go(done());
    expect(await go(tick(looking))).toEqual([]);
    expect(asked).not.toContain(12);
  }, 30_000);

  it('takes what is said on a merged pull request as feedback on the issue its branch worked on', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Add hello\nstate: merged\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
    );
    mkdirSync(join(where.forge, '8'), { recursive: true });
    writeFileSync(
      join(where.forge, '8', 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: 'x', baseSha: 'b1' })
    );
    say(where, comment(8, 'morgan', true, 'Next time reuse the helper.', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.issue])).toEqual([['retro', 7]]);
    expect(specs[0]!.prompt).toContain('@morgan: Next time reuse the helper.');
  }, 30_000);
});
