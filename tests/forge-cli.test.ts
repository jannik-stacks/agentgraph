import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { fileForge } from '../src/forge.ts';
import type { Proposal } from '../src/proposal.ts';
import { instanceAt } from '../src/instance.ts';
import { sweep, tick, type Instruction, type Services } from '../src/engine.ts';
import { loadHub } from '../src/hub.ts';
import { fileStore, Store } from '../src/store.ts';
import { start as main } from '../src/main.ts';
import { Sandbox, SandboxError } from '../src/sandbox.ts';
import type { Settings } from '../src/services.ts';
import type { SessionEvent } from '../src/trace.ts';
import { host } from './doubles/sandbox.ts';
import { scripted } from './doubles/session.ts';
import { reply, seeded, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';

const cli = join(import.meta.dirname, '..', 'bin', 'forge.ts');
const sandboxHub = join(import.meta.dirname, '..', 'examples', 'sandbox');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTGRAPH_FORGE;
  delete process.env.AGENTGRAPH_PROXY_KEYS;
});

/** A repo to seed from, a forge folder and a data dir; `forge` runs bin/forge.ts as morgan, `run` sweeps once. */
const world = () => {
  const { root, seed, data } = seeded('forge-cli', {
    'package.json': JSON.stringify({ scripts: { test: '! grep -q TODO hello.txt' } }),
  });
  dirs.push(root);
  const dir = join(root, 'forge');
  const forge = (...args: string[]) => {
    const r = spawnSync(process.execPath, [cli, dir, ...args, '--as', 'morgan'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  Object.assign(process.env, { AGENTGRAPH_FORGE: dir, AGENTGRAPH_PROXY_KEYS: 'implementor=k1,reviewer=k2' });
  const seen: Settings[] = [];
  const run = (turns: SessionEvent[][], issue: number | 'all' = 'all', instruction?: Instruction, failures = 0) => {
    let left = failures;
    return main({ hub: sandboxHub, issue, data, ...(instruction && { instruction }) }, s => {
      seen.push(s);
      const forgeDir = s.forge as string;
      return Layer.mergeAll(
        fileForge(forgeDir),
        fileStore(s.data),
        Layer.effect(
          Sandbox,
          Effect.map(Sandbox, sandbox => ({
            ...sandbox,
            checkout: (...args) =>
              Effect.suspend(() =>
                left-- > 0
                  ? Effect.fail(new SandboxError({ reason: 'infra', detail: 'no commit for main' }))
                  : sandbox.checkout(...args)
              ),
          }))
        ).pipe(Layer.provide(host(join(forgeDir, 'origin.git')))),
        scripted(turns)
      );
    });
  };
  return { root, seed, dir, origin: join(dir, 'origin.git'), forge, run, seen };
};

describe('bin/forge.ts with run --forge', () => {
  it('files an issue, runs it to a pull request, sends it back from the pull request, and merges', async () => {
    const w = world();
    w.forge('init', w.seed);
    writeFileSync(join(w.root, 'body.md'), 'Add hello.txt.\n');
    expect(w.forge('issue', 'Add a greeting', '--body', join(w.root, 'body.md'))).toBe('#1');
    w.forge('label', '1', 'agent:ready');

    const push = (message: string): Proposal => ({ kind: 'push', branch: 'agentgraph/1', message });
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/1',
      base: 'main',
      title: 'Add hello',
      body: 'Adds hello.txt.',
    };
    const first = await w.run([
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(w.seen[0]!.forge).toBe(w.dir);
    expect(first.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(readFileSync(join(w.dir, '2', 'diff.patch'), 'utf8')).toContain('+hello');
    expect(w.forge('show')).toBe(
      '#1 open Add a greeting [agent:ready, agentgraph:waiting]\n#2 open Add hello (agentgraph/1 into main)'
    );

    w.forge('comment', '2', '/agent say hello world');
    const routed = await w.run([[start('o'), reply({ kind: 'tell', issue: 1, text: 'say hello world' })]]);
    expect(routed.map(r => [r.workflow, r.status])).toEqual([['router', 'done']]);
    const second = await w.run([
      [start('a'), reply({ kind: 'comment', body: 'On it.' }, { kind: 'back', why: 'say hello world' })],
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(second.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(w.forge('show', '2')).toContain('+hello world');

    expect(w.forge('merge', '2')).toMatch(/^main at [0-9a-f]{40}$/);
    expect(git(w.origin, 'show', 'main:hello.txt')).toBe('hello world');
    expect(w.forge('show')).toBe(
      '#1 closed Add a greeting [agent:ready, agentgraph:waiting]\n#2 merged Add hello (agentgraph/1 into main)'
    );
    const last = await w.run([]);
    expect(last.map(r => [r.issue, r.step, r.status])).toEqual([[1, 'merge', 'done']]);
    expect(w.forge('show')).toBe(
      '#1 closed Add a greeting [agent:ready, agentgraph:done]\n#2 merged Add hello (agentgraph/1 into main)'
    );
  }, 30_000);

  it('sends a pull request back with the line comments posted just before the review in its reason', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'Add a greeting');
    w.forge('label', '1', 'agent:ready');
    const push = (message: string): Proposal => ({ kind: 'push', branch: 'agentgraph/1', message });
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/1',
      base: 'main',
      title: 'Add hello',
      body: 'Adds it.',
    };
    const [waiting] = await w.run([
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    w.forge('comment', '2', 'say hello world', '--line', 'hello.txt:1');
    w.forge('review', '2', 'changes', 'see the line note');
    await w.run([
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    const backs = readFileSync(join(w.root, 'data', waiting!.id, 'trace.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { outcome?: { kind: string; why?: string } })
      .flatMap(l => (l.outcome?.kind === 'back' ? [l.outcome.why] : []));
    expect(backs).toEqual(['see the line note\nhello.txt:1: say hello world']);
  }, 30_000);

  it('runs a stacked issue on the pull request of the one it stacks on', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'Add a greeting');
    writeFileSync(join(w.root, 'body.md'), 'Add bye.txt.\n\nStacks on #1\n');
    w.forge('issue', 'Say bye', '--body', join(w.root, 'body.md'));
    w.forge('label', '1', 'agent:ready');
    w.forge('label', '2', 'agent:ready');
    const turn = (n: number, file: string): SessionEvent[][] => [
      [
        start(`i${n}`),
        wrote(file, `${file}\n`),
        reply(
          { kind: 'push', branch: `agentgraph/${n}`, message: `feat: add ${file}` },
          { kind: 'pull_request', branch: `agentgraph/${n}`, base: 'main', title: `Add ${file}`, body: `Adds ${file}.` }
        ),
      ],
      [start(`r${n}`), reply({ kind: 'comment', body: 'Looks right.' })],
    ];
    await w.run([...turn(1, 'hello.txt'), ...turn(2, 'bye.txt')]);
    expect(w.forge('show')).toContain('#3 open Add hello.txt (agentgraph/1 into main)');
    expect(w.forge('show')).toContain('#4 open Add bye.txt (agentgraph/2 into agentgraph/1)');

    w.forge('merge', '3');
    expect(w.forge('show')).toContain('#4 open Add bye.txt (agentgraph/2 into main)');
    w.forge('merge', '4');
    expect(git(w.origin, 'show', 'main:bye.txt')).toBe('bye.txt');
    expect(existsSync(join(w.dir, '2.md'))).toBe(true);
  }, 30_000);

  it('starts the router on a bare mention, stops a waiting run on a mention with stop, and ignores stop with no run', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'Add a greeting');
    w.forge('comment', '1', '/agent stop');
    expect(await w.run([])).toEqual([]);

    w.forge('comment', '1', '/agent');
    const asked = await w.run([[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(asked.map(r => [r.step, r.status])).toEqual([['router', 'waiting']]);

    w.forge('comment', '1', '/agent stop wrong issue');
    const stopped = await w.run([]);
    expect(stopped.map(r => [r.step, r.status, r.reason])).toEqual([['router', 'stopped', 'wrong issue']]);
  });

  it.each([0, 1])(
    'routes review say with %i checkout failures',
    async failures => {
      const w = world();
      w.forge('init', w.seed);
      w.forge('issue', 'Add a greeting');
      w.forge('label', '1', 'agent:ready');
      const [waiting] = await w.run([
        [
          start('i'),
          wrote('hello.txt', 'hello\n'),
          reply(
            { kind: 'push', branch: 'agentgraph/1', message: 'feat: hello' },
            { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Hello', body: 'Hello' }
          ),
        ],
        [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
      ]);
      w.forge('comment', '2', 'This line?', '--line', 'hello.txt:1');
      const event = readFileSync(join(w.dir, '2.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
        .at(-1);
      const routed = await w.run(
        [
          [
            start('cli-router'),
            reply({ kind: 'comment', body: 'Answer in thread.' }, { kind: 'tell', issue: 1, text: 'Please revise it' }),
          ],
        ],
        2,
        { kind: 'say', issue: 2, comment: event.comment.id, text: 'Please explain this line' },
        failures
      );
      const router = routed.find(r => r.workflow === 'router')!;
      expect(router.status).toBe('done');
      const trace = readFileSync(join(w.root, 'data', router.id, 'trace.jsonl'), 'utf8');
      expect(trace).toContain('"source":"cli"');
      expect(
        JSON.parse(
          trace
            .trim()
            .split('\n')
            .find(l => JSON.parse(l).prompt)!
        ).prompt.prompt
      ).toContain('hello.txt:1');
      expect(
        trace
          .trim()
          .split('\n')
          .map(l => JSON.parse(l))
          .some(t => t.prompt?.prompt.includes('Please explain this line'))
      ).toBe(true);
      const timeline = readFileSync(join(w.dir, '2.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l));
      expect(
        timeline.some(m => m.comment?.body.includes('Answer in thread.') && m.comment.under === event.comment.id)
      ).toBe(true);
      expect(readFileSync(join(w.root, 'data', waiting!.id, 'trace.jsonl'), 'utf8')).toContain(
        '"text":"Please revise it"'
      );
    },
    30_000
  );

  it('says on an issue, and rejects an unknown review thread', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'A question');
    const [run] = await w.run([[start('say'), reply({ kind: 'comment', body: 'Here is the answer.' })]], 1, {
      kind: 'say',
      issue: 1,
      text: 'Explain the project',
    });
    expect(run!.status).toBe('done');
    expect(w.forge('show', '1')).toContain('Here is the answer.');
    await expect(w.run([], 1, { kind: 'say', issue: 1, comment: 'missing', text: 'Explain' })).rejects.toThrow(
      'no review comment'
    );
  });

  it.each([0, 1])('keeps say text in the router prompt with %i checkout failures', async failures => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'A question');
    const [run] = await w.run(
      [[start('router'), reply({ kind: 'comment', body: 'Here is why.' })]],
      1,
      { kind: 'say', issue: 1, text: 'Explain the retry path' },
      failures
    );
    expect(run!.status).toBe('done');
    const trace = readFileSync(join(w.root, 'data', run!.id, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(trace.filter(t => t.prompt).map(t => t.prompt.prompt)).toEqual([
      expect.stringContaining('@cli: /agent Explain the retry path'),
    ]);
    expect(trace.filter(t => t.outcome?.question === 'SandboxError: no commit for main')).toHaveLength(failures);
  });

  it('parks say after both checkout attempts fail', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'A question');
    const [run] = await w.run([], 1, { kind: 'say', issue: 1, text: 'Explain the project' }, 2);
    expect(run).toMatchObject({ status: 'waiting', retried: true });
  });

  it.each([1, 'all'] as const)('recovers an unowned running run through %s', async issue => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'A question');
    const [parked] = await w.run([], 1, { kind: 'say', issue: 1, text: 'Remember the original request' }, 2);
    const { reason: _reason, ...running } = { ...parked!, status: 'running' as const, retried: true as const };
    await Effect.runPromise(
      Effect.flatMap(Store, store => store.put(running)).pipe(Effect.provide(fileStore(join(w.root, 'data'))))
    );
    const lock = join(w.root, 'data', '.locks', `${running.id}.lock`);
    writeFileSync(lock, String(process.pid));
    expect(await w.run([], issue)).toEqual([running]);
    const dead = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: '' } });
    writeFileSync(lock, String(dead.pid));
    const [recovered] = await w.run([[start('recovered'), reply({ kind: 'comment', body: 'Recovered.' })]], issue);
    expect(recovered).toMatchObject({ id: running.id, status: 'done' });
    expect(existsSync(lock)).toBe(false);
    const trace = readFileSync(join(w.root, 'data', running.id, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(trace.filter(t => t.prompt).at(-1).prompt.prompt).toContain('Remember the original request');
  });

  it('dispatches with the router checks and tells through the CLI without a hub or App', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'A task');
    const dispatched = spawnSync(
      process.execPath,
      [
        join(cli, '..', 'run.ts'),
        'dispatch',
        '--hub',
        sandboxHub,
        '--data',
        join(w.root, 'data'),
        '--forge',
        w.dir,
        '--workflow',
        'triage',
        '--issue',
        '1',
        '--step',
        'triage',
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }
    );
    expect(dispatched.status, dispatched.stderr).toBe(0);
    const [run] = await Effect.runPromise(
      Effect.flatMap(Store, store => store.list()).pipe(Effect.provide(fileStore(join(w.root, 'data'))))
    );
    expect(run).toMatchObject({ workflow: 'triage', status: 'running', by: 'cli' });
    await expect(w.run([], 1, { kind: 'dispatch', issue: 1, workflow: 'triage' })).rejects.toThrow(
      'a live run holds #1'
    );
    await expect(w.run([], 1, { kind: 'dispatch', issue: 1, workflow: 'router' })).rejects.toThrow(
      'not a workflow with on: dispatch'
    );
    const tell = (issue: string) =>
      spawnSync(
        process.execPath,
        [join(cli, '..', 'run.ts'), 'tell', '--data', join(w.root, 'data'), '--issue', issue, 'Use the new API'],
        { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }
      );
    expect(tell('1').status).toBe(0);
    expect(readFileSync(join(w.root, 'data', run!.id, 'trace.jsonl'), 'utf8')).toContain(
      '"told":{"text":"Use the new API","by":"cli"}'
    );
    expect(tell('99').stderr).toContain('no live run on #99');
    const stored = await Effect.runPromise(
      Effect.flatMap(Store, store => store.get(run!.id)).pipe(Effect.provide(fileStore(join(w.root, 'data'))))
    );
    expect(stored!.status).toBe('running');
  });

  it('recovers a PR review command passed by the repo cursor with a per-issue sweep', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'Add a greeting');
    w.forge('label', '1', 'agent:ready');
    const [waiting] = await w.run([
      [
        start('i'),
        wrote('hello.txt', 'hello\n'),
        reply(
          { kind: 'push', branch: 'agentgraph/1', message: 'feat: hello' },
          { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Hello', body: 'Hello' }
        ),
      ],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    w.forge('comment', '2', '/agent explain this line', '--line', 'hello.txt:1');
    const hub = await Effect.runPromise(loadHub(sandboxHub));
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              fileForge(w.dir),
              fileStore(join(w.root, 'data')),
              host(w.origin),
              scripted([[start('router'), reply({ kind: 'comment', body: 'Here is why.' })]])
            )
          )
        )
      );
    w.forge('issue', 'Newer work');
    const [newer] = await w.run([], 3, { kind: 'dispatch', issue: 3, workflow: 'triage' });
    await run(
      Effect.flatMap(Store, store =>
        Effect.zipRight(
          store.put({ ...newer!, status: 'done' }),
          store.trace(waiting!.id, {
            at: newer!.started,
            step: waiting!.step,
            outcome: { kind: 'ask', question: 'Waiting at merge' },
            run: { step: waiting!.step, status: 'waiting', tries: waiting!.tries, rounds: waiting!.rounds },
          })
        )
      )
    );
    expect(await run(tick(hub, undefined, false, 30_000))).toEqual([]);
    const recovered = await run(sweep(hub));
    expect(recovered.map(r => [r.workflow, r.status])).toEqual([['router', 'done']]);
    expect(w.forge('show', '2')).toContain('Here is why.');
  }, 30_000);

  it('seeds only the given commit with --at, so a later commit is not in the origin', () => {
    const w = world();
    const base = git(w.seed, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(w.seed, 'fix.txt'), 'the fix\n');
    git(w.seed, 'add', '-A');
    git(w.seed, 'commit', '-q', '-m', 'fix');
    const later = git(w.seed, 'rev-parse', 'HEAD').trim();
    w.forge('init', w.seed, '--at', base);
    expect(git(w.origin, 'rev-parse', 'main').trim()).toBe(base);
    expect(spawnSync('git', ['--git-dir', w.origin, 'cat-file', '-e', later]).status).not.toBe(0);
  });
});

describe('an instance', () => {
  it('runs an issue to a merge on its own copy, and writes to the repo only on export', async () => {
    const w = world();
    writeFileSync(join(w.seed, 'wip.txt'), 'unsaved\n');
    git(w.seed, 'remote', 'add', 'origin', 'https://example.invalid/seed.git');
    const looks = () =>
      ['for-each-ref', 'status --porcelain', 'remote -v', 'rev-parse HEAD']
        .map(args => git(w.seed, ...args.split(' ')))
        .join('\n');
    const before = looks();
    const at = join(w.root, 'instances', 'seed');
    const bh = (where: string, ...args: string[]) => {
      const r = spawnSync(process.execPath, [cli, where, ...args], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    bh(at, 'init', w.seed, '--hub', sandboxHub, '--as', 'morgan');
    const instance = instanceAt(join(at, 'hub'))!;
    expect(instance).toMatchObject({ dir: at, repo: w.seed, base: 'main', owner: 'morgan' });
    expect(bh(instance.hub, 'issue', 'Add a greeting', '--label', 'agent:ready')).toBe('#1');

    process.env.AGENTGRAPH_FORGE = instance.forge;
    const run = (turns: SessionEvent[][]) =>
      main({ hub: instance.hub, issue: 'all', data: instance.data }, s =>
        Layer.mergeAll(
          fileForge(s.forge as string),
          fileStore(s.data),
          host(join(s.forge as string, 'origin.git')),
          scripted(turns)
        )
      );
    const push = (message: string): Proposal => ({ kind: 'push', branch: 'agentgraph/1', message });
    const pull: Proposal = { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Add hello', body: '' };
    const first = await run([
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(first.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    const status = spawnSync(process.execPath, [join(cli, '..', 'run.ts'), 'status', '--instance', at], {
      encoding: 'utf8',
    });
    expect(status.stdout).toContain(`node bin/run.ts --instance ${at} --issue 1`);

    bh(at, 'comment', '2', 'say world', '--line', 'hello.txt:1');
    bh(at, 'review', '2', 'changes', 'not quite');
    const second = await run([
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(second.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    const traces = readdirSync(instance.data, { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.jsonl'))
      .map(f => readFileSync(join(instance.data, f), 'utf8'))
      .join('');
    expect(traces).toContain('sent this back: not quite');
    expect(traces).toContain('@morgan on hello.txt:1, id 2-2: say world');
    expect(bh(at, 'show', '2')).toContain('morgan comment on hello.txt:1\nsay world');

    bh(at, 'merge', '2');
    expect(bh(at, 'show')).toContain('#2 merged Add hello');
    expect(looks()).toBe(before);

    const patch = join(w.root, 'hello.patch');
    bh(at, 'export', '2', '--patch', patch);
    expect(readFileSync(patch, 'utf8')).toContain('+hello world');
    expect(looks()).toBe(before);
    expect(bh(at, 'export', '2')).toMatch(/^agentgraph\/1 at [0-9a-f]{40} in /);
    expect(git(w.seed, 'show', 'agentgraph/1:hello.txt')).toBe('hello world');
    expect(git(w.seed, 'status', '--porcelain')).toBe('?? wip.txt');

    git(w.seed, 'merge', '-q', '--ff-only', 'agentgraph/1');
    writeFileSync(join(w.seed, 'later.txt'), 'later\n');
    git(w.seed, 'add', 'later.txt');
    git(w.seed, 'commit', '-q', '-m', 'later');
    expect(bh(at, 'sync')).toBe(`main at ${git(w.seed, 'rev-parse', 'HEAD')}`);
  }, 60_000);
});
