import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Chunk, Effect, Exit, Fiber, Layer, Redacted, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { dockerSandbox } from '../src/docker.ts';
import { drive } from '../src/engine.ts';
import { harnessSession } from '../src/harnesses.ts';
import { fileForge, Forge } from '../src/forge.ts';
import { Sandbox, SandboxError, type Checkout } from '../src/sandbox.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { begin, getEventOutcome, transition, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, makeTestGraph, reply, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';
import { startTime } from './setup/global.ts';
import {
  foot,
  replyHint,
  graph,
  w,
  world,
  push,
  pull,
  judged,
  services,
  readChecks,
  readTrace,
  bodies,
  driveStored,
  fresh,
} from './world.ts';

describe('drive', () => {
  it.each(['docker', 'host'])('preserves the checkout and index when saving work fails: %s', async kind => {
    const where = world();
    const small = makeTestGraph('graph');
    const flow = { ...small.workflows.issue!, steps: small.workflows.issue!.steps.map(s => ({ ...s, checks: [] })) };
    let work: Checkout | undefined;
    const sandbox = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, s => ({
        ...s,
        checkout: (...args: Parameters<typeof s.checkout>) =>
          s.checkout(...args).pipe(
            Effect.tap(made =>
              Effect.sync(() => {
                work = made;
                const refs = join(kind === 'host' ? where.origin : made.git.GIT_DIR, 'refs', 'agentgraph', 'runs');
                mkdirSync(refs, { recursive: true });
                writeFileSync(join(refs, 'run-7.lock'), 'blocked');
              })
            )
          ),
      }))
    ).pipe(
      Layer.provide(
        kind === 'host'
          ? hostSandbox(where.origin)
          : dockerSandbox({ data: where.data, origin: where.origin, cache: '' })
      )
    );
    const layer = Layer.mergeAll(
      fileForge(where.forge),
      fileStore(where.data),
      sandbox,
      replaySession([[start('a'), wrote('pending.txt', 'keep me\n'), reply({ kind: 'ask', question: 'Continue?' })]])
    );
    const exit = await Effect.runPromiseExit(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(Effect.provide(layer))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(readFileSync(join(work!.dir, 'pending.txt'), 'utf8')).toBe('keep me\n');
    expect(existsSync(work!.git.GIT_INDEX_FILE ?? join(work!.git.GIT_DIR, 'index'))).toBe(true);
    expect(String(Exit.isFailure(exit) && exit.cause)).toContain(work!.dir);
    if (kind === 'docker') {
      writeFileSync(`${work!.dir}.owner`, '999999:gone');
      const restarted = Layer.mergeAll(
        fileForge(where.forge),
        fileStore(where.data),
        dockerSandbox({ data: where.data, origin: where.origin, cache: '' }),
        replaySession([[start('b'), reply({ kind: 'ask', question: 'Other run' })]])
      );
      await Effect.runPromise(
        drive(flow, begin(flow, { id: 'other', issue: 7, started: fresh().started }), small).pipe(
          Effect.provide(restarted)
        )
      );
      expect(readFileSync(join(work!.dir, 'pending.txt'), 'utf8')).toBe('keep me\n');
    }
  });

  it('cleans a partially acquired checkout after index setup fails', async () => {
    const where = world();
    const small = makeTestGraph('graph');
    const flow = {
      ...small.workflows.issue!,
      steps: small.workflows.issue!.steps.map(step => ({ ...step, checks: [] })),
    };
    mkdirSync(where.data, { recursive: true });
    let preserved = false;
    const sandbox = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, s => ({
        ...s,
        checkout: (...args: Parameters<typeof s.checkout>) =>
          Effect.zipRight(
            Effect.sync(() => writeFileSync(join(where.data, 'index'), 'blocked')),
            s.checkout(...args)
          ).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                preserved = readFileSync(join(where.data, 'index'), 'utf8') === 'blocked';
                rmSync(join(where.data, 'index'));
              })
            )
          ),
      }))
    ).pipe(Layer.provide(dockerSandbox({ data: where.data, origin: where.origin, cache: '' })));
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), sandbox, replaySession([]));
    const done = await Effect.runPromise(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(Effect.provide(layer))
    );
    expect(done).toMatchObject({ status: 'waiting', retried: true });
    expect(readdirSync(join(where.data, 'work')).filter(name => !name.endsWith('.owner'))).toEqual([]);
    const admin = join(where.data, 'mirror.git', 'worktrees');
    expect(existsSync(admin) ? readdirSync(admin) : []).toEqual([]);
    expect(preserved).toBe(true);
  });

  it('waits for host git and its helpers to stop before releasing a cancelled drive', async () => {
    const where = world();
    const small = makeTestGraph('graph');
    const flow = {
      ...small.workflows.issue!,
      steps: small.workflows.issue!.steps.map(step => ({ ...step, checks: [] })),
    };
    const bin = join(where.root, 'bin');
    mkdirSync(bin);
    const pidFile = join(where.root, 'git.pid');
    const childFile = join(where.root, 'helper.pid');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase " $* " in *" fetch "*)\n echo $$ > "${pidFile}"\n sleep 30 &\n echo $! > "${childFile}"\n wait\n exit 0;;\nesac\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 }
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previous}`;
    const layer = Layer.mergeAll(
      fileForge(where.forge),
      fileStore(where.data),
      dockerSandbox({ data: where.data, origin: where.origin, cache: '' }),
      replaySession([])
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small)
          );
          yield* Effect.gen(function* () {
            while (!existsSync(childFile)) yield* Effect.sleep('10 millis');
          }).pipe(Effect.timeoutFail({ duration: '3 seconds', onTimeout: () => new Error('git did not start') }));
          const pid = Number(readFileSync(pidFile, 'utf8'));
          const child = Number(readFileSync(childFile, 'utf8'));
          yield* Fiber.interrupt(fiber);
          expect(startTime(pid)).toBeUndefined();
          expect(startTime(child)).toBeUndefined();
          expect(existsSync(join(where.data, '.locks', 'run-7.lock'))).toBe(false);
        }).pipe(Effect.provide(layer))
      );
    } finally {
      for (const file of [childFile, pidFile]) {
        if (existsSync(file)) {
          try {
            process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
          } catch {}
        }
      }
      process.env.PATH = previous;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  it.each(['initialized', 'empty'])('does not steal a live run lock: %s', async kind => {
    const where = world();
    const previous = process.env.AGENTGRAPH_STATE;
    process.env.AGENTGRAPH_STATE = join(where.root, 'state');
    mkdirSync(join(where.root, 'state', 'owners'), { recursive: true });
    writeFileSync(join(where.root, 'state', 'owners', 'other'), '');
    mkdirSync(join(where.data, '.locks'), { recursive: true });
    writeFileSync(join(where.data, '.locks', 'run-7.lock'), kind === 'empty' ? '' : `${process.pid}:other`);
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Continue?' })]]);
    try {
      await expect(run(drive(w, fresh(), graph))).rejects.toThrow();
      expect(specs).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.AGENTGRAPH_STATE;
      else process.env.AGENTGRAPH_STATE = previous;
    }
  });

  it('does not remove a replacement lock when its walk closes', async () => {
    const where = world();
    const lock = join(where.data, '.locks', 'run-7.lock');
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Continue?' })]], undefined, () => {
      writeFileSync(lock, 'replacement');
    });
    await run(drive(w, fresh(), graph));
    expect(readFileSync(lock, 'utf8')).toBe('replacement');
  });

  it('drives the run as stored once it holds the lock, not the snapshot it was given', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Continue?' })]]);
    const advanced: Run = { ...fresh(), step: 'review', status: 'waiting', reason: 'Ready?' };
    await run(Effect.flatMap(Store, s => s.put(advanced)));
    const driven = await run(drive(w, fresh(), graph));
    expect(driven).toMatchObject({ step: 'review', status: 'waiting', reason: 'Ready?' });
    expect(specs).toEqual([]);
    expect(await run(Effect.flatMap(Store, s => s.get('run-7')))).toMatchObject({ step: 'review', reason: 'Ready?' });
  });

  it('walks a whole run: retry in the same session, a fresh review sending it back, a round cap, an answer, a merge', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), wrote('hello.txt', 'TODO\n'), { type: 'usage', input: 10, output: 5, usd: 0.5 }, reply(push, pull)],
      judged,
      [start('i1'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'back', why: 'say hello world' })],
      [start('i1'), wrote('hello.txt', 'hello world\n'), reply(push)],
      judged,
      [start('r2'), reply({ kind: 'back', why: 'add a newline' })],
      [start('i1'), wrote('hello.txt', 'hello world\n\n'), reply(push)],
      judged,
      [start('r3'), reply({ kind: 'back', why: 'still not right' })],
      [start('r4'), reply({ kind: 'comment', body: 'Ready to merge.' })],
    ]);

    const asked = await run(drive(w, fresh(), graph));
    expect(asked).toMatchObject({ step: 'review', status: 'waiting', reason: 'still not right' });
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

    const trace = readTrace(where.data, 'run-7');
    const prompts = trace.flatMap(t => ('prompt' in t ? [t.prompt] : []));
    expect(prompts).toEqual(specs.filter(s => !s.check));
    const first = trace.findIndex(t => 'prompt' in t && t.step === 'implement');
    expect(trace[first + 1]).toMatchObject({ step: 'implement', event: { type: 'start', session: 'i1' } });
    const replayed: Partial<Run> = {};
    for (const t of trace) {
      if (!('saved' in t)) continue;
      Object.assign(replayed, t.saved);
      for (const k of t.cleared ?? []) delete replayed[k];
    }
    expect(replayed).toEqual(asked);
    const resumed = trace.flatMap(t => ('saved' in t && t.saved.sessions ? [t.saved.sessions] : []));
    expect(resumed).toContainEqual(
      expect.objectContaining({ implement: expect.objectContaining({ id: 'i1', home: '/homes/i1' }) })
    );
    const sessions = trace.flatMap(t => ('session' in t ? [t.session] : []));
    expect(sessions[1]).toEqual({ id: 'i1', resumed: false, ended: 'stop', exit: 0, usd: 0.5 });
    expect(sessions[2]).toMatchObject({ id: 'i1', resumed: true, ended: 'stop', exit: 0 });
    expect(sessions.some(s => s.id === 'j')).toBe(false);
    const types = readChecks(where.data, 'run-7').filter(t => t.check.check === 'types');
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
    const answer = said.flatMap(m => getEventOutcome(w, asked, m) ?? [])[0]!;
    expect(answer).toEqual({ kind: 'answer', text: 'it is fine, ship it' });
    const waiting = await run(driveStored(w, transition(w, asked, answer), graph));
    expect(waiting).toMatchObject({ step: 'merge', status: 'waiting', rounds: { review: 1 } });
    expect(specs.at(-1)!.prompt).toContain('it is fine, ship it');

    const merged = {
      issue: 7,
      kind: 'merged',
      actor: 'morgan',
      trusted: true,
      at: '2026-10-18T00:00:00.000Z',
    } as const;
    expect(transition(w, waiting, getEventOutcome(w, waiting, merged)!)).toMatchObject({ status: 'done' });
  });

  it('writes to the forge under the run, its step, the session that proposed the write and its operation', async () => {
    const where = world();
    const { marks, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'back', why: 'say hello world' })],
    ]);
    await run(drive(w, fresh(), graph));
    const at = (step: string, session?: string) => ({ run: 'run-7', step, ...(session && { session }) });
    const landed = (step: string, session: string) => ({ ...at(step, session), operation: expect.any(String) });
    expect(marks).toEqual([
      ['label', at('triage')],
      ['comment', at('triage')],
      ['comment', landed('triage', 't1')],
      ['comment', at('implement')],
      ['push', landed('implement', 'i1')],
      ['pull_request', landed('implement', 'i1')],
      ['comment', at('review')],
      ['comment', at('implement', 'i1')],
      ['comment', landed('implement', 'i1')],
      ['label', at('implement', 'i1')],
      ['comment', at('implement', 'i1')],
    ]);
  });

  it('shows how to reply under a review comment', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('r'), reply({ kind: 'comment', body: 'Looked.' })]]);
    await run(drive(w, begin(w, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }), graph));
    expect(specs[0]!.prompt).toContain('"under":"<id of the review comment you answer>"');
  });

  it('opens one session over all items when a step fans out past 20', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('r'), reply({ kind: 'comment', body: 'Looked.' })]]);
    const fan = {
      ...w,
      steps: [{ name: 'review', does: { agent: 'reviewer' }, checks: [], tries: 1, each: { run: 'seq 21' } }],
    };
    const done = await run(
      drive(fan, begin(fan, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }), graph)
    );
    expect(done.status).toBe('done');
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('1\n\n2\n\n');
    expect(specs[0]!.prompt).toContain('\n\n21');
  });

  it('shows a judging agent the diff host git sees, whatever attributes the checkout sets', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), wrote('.gitattributes', '* -diff\n'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'ask', question: 'Done?' })],
    ]);
    await run(drive(w, fresh(), graph));
    expect(specs[2]!.agent).toBe('claim-checker');
    expect(specs[2]!.prompt).toContain('+hello');
    expect(specs[2]!.prompt).not.toContain('Binary files');
  });

  it('ends the run at once when a stop check fails: no try spent, nothing lands, the findings posted', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), wrote('hello.txt', 'hello\n'), wrote('secret.txt', 'key\n'), reply(push, pull)],
      judged,
    ]);
    const stopped = await run(drive(w, fresh(), graph));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped', tries: 0 });
    expect(stopped.reason).toMatch(/^safety: /);
    expect(specs).toHaveLength(3);
    expect(() => git(where.origin, 'rev-parse', '--verify', '-q', 'agentgraph/7')).toThrow();
    const issue = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(bodies(issue)[1]).toBe(`Stopped at implement: ${stopped.reason}\n\n${foot('Cost: $0.25.')}`);
    expect(issue.labels).toEqual(['agentgraph:stopped']);
    const runs = await run(Effect.flatMap(Store, s => s.list({ status: 'stopped' })));
    expect(runs.map(r => r.id)).toEqual(['run-7']);
  });

  it('traces a ref to the full output of every check it ran, which the store resolves', async () => {
    const where = world();
    const { run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
    ]);
    const loud = makeTestGraph('kit', {
      types: { run: 'echo types ok' },
      safety: { run: 'echo secret.txt found; exit 1' },
      claims: { agent: 'claim-checker' },
    });
    await run(drive(w, fresh(), loud));
    const logged = readChecks(where.data, 'run-7').filter(t => t.log);
    const texts = await run(Effect.forEach(logged, t => Effect.flatMap(Store, s => s.readLog(t.log!.hash))));
    const byName = logged.map((t, i) => [t.check.check, t.check.pass, texts[i]] as const);
    expect(byName.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['claims', true, expect.stringContaining('"prompt"')],
      ['safety', false, 'secret.txt found\n'],
      ['types', true, 'types ok\n'],
    ]);
    expect(logged.map(t => t.log!.bytes)).toEqual(texts.map(t => Buffer.byteLength(t!)));
  });

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
      [start('i1'), wrote('hello.txt', 'hello\n'), reply({ ...push, branch: 'agentgraph/8' })],
    ]);
    const scoped = makeTestGraph('kit', {
      safety: { run: '! git diff --name-only $AGENTGRAPH_BASE | grep -qx CHAT.md' },
    });
    const stopped = await run(drive(w, begin(w, { id: 'run-8', issue: 8, started: fresh().started }), scoped));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped' });
    expect(stopped.reason).toMatch(/^safety: /);
  });

  it('lets a check read the issue as the agent saw it, its number and the reply', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
    ]);
    const reads = makeTestGraph('kit', {
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
    const uses = { ...graph.skills.triage!, uses: ['rules', 'implement'] };
    await run(drive(w, fresh(), { ...graph, skills: { ...graph.skills, rules, triage: uses } }));
    expect(specs[0]!.prompt).toContain('You are triage.\n\nKeep it small.\n\nYou are implement.');
  });

  it('fails an implementing try that changed nothing, with feedback, instead of passing it on', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief: add hello.txt' })],
      [start('i1'), reply({ kind: 'comment', body: 'This already appears to be implemented.' })],
      [start('i1'), reply({ kind: 'ask', question: 'Is it done already?' })],
    ]);
    const asked = await run(drive(w, fresh(), graph));
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Is it done already?' });
    expect(specs[2]!.prompt).toContain('no change was made');
    const outcomes = readTrace(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(outcomes).toContainEqual(
      expect.objectContaining({ kind: 'failed', problems: [expect.stringMatching(/^no change was made/)] })
    );
  });

  it('stops the run once its summed session cost passes usd-per-run', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('t1'), { type: 'usage', input: 1, output: 1, usd: 0.5 }, reply({ kind: 'comment', body: 'Brief' })],
    ]);
    const capped = { ...graph, limits: { ...graph.limits, usdPerRun: 0.1 } };
    const stopped = await run(drive(w, fresh(), capped));
    expect(stopped).toMatchObject({ step: 'implement', status: 'stopped' });
    expect(stopped.reason).toBe("Spent $0.50, over the graph's usd-per-run of 0.1.");
    expect(specs).toHaveLength(1);
  });

  it('parks at once with what to fix on the host when the sandbox cannot start there', async () => {
    const where = world();
    const detail =
      'The image ghcr.io/x/sandbox:1 is missing on the runner host. Run `docker pull ghcr.io/x/sandbox:1` there.';
    const missing = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, s => ({
        ...s,
        checkout: () => Effect.fail(new SandboxError({ reason: 'host', detail })),
      }))
    ).pipe(Layer.provide(hostSandbox(where.origin)));
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), missing, replaySession([]));
    const parked = await Effect.runPromise(drive(w, fresh(), graph).pipe(Effect.provide(layer)));
    expect(parked).toMatchObject({
      status: 'waiting',
      reason: `Stopped by a runner error (SandboxError): ${detail}\nThen reply to try triage again.`,
    });
    expect(readTrace(where.data, 'run-7').filter(t => 'outcome' in t)).toHaveLength(1);
  });

  it('parks the run at its step when a session cannot run, and an answer tries that step again', async () => {
    const where = world();
    const { run } = services(where, []);
    const parked = await run(drive(w, { ...fresh(), feedback: 'fix the typo' }, graph));
    expect(parked).toMatchObject({ step: 'triage', status: 'waiting', feedback: 'fix the typo' });
    expect(parked.reason).toBe(
      'Stopped by a runner error (SessionStop). The details are in the trace of run run-7. Reply to try triage again from where it was.'
    );
    const stops = readTrace(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(stops).toContainEqual({ kind: 'ask', question: 'SessionStop: no scripted session left' });
    const sessions = readTrace(where.data, 'run-7').flatMap(t => ('session' in t ? [t.session] : []));
    expect(sessions[0]).toEqual({ resumed: false, ended: 'provider', usd: 0 });
    const again = services(where, [[start('t1'), reply({ kind: 'ask', question: 'Which file?' })]]);
    const resumed = await again.run(driveStored(w, transition(w, parked, { kind: 'answer', text: 'go on' }), graph));
    expect(resumed).toMatchObject({ step: 'triage', status: 'waiting', reason: 'Which file?' });
    expect(again.specs[0]!.prompt).toContain('go on');
    expect(again.specs[0]!.prompt).toContain('fix the typo');
    expect(resumed.retried).toBeUndefined();
  });

  it.each([
    'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    'Invalid API key · Fix external API key',
  ])('stops at once when the provider rejects the login: %s', async final => {
    const { run } = services(world(), [[start('t1'), { type: 'end', final, ended: 'error', exit: 1 }]]);
    const stopped = await run(drive(w, fresh(), graph));
    expect(stopped).toMatchObject({ status: 'stopped', reason: expect.stringContaining('rejected the key or login') });
  });

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
            { code: 0 },
          ]),
      }))
    ).pipe(Layer.provide(hostSandbox(where.origin)));
    const keys = Redacted.make(
      Object.keys(graph.agents)
        .map(agent => `${agent}=${key}`)
        .join(',')
    );
    const session = harnessSession({ data: where.data, proxy: { url: 'http://proxy', keys }, harnesses }).pipe(
      Layer.provide(sandbox)
    );
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), sandbox, session);
    await Effect.runPromise(drive(w, fresh(), graph).pipe(Effect.provide(layer)));
    const text = readFileSync(join(where.data, 'run-7', 'trace.jsonl'), 'utf8');
    expect(text).toContain('"prompt"');
    expect(text).toContain('AGENTGRAPH_LLM_API_KEY=***');
    expect(text).not.toContain(key);
  });
});

describe('setup', () => {
  const stopping = (): SessionEvent[][] => [
    [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
    [start('i1'), wrote('hello.txt', 'hello\n'), wrote('secret.txt', 'key\n'), reply(push, pull)],
  ];

  it('runs once per checkout with network before the first step', async () => {
    const where = world();
    const { order, commands, run } = services(where, stopping());
    await run(drive(w, fresh(), { ...graph, setup: 'test -e README.md' }));
    const setups = commands.filter(c => c.args.includes('test -e README.md'));
    expect(setups).toHaveLength(1);
    expect(order[0]).toBe(setups[0]);
    expect(setups[0]).toMatchObject({ cmd: 'sh', network: 'proxy' });
    expect(commands.length).toBeGreaterThan(1);
    expect(commands.slice(1).every(c => c.network === 'none')).toBe(true);
    const setup = readTrace(where.data, 'run-7').flatMap(t => ('setup' in t ? [t] : []));
    expect(setup).toEqual([expect.objectContaining({ step: 'triage', setup: { ms: expect.any(Number), exit: 0 } })]);
  });

  it('traces how many files the checkout wrote over the shared cache', async () => {
    const where = world();
    const sandbox = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, s => ({
        ...s,
        checkout: (...args: Parameters<typeof s.checkout>) =>
          Effect.map(s.checkout(...args), made => ({ ...made, written: async () => 2 })),
      }))
    ).pipe(Layer.provide(hostSandbox(where.origin)));
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), sandbox, replaySession(stopping()));
    await Effect.runPromise(drive(w, fresh(), graph).pipe(Effect.provide(layer)));
    const cache = readTrace(where.data, 'run-7').flatMap(t => ('cache' in t ? [t.cache] : []));
    expect(cache).toEqual([{ files: 2 }]);
  });

  it('parks the run as infra with the output when setup fails, before any step', async () => {
    const where = world();
    const { specs, run } = services(where, []);
    const failing = { ...graph, setup: 'echo registry unreachable; exit 3' };
    const parked = await run(Effect.flatMap(drive(w, fresh(), failing), r => drive(w, r, failing)));
    expect(parked).toMatchObject({ step: 'triage', status: 'waiting', tries: 0 });
    expect(specs).toHaveLength(0);
    const stops = readTrace(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome] : []));
    expect(stops).toContainEqual({ kind: 'ask', question: 'SandboxError: setup exited 3: registry unreachable' });
    expect(readTrace(where.data, 'run-7').some(t => 'setup' in t && t.setup.exit === 3)).toBe(true);
  });

  it('runs nothing with network when the graph has no setup', async () => {
    const where = world();
    const { commands, run } = services(where, stopping());
    await run(drive(w, fresh(), graph));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some(c => c.network === 'proxy')).toBe(false);
  });
});
