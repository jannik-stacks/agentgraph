import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { folderTracker, Tracker, writeIssueFile } from '../src/tracker.ts';
import type { Proposal } from '../src/proposal.ts';
import {
  ensureGraph,
  ensureInstance,
  writePullToRepo,
  writeLabels,
  mergePull,
  ensureBase,
  writeClosed,
  writeComment,
  writeReview,
  formatGraphName,
  whyGraphUncommitted,
  writeInstanceProvider,
} from '../src/instance.ts';
import { formatIssueList, formatIssueTimeline } from '../src/status.ts';
import { scanIssuesAndRunningRuns, tick, type Instruction, type Services } from '../src/engine.ts';
import { stoppedByRunner } from '../src/context.ts';
import { begin } from '../src/workflow.ts';
import { loadGraph } from '../src/folder.ts';
import { fileStore, Store } from '../src/store.ts';
import { createLoopLock, isLoopHeld, start as main, writeTriggeringIssue } from '../src/main.ts';
import { Sandbox, SandboxError } from '../src/sandbox.ts';
import type { Settings } from '../src/services.ts';
import type { SessionEvent } from '../src/trace.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, reply, seeded, start, wrote } from './fixtures.ts';
import { git, tmp } from './kit.ts';

const runTs = join(import.meta.dirname, '..', 'bin', 'run.ts');
const sandboxGraph = join(import.meta.dirname, '..', 'examples', 'sandbox');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTGRAPH_TRACKER;
  delete process.env.AGENTGRAPH_PROXY_KEYS;
  delete process.env.AGENTGRAPH_TRUST;
});

const world = () => {
  const { root, seed, data } = seeded('tracker-cli', {
    'package.json': JSON.stringify({ scripts: { test: '! grep -q TODO hello.txt' } }),
  });
  dirs.push(root);
  const dir = join(root, 'tracker');
  const as = 'morgan';
  const tracker = async (verb: string, ...args: string[]): Promise<string> => {
    const flag = (name: string) => {
      const at = args.indexOf(`--${name}`);
      return at < 0 ? undefined : args.splice(at, 2)[1];
    };
    const n = Number(args[0]);
    const issues = Effect.provide(Tracker, folderTracker(dir));
    switch (verb) {
      case 'init':
        git(root, 'init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git'));
        git(seed, 'push', '-q', join(dir, 'origin.git'), `${flag('at') ?? 'main'}:refs/heads/main`);
        return '';
      case 'issue': {
        const body = flag('body');
        const label = flag('label');
        const text = body ? readFileSync(body, 'utf8').trim() : '';
        return `#${await writeIssueFile(dir, { title: args[0]!, author: as, labels: label ? [label] : [] }, text)}`;
      }
      case 'label':
        await Effect.runPromise(
          Effect.flatMap(Tracker, f => f.apply(n, { kind: 'label', add: [args[1]!] })).pipe(
            Effect.provide(folderTracker(dir, as))
          )
        );
        return '';
      case 'comment': {
        const line = flag('line');
        await writeComment(dir, as, n, args.slice(1).join(' '), line);
        return '';
      }
      case 'review':
        await writeReview(
          dir,
          as,
          n,
          args[1] === 'approve' ? 'approved' : 'changes_requested',
          args.slice(2).join(' ')
        );
        return '';
      case 'close':
        await writeClosed(dir, as, n);
        return '';
      case 'merge': {
        const pull = await mergePull({ tracker: dir, owner: as }, n);
        return `${pull.base} at ${pull.head}`;
      }
      case 'show': {
        const f = await Effect.runPromise(issues);
        if (!args[0]) return formatIssueList(await Effect.runPromise(f.issues()));
        const diff = join(dir, String(n), 'diff.patch');
        return formatIssueTimeline(
          await Effect.runPromise(f.issue(n)),
          existsSync(diff) ? readFileSync(diff, 'utf8') : ''
        ).trim();
      }
    }
    throw new Error(`no tracker verb ${verb}`);
  };
  Object.assign(process.env, { AGENTGRAPH_TRACKER: dir, AGENTGRAPH_PROXY_KEYS: 'implementor=k1,reviewer=k2' });
  const seen: Settings[] = [];
  const run = (
    turns: SessionEvent[][],
    issue: number | 'all' = 'all',
    instruction?: Instruction,
    failures = 0,
    marked?: true
  ) => {
    let left = failures;
    const services = (s: Settings) => {
      seen.push(s);
      const trackerDir = s.tracker as string;
      return Layer.mergeAll(
        folderTracker(trackerDir),
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
        ).pipe(Layer.provide(hostSandbox(join(trackerDir, 'origin.git')))),
        replaySession(turns)
      );
    };
    return main(
      { graph: sandboxGraph, issue, data, ...(instruction && { instruction }), ...(marked && { marked }) },
      services
    );
  };
  return { root, seed, dir, origin: join(dir, 'origin.git'), tracker, run, seen };
};

describe('the human verbs on a tracker folder', () => {
  it('files an issue, runs it to a pull request, sends it back from the pull request, and merges', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    writeFileSync(join(w.root, 'body.md'), 'Add hello.txt.\n');
    expect(await w.tracker('issue', 'Add a greeting', '--body', join(w.root, 'body.md'))).toBe('#1');
    await w.tracker('label', '1', 'agent:ready');

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
    expect(w.seen[0]!.tracker).toBe(w.dir);
    expect(first.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(readFileSync(join(w.dir, '2', 'diff.patch'), 'utf8')).toContain('+hello');
    expect(await w.tracker('show')).toBe(
      '#1 open Add a greeting [agent:ready, agentgraph:needs-review]\n#2 open Add hello (agentgraph/1 into main)'
    );

    await w.tracker('comment', '2', '/agent say hello world');
    const routed = await w.run([[start('o'), reply({ kind: 'tell', issue: 1, text: 'say hello world' })]]);
    expect(routed.map(r => [r.workflow, r.status])).toEqual([['router', 'done']]);
    const second = await w.run([
      [start('a'), reply({ kind: 'comment', body: 'On it.' }, { kind: 'back', why: 'say hello world' })],
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(second.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(await w.tracker('show', '2')).toContain('+hello world');

    expect(await w.tracker('merge', '2')).toMatch(/^main at [0-9a-f]{40}$/);
    expect(git(w.origin, 'show', 'main:hello.txt')).toBe('hello world');
    expect(await w.tracker('show')).toBe(
      '#1 closed Add a greeting [agent:ready, agentgraph:needs-review]\n#2 merged Add hello (agentgraph/1 into main)'
    );
    const last = await w.run([]);
    expect(last.map(r => [r.issue, r.step, r.status])).toEqual([[1, 'merge', 'done']]);
    expect(await w.tracker('show')).toBe(
      '#1 closed Add a greeting [agent:ready, agentgraph:done]\n#2 merged Add hello (agentgraph/1 into main)'
    );
  });

  it('starts a run on a dropped issue file once, and reads one without frontmatter', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    writeFileSync(join(w.dir, '1.md'), '# Fix the typo\n\nIn the readme.\n');
    writeFileSync(
      join(w.dir, '2.md'),
      '---\ntitle: Add a greeting\nauthor: morgan\nlabels: [agent:ready]\n---\n\nAdd hello.txt.\n'
    );
    expect(await w.tracker('show')).toBe('#1 open Fix the typo\n#2 open Add a greeting [agent:ready]');
    expect(await w.tracker('show', '2')).toMatch(/morgan label agent:ready/);
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/2',
      base: 'main',
      title: 'Add hello',
      body: 'Adds it.',
    };
    const first = await w.run([
      [
        start('i'),
        wrote('hello.txt', 'hello\n'),
        reply({ kind: 'push', branch: 'agentgraph/2', message: 'feat: add hello' }, pull),
      ],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(first.map(r => [r.issue, r.step, r.status])).toEqual([[2, 'merge', 'waiting']]);
    expect(await w.tracker('show', '3')).toContain('+hello');
    expect(await w.run([])).toEqual([]);
    expect(readdirSync(join(w.root, 'data')).filter(d => d.startsWith('issue-'))).toHaveLength(1);
    await w.tracker('close', '1');
    expect(await w.tracker('show')).toMatch(/^#1 closed Fix the typo\n/);
    expect(await w.tracker('show', '1')).toContain('In the readme.');
  });

  it('goes from text to a run to a diff with no GitHub', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    await expect(writeTriggeringIssue(graph, w.dir, 'Add a greeting', 'morgan', 'router')).rejects.toThrow(
      'name one workflow with a label: --workflow <name>'
    );
    await expect(writeTriggeringIssue(graph, w.dir, 'Add a greeting', 'morgan')).rejects.toThrow('issue|triage');
    await expect(writeTriggeringIssue(graph, w.dir, 'Add a greeting', 'x[bot]', 'issue')).rejects.toThrow(
      'x[bot] may not'
    );
    await expect(
      writeTriggeringIssue({ ...graph, trust: ['ann'] }, w.dir, 'Add a greeting', 'morgan', 'issue')
    ).rejects.toThrow('morgan may not');
    expect(await writeTriggeringIssue(graph, w.dir, 'Add a greeting\n\nAdd hello.txt.', 'morgan', 'issue')).toBe(1);
    expect(await w.tracker('show', '1')).toMatch(
      /^#1 open Add a greeting by morgan \[agent:ready\]\n\nAdd hello.txt.\n/
    );
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/1',
      base: 'main',
      title: 'Add hello',
      body: 'Adds it.',
    };
    const runs = await w.run(
      [
        [
          start('i'),
          wrote('hello.txt', 'hello\n'),
          reply({ kind: 'push', branch: 'agentgraph/1', message: 'feat: add hello' }, pull),
        ],
        [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
      ],
      1,
      undefined,
      0,
      true
    );
    expect(runs.map(r => [r.workflow, r.step, r.status])).toEqual([['issue', 'merge', 'waiting']]);
    expect(await w.tracker('show', '2')).toContain('+hello');
    expect(await w.tracker('show', '1')).toMatch(/, edited \S+ \S+ comment\nAgentgraph status: waiting for you/);
  });

  it('sends a pull request back with the line comments posted just before the review in its reason', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    await w.tracker('label', '1', 'agent:ready');
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
    await w.tracker('comment', '2', 'say hello world', '--line', 'hello.txt:1');
    await w.tracker('review', '2', 'changes', 'see the line note');
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
  });

  it('runs a stacked issue on the pull request of the one it stacks on', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    writeFileSync(join(w.root, 'body.md'), 'Add bye.txt.\n\nStacks on #1\n');
    await w.tracker('issue', 'Say bye', '--body', join(w.root, 'body.md'));
    await w.tracker('label', '1', 'agent:ready');
    await w.tracker('label', '2', 'agent:ready');
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
    expect(await w.tracker('show')).toContain('#3 open Add hello.txt (agentgraph/1 into main)');
    expect(await w.tracker('show')).toContain('#4 open Add bye.txt (agentgraph/2 into agentgraph/1)');

    await w.tracker('merge', '3');
    expect(await w.tracker('show')).toContain('#4 open Add bye.txt (agentgraph/2 into main)');
    await w.tracker('merge', '4');
    expect(git(w.origin, 'show', 'main:bye.txt')).toBe('bye.txt');
    expect(existsSync(join(w.dir, '2.md'))).toBe(true);
  });

  it('starts the router on a bare mention, stops a waiting run on a mention with stop, and ignores stop with no run', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    await w.tracker('comment', '1', '/agent stop');
    expect(await w.run([])).toEqual([]);

    await w.tracker('comment', '1', '/agent');
    const asked = await w.run([[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(asked.map(r => [r.step, r.status])).toEqual([['router', 'waiting']]);

    await w.tracker('comment', '1', '/agent stop wrong issue');
    const stopped = await w.run([]);
    expect(stopped.map(r => [r.step, r.status, r.reason])).toEqual([['router', 'stopped', 'wrong issue']]);
  });

  it.each([0, 1])('routes review say with %i checkout failures', async failures => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    await w.tracker('label', '1', 'agent:ready');
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
    await w.tracker('comment', '2', 'This line?', '--line', 'hello.txt:1');
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
  });

  it('says on an issue, and rejects an unknown review thread', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A question');
    const [run] = await w.run([[start('say'), reply({ kind: 'comment', body: 'Here is the answer.' })]], 1, {
      kind: 'say',
      issue: 1,
      text: 'Explain the project',
    });
    expect(run!.status).toBe('done');
    expect(await w.tracker('show', '1')).toContain('Here is the answer.');
    await expect(w.run([], 1, { kind: 'say', issue: 1, comment: 'missing', text: 'Explain' })).rejects.toThrow(
      'no review comment'
    );
  });

  it.each([0, 1])('keeps say text in the router prompt with %i checkout failures', async failures => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A question');
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

  it('gives comments from two racing processes different ids', async () => {
    const dir = tmp('tracker-race');
    dirs.push(dir);
    const trackerTs = join(import.meta.dirname, '..', 'src', 'tracker.ts');
    const writer = `import { writeTimelineEvent } from ${JSON.stringify(trackerTs)};
const comment = i => ({ issue: 1, kind: 'comment', actor: 'a', trusted: true, comment: { body: String(i) } });
await Promise.all(Array.from({ length: 50 }, (_, i) => writeTimelineEvent(process.argv[1], comment(i))));`;
    const write = () =>
      new Promise<number | null>(done =>
        spawn('node', ['--input-type=module', '-e', writer, dir], { stdio: 'inherit' }).on('close', done)
      );
    expect(await Promise.all([write(), write()])).toEqual([0, 0]);
    const ids = readFileSync(join(dir, '1.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { comment: { id: string } }).comment.id);
    expect(new Set(ids).size).toBe(100);
  });

  it('parks say after both checkout attempts fail', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A question');
    const [run] = await w.run([], 1, { kind: 'say', issue: 1, text: 'Explain the project' }, 2);
    expect(run).toMatchObject({ status: 'waiting', retried: true });
  });

  it.each([1, 'all'] as const)('recovers an unowned running run through %s', async issue => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A question');
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

  it('sets, removes and prints run labels through the CLI', async () => {
    const w = world();
    const data = join(w.root, 'data');
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    const run = begin(graph.workflows.triage!, { id: 'triage-1', issue: 1, started: '2026-10-16T00:00:01.000Z' });
    const { issue: _issue, ...imported } = { ...run, id: 'import-1' };
    await Effect.runPromise(
      Effect.flatMap(Store, store => Effect.andThen(store.put(run), store.put(imported))).pipe(
        Effect.provide(fileStore(data))
      )
    );
    const label = (...args: string[]) =>
      spawnSync(process.execPath, [runTs, 'label', ...args, '--data', data, '--tracker', w.dir], {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
      });
    const runs = [
      label('triage-1', 'arm=v2', 'model=gpt 6'),
      label('triage-1', 'arm-', 'set=explorer'),
      label('triage-1', 'Bad=1'),
      label('missing-1', 'arm=v2'),
      label('import-1', 'arm=v1'),
    ];
    expect(runs.map(r => [r.status, r.stdout])).toEqual([
      [0, 'arm=v2\nmodel=gpt 6\n'],
      [0, 'model=gpt 6\nset=explorer\n'],
      [2, ''],
      [2, ''],
      [0, 'arm=v1\n'],
    ]);
    const log = readFileSync(join(data, 'triage-1', 'labels.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(
      log.map(line => JSON.parse(line) as { key: string; value: string | null }).map(l => [l.key, l.value])
    ).toEqual([
      ['arm', 'v2'],
      ['model', 'gpt 6'],
      ['arm', null],
      ['set', 'explorer'],
    ]);
  });

  it('queues parked runs through the CLI and refreshes the sticky', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A task');
    const data = join(w.root, 'data');
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    const parked = {
      ...begin(graph.workflows.triage!, { id: 'triage-1', issue: 1, started: '2026-10-16T00:00:01.000Z' }),
      status: 'waiting' as const,
      retried: true as const,
      reason: `${stoppedByRunner} (SandboxError). Reply to try triage again.`,
    };
    await Effect.runPromise(Effect.flatMap(Store, store => store.put(parked)).pipe(Effect.provide(fileStore(data))));
    const flags = ['--dir', sandboxGraph, '--data', data, '--tracker', w.dir];
    const resumed = spawnSync(process.execPath, [runTs, 'resume', 'triage-1', ...flags], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('triage-1 triage running');
    expect(await w.tracker('show', '1')).toContain('Agentgraph status: working');
    const stored = await Effect.runPromise(
      Effect.flatMap(Store, store => store.get('triage-1')).pipe(Effect.provide(fileStore(data)))
    );
    expect(stored).toMatchObject({ status: 'running' });
    const empty = spawnSync(process.execPath, [runTs, 'resume', '--parked', ...flags], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toContain('0 runs parked');
    const invalid = spawnSync(process.execPath, [runTs, 'resume', 'triage-1', '--parked', ...flags], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('usage: agi resume');
  });

  it('dispatches with the router checks through the CLI without an App', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A task');
    const dispatched = spawnSync(
      process.execPath,
      [
        runTs,
        'dispatch',
        '1',
        '--dir',
        sandboxGraph,
        '--data',
        join(w.root, 'data'),
        '--tracker',
        w.dir,
        '--workflow',
        'triage',
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
    await expect(w.run([], 1, { kind: 'dispatch', issue: 1, workflow: 'nope' })).rejects.toThrow(
      'the graph has no workflow nope'
    );
    const stored = await Effect.runPromise(
      Effect.flatMap(Store, store => store.get(run!.id)).pipe(Effect.provide(fileStore(join(w.root, 'data'))))
    );
    expect(stored!.status).toBe('running');
  });

  it('dispatches a workflow without on: dispatch, asked the text given on the command line', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A task');
    const data = join(w.root, 'data');
    const dispatched = spawnSync(
      process.execPath,
      [
        runTs,
        'dispatch',
        '1',
        'what is left?',
        '--dir',
        sandboxGraph,
        '--data',
        data,
        '--tracker',
        w.dir,
        '--workflow',
        'router',
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }
    );
    expect(dispatched.status, dispatched.stderr).toBe(0);
    const [run] = await Effect.runPromise(
      Effect.flatMap(Store, store => store.list()).pipe(Effect.provide(fileStore(data)))
    );
    expect(run).toMatchObject({ workflow: 'router', status: 'running', by: 'cli', said: [{ issue: 1 }] });
    await w.run([[start('router'), reply({ kind: 'comment', body: 'Only tests.' })]], 1);
    const trace = readFileSync(join(data, run!.id, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(trace.find(t => t.prompt).prompt.prompt).toMatch(
      /^## What you were asked\n\n@cli: \/agent what is left\?\n/
    );
  });

  it('recovers a PR review command passed by the repo cursor with a per-issue sweep', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    await w.tracker('label', '1', 'agent:ready');
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
    await w.tracker('comment', '2', '/agent explain this line', '--line', 'hello.txt:1');
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              folderTracker(w.dir),
              fileStore(join(w.root, 'data')),
              hostSandbox(w.origin),
              replaySession([[start('router'), reply({ kind: 'comment', body: 'Here is why.' })]])
            )
          )
        )
      );
    await w.tracker('issue', 'Newer work');
    const [newer] = await w.run([], 3, { kind: 'dispatch', issue: 3, workflow: 'triage' });
    await run(
      Effect.flatMap(Store, store =>
        Effect.andThen(
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
    expect(await run(tick(graph, undefined, false, 30_000))).toEqual([]);
    const recovered = await run(scanIssuesAndRunningRuns(graph));
    expect(recovered.map(r => [r.workflow, r.status])).toEqual([['router', 'done']]);
    expect(await w.tracker('show', '2')).toContain('Here is why.');
  });

  it('seeds only the given commit with --at, so a later commit is not in the origin', async () => {
    const w = world();
    const base = git(w.seed, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(w.seed, 'fix.txt'), 'the fix\n');
    git(w.seed, 'add', '-A');
    git(w.seed, 'commit', '-q', '-m', 'fix');
    const later = git(w.seed, 'rev-parse', 'HEAD').trim();
    await w.tracker('init', w.seed, '--at', base);
    expect(git(w.origin, 'rev-parse', 'main').trim()).toBe(base);
    expect(spawnSync('git', ['--git-dir', w.origin, 'cat-file', '-e', later]).status).not.toBe(0);
  });
});

describe('an instance', () => {
  it('requires a graph before work and accepts the suggested example copy', async () => {
    const w = world();
    const root = join(w.root, 'agentgraph-data');
    writeFileSync(join(w.root, 'npm'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [runTs, ...args, '--data', root, '--provider', 'litellm'], {
        cwd: w.seed,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${w.root}${delimiter}${process.env.PATH}`,
          NODE_OPTIONS: '',
          AGENTGRAPH_CONFIG: '',
          AGENTGRAPH_APP_ENV: '',
          AGENTGRAPH_TRACKER: '',
          AGENTGRAPH_DIR: '',
          AGENTGRAPH_PROXY_KEYS: '',
          AGENTGRAPH_PROXY_KEYS_FILE: '',
        },
      });
    const commands = [['start', 'Fix a bug'], ['loop', '--once'], ['check'], ['show', 'graph'], ['studio']];
    const refused = commands.flatMap(args => [cli(...args), cli(...args, '--dir', join(w.seed, 'absent'))]);
    const message = refused[0]!.stderr.trim();
    const guidance = expect.stringMatching(/no graph found[\s\S]*copy an example/i);
    expect(refused.map(r => [r.status, r.stderr])).toEqual(refused.map(() => [1, guidance]));
    expect(message).toMatch(/^no graph found\. Copy an example into this folder first:\n  cp -R /);
    const i = await ensureInstance(root, w.seed);
    expect(readdirSync(i.tracker).filter(name => name.endsWith('.md'))).toEqual([]);
    expect(existsSync(join(w.seed, '.agentgraph'))).toBe(false);
    expect(cli('show').status).toBe(0);
    const copied = spawnSync('sh', ['-c', message.split('\n')[1]!.trim()], { cwd: w.seed, encoding: 'utf8' });
    expect(copied.status, copied.stderr).toBe(0);
    expect(cli('check').stdout.trim()).toBe('ok');
    const graph = join(i.repo, '.agentgraph');
    expect(await ensureGraph(i)).toBe(graph);
    expect(cli('show', 'graph').stdout).toContain(`graph ${graph}\n`);
    expect(readFileSync(join(graph, 'workflows', 'issue.md'), 'utf8')).toContain('wait: human');
  });

  it.each([
    ['no package', undefined, 0],
    ['no test script', {}, 0],
    ['passing tests', { test: 'exit 0' }, 0],
    ['failing tests', { test: 'exit 1' }, 1],
  ] as const)('runs the starter check with %s', async (_name, scripts, code) => {
    const dir = tmp('starter-check');
    const graph = await Effect.runPromise(loadGraph(join(import.meta.dirname, '..', 'examples', 'starter'), harnesses));
    if (scripts !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
    const checked = spawnSync('sh', ['-c', graph.checks.tests!.run!], { cwd: dir, encoding: 'utf8' });
    expect(checked.status, checked.stderr).toBe(code);
  });

  it('runs an issue to a merge on its own tracker, and writes to the repo only agentgraph refs', async () => {
    const w = world();
    git(w.seed, 'config', 'user.name', 'morgan');
    writeFileSync(join(w.seed, 'wip.txt'), 'unsaved\n');
    git(w.seed, 'remote', 'add', 'origin', 'https://example.invalid/seed.git');
    const looks = () =>
      ['status --porcelain', 'remote -v', 'rev-parse HEAD'].map(args => git(w.seed, ...args.split(' '))).join('\n');
    const before = looks();
    const root = join(w.root, 'agentgraph-data');
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [runTs, ...args, '--data', root], {
        cwd: w.seed,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '', AGENTGRAPH_TRACKER: '' },
      });
      return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
    };
    await expect(ensureInstance(join(w.seed, 'data'), w.seed)).rejects.toThrow('inside');
    const i = await ensureInstance(root, w.seed);
    expect(i).toMatchObject({ base: 'main', owner: 'morgan', made: true });
    expect((await ensureInstance(root, w.seed)).made).toBe(false);
    expect(await ensureBase(i)).toBeUndefined();
    expect(await ensureGraph(i, sandboxGraph)).toBe(sandboxGraph);
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    expect(
      await writeTriggeringIssue({ ...graph, trust: [i.owner] }, i.tracker, 'Add a greeting', i.owner, 'issue')
    ).toBe(1);
    const shownGraph = cli('show', 'graph', '--dir', sandboxGraph).out;
    expect(shownGraph).toContain(`graph ${sandboxGraph}`);
    expect(shownGraph).toContain('agents/reviewer.md');
    await writeLabels(i.tracker, i.owner, 1, ['urgent']);
    expect(readFileSync(join(i.tracker, '1.md'), 'utf8')).toContain('urgent');

    Object.assign(process.env, { AGENTGRAPH_TRACKER: i.tracker, AGENTGRAPH_TRUST: i.owner });
    const run = (turns: SessionEvent[][], issue: number | 'all' = 1) =>
      main({ graph: sandboxGraph, issue, data: i.data, marked: true, base: i.base }, s =>
        Layer.mergeAll(
          folderTracker(s.tracker as string, undefined, s.trust),
          fileStore(s.data),
          hostSandbox(join(s.tracker as string, 'origin.git')),
          replaySession(turns)
        )
      );
    const push = (message: string): Proposal => ({ kind: 'push', branch: 'agentgraph/1', message });
    const pull: Proposal = { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Add hello', body: '' };
    const first = await run([
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(first.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    const shown = cli('show');
    expect(shown.out).toContain('agi merge 1');
    expect(shown.out).toContain('#2 open Add hello (agentgraph/1 into main)');
    expect(cli('check', '--dir', sandboxGraph).out).toBe('ok');

    expect(await writePullToRepo(i, 1)).toMatchObject({ ref: 'agentgraph/1', base: 'main' });
    expect(git(w.seed, 'show', 'agentgraph/1:hello.txt')).toBe('hello');
    expect(looks()).toBe(before);

    await writeComment(i.tracker, i.owner, 1, 'say world', 'hello.txt:1');
    await writeReview(i.tracker, i.owner, 1, 'changes_requested', 'not quite');
    const second = await run([
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(second.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(await writePullToRepo(i, 1)).toMatchObject({ ref: 'agentgraph/1' });
    expect(git(w.seed, 'show', 'agentgraph/1:hello.txt')).toBe('hello world');

    git(w.seed, 'branch', '-f', 'agentgraph/1', 'main');
    expect(await writePullToRepo(i, 1)).toEqual({ why: 'agentgraph/1 in your repo moved since agentgraph wrote it' });
    const exported = cli('export', '1', '--as', 'agentgraph/review-1').out;
    expect(exported).toContain('In your repo: agentgraph/review-1');
    expect(exported).toMatch(/#1 is waiting\n[\s\S]*Next:\n  agi merge 1.*\n.*\n  agi show 1.*\n  agi studio/);
    const config = join(w.root, 'providers.mjs');
    writeFileSync(
      config,
      `export default { harnesses: [], providers: [
      { name: 'original', harnesses: [], ready: () => true, whyLogin: () => 'Renew the original account.' },
      { name: 'other', harnesses: [], ready: () => true, whyLogin: () => 'Renew the other account.' }
    ] };`
    );
    writeInstanceProvider(i, 'other');
    const traceDir = join(i.data, 'login-test');
    mkdirSync(traceDir);
    writeFileSync(
      join(traceDir, 'run.json'),
      JSON.stringify({
        ...first[0],
        id: 'login-test',
        step: 'implement',
        status: 'stopped',
        started: '9999-01-01',
        reason: 'login rejected',
      })
    );
    const trace = [
      {
        at: '1',
        step: 'implement',
        key: 's1',
        event: { type: 'start', session: 's1', harness: 'custom', provider: 'original', model: 'm', home: '/tmp' },
      },
      { at: '2', step: 'implement', key: 's1', session: { resumed: false, ended: 'login', usd: 0 } },
      {
        at: '3',
        step: 'implement',
        outcome: { kind: 'stop', why: 'login' },
        failure: 'login',
        run: { step: 'implement', status: 'stopped', tries: 0, rounds: {} },
      },
    ];
    const traceFile = join(traceDir, 'trace.jsonl');
    writeFileSync(traceFile, trace.map(t => JSON.stringify(t)).join('\n') + '\n');
    process.env.AGENTGRAPH_CONFIG = config;
    try {
      const recovery = cli('export', '1', '--as', 'agentgraph/review-1').out;
      expect(recovery).toContain('Renew the original account.');
      expect(recovery).not.toContain('Renew the other account.');
      writeFileSync(
        traceFile,
        [
          ...trace,
          {
            at: '4',
            step: 'implement',
            outcome: { kind: 'stop', why: 'other' },
            failure: 'provider',
            run: { step: 'implement', status: 'stopped', tries: 0, rounds: {} },
          },
        ]
          .map(t => JSON.stringify(t))
          .join('\n') + '\n'
      );
      expect(cli('export', '1', '--as', 'agentgraph/review-1').out).not.toContain('Renew the original account.');
    } finally {
      delete process.env.AGENTGRAPH_CONFIG;
      rmSync(traceDir, { recursive: true });
    }
    const patch = join(w.root, 'hello.patch');
    expect(cli('export', '1', '--patch', patch).code).toBe(0);
    expect(readFileSync(patch, 'utf8')).toContain('+hello world');

    const merged = cli('merge', '1', '--dir', sandboxGraph);
    expect(merged.out).toMatch(/^main at [0-9a-f]{7} in agentgraph/);
    expect(merged.out).toContain('not written to your repo: agentgraph/1 in your repo moved');
    expect(merged.out).not.toContain('Next:');
    expect(git(join(i.tracker, 'origin.git'), 'show', 'main:hello.txt')).toBe('hello world');
    expect(cli('show').out).toContain('#1 closed Add a greeting');
    expect(looks()).toBe(before);

    writeFileSync(join(w.seed, 'later.txt'), 'later\n');
    git(w.seed, 'add', 'later.txt');
    git(w.seed, 'commit', '-q', '-m', 'later');
    expect(await ensureBase(i)).toContain('moved both');
    git(w.seed, 'merge', '-q', '--no-edit', 'agentgraph/review-1');
    expect(await ensureBase(i)).toBeUndefined();
    expect(git(join(i.tracker, 'origin.git'), 'rev-parse', 'main')).toBe(git(w.seed, 'rev-parse', 'HEAD'));
  });

  it('reads .agentgraph from git, else from disk, and holds one loop per data dir', async () => {
    const w = world();
    git(w.seed, 'config', 'user.name', 'morgan');
    const i = await ensureInstance(join(w.root, 'agentgraph-data'), w.seed);
    await ensureBase(i);
    await expect(ensureGraph(i)).rejects.toThrow('Copy an example into this folder first:');
    cpSync(sandboxGraph, join(w.seed, '.agentgraph'), { recursive: true });
    const onDisk = join(i.repo, '.agentgraph');
    const readOnDisk = async () => {
      const graph = await ensureGraph(i);
      return [graph, await whyGraphUncommitted(i, graph), await formatGraphName(i, graph)];
    };
    expect(await readOnDisk()).toEqual([onDisk, undefined, 'graph .agentgraph/ (not in git)']);
    writeFileSync(join(w.seed, '.git', 'info', 'exclude'), '.agentgraph/\n');
    expect(git(w.seed, 'status', '--porcelain')).toBe('');
    expect(await readOnDisk()).toEqual([onDisk, undefined, 'graph .agentgraph/ (not in git)']);
    writeFileSync(join(w.seed, '.git', 'info', 'exclude'), '');
    git(w.seed, 'add', '.agentgraph');
    git(w.seed, 'commit', '-q', '-m', 'graph');
    await ensureBase(i);
    const graph = await ensureGraph(i);
    expect([await whyGraphUncommitted(i, graph), await formatGraphName(i, graph)]).toEqual([
      undefined,
      expect.stringMatching(/^\.agentgraph\/ at main [0-9a-f]{7,}$/),
    ]);
    writeFileSync(join(w.seed, '.agentgraph', 'settings.yaml'), 'repo: changed\n');
    expect(await whyGraphUncommitted(i, graph)).toContain('.agentgraph/ has uncommitted changes');
    git(w.seed, 'checkout', '-q', '--', '.agentgraph');
    expect(readFileSync(join(graph, 'settings.yaml'), 'utf8')).toBe(
      readFileSync(join(sandboxGraph, 'settings.yaml'), 'utf8')
    );
    expect(await ensureGraph(i, sandboxGraph)).toBe(sandboxGraph);
    symlinkSync('/etc/hosts', join(w.seed, '.agentgraph', 'agents', 'leak.md'));
    git(w.seed, 'add', '.agentgraph');
    git(w.seed, 'commit', '-q', '-m', 'link');
    await ensureBase(i);
    await expect(ensureGraph(i)).rejects.toThrow('.agentgraph holds links or submodules: agents/leak.md');

    const release = await createLoopLock(i.data);
    expect(await isLoopHeld(i.data)).toBe(true);
    await expect(createLoopLock(i.data)).rejects.toThrow();
    await release();
    expect(await isLoopHeld(i.data)).toBe(false);
  });
});

const BAD_FLAGS = [
  [{ AGENTGRAPH_EVERY: 'abc' }, ['show'], 'at ["AGENTGRAPH_EVERY"]'],
  [{ AGENTGRAPH_EVERY: '0' }, ['show'], 'at ["AGENTGRAPH_EVERY"]'],
  [{}, ['check', 'x', '--runs', '--issue', 'abc'], '--issue takes an issue number'],
  [{}, ['check', 'x', '--runs', '--issue', '0'], '--issue takes an issue number'],
  [{}, ['say', '1', 'hi', '--label', 'needs-review'], 'say does not run on --tracker'],
  [{}, ['say', '1', 'hi', '--run-label', 'arm=v2'], 'Unrecognized flag: --run-label in command agi say'],
  [{}, ['start', 'x', '--run-label', 'Arm=v2'], '["Arm"]'],
  [{}, ['start', 'x', '--run-label', 'arm-'], 'Expected string'],
] as const;

describe('the CLI flags', () => {
  it('rejects an explicit missing repo instead of showing all instances', () => {
    const dir = tmp('missing-repo');
    dirs.push(dir);
    const result = spawnSync(
      process.execPath,
      [runTs, 'show', '--repo', join(dir, 'missing'), '--data', join(dir, 'data')],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('runs inside a git repo');
  });

  it.each(['tracker', 'instance'])('prints the remaining heartbeat wait when a %s loop restarts', async kind => {
    const w = world();
    const root = join(w.root, 'loop-data');
    const data = kind === 'tracker' ? root : (await ensureInstance(root, w.seed)).data;
    const state = join(w.root, 'state');
    const heartbeat = join(state, 'owners', 'old-owner');
    mkdirSync(join(state, 'owners'), { recursive: true });
    writeFileSync(heartbeat, '');
    const at = new Date(Date.now() - 45_000);
    utimesSync(heartbeat, at, at);
    mkdirSync(join(data, '.locks'), { recursive: true });
    const dead = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: '' } });
    writeFileSync(join(data, '.locks', 'loop.lock'), `${dead.pid}:old-owner:lease`);
    const ran = spawnSync(
      process.execPath,
      [
        runTs,
        'loop',
        '--data',
        root,
        '--dir',
        sandboxGraph,
        ...(kind === 'tracker' ? ['--tracker', root] : ['--provider', 'litellm']),
      ],
      {
        cwd: w.seed,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          AGENTGRAPH_STATE: state,
          AGENTGRAPH_TRACKER: '',
          AGENTGRAPH_APP_ENV: '',
          AGENTGRAPH_PROXY_KEYS: 'implementor=test,reviewer=test',
          AGENTGRAPH_SANDBOX_URL: 'http://unused.invalid',
        },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    expect(ran.status, ran.stderr).toBe(1);
    expect(ran.stderr).toMatch(/^another loop holds this data dir, try again in (?:6[5-9]|7[0-5]) seconds\n$/);
  });

  it.each(BAD_FLAGS)('fails %o %o before it runs anything', (env, args, message) => {
    const root = tmp('cli-flags');
    dirs.push(root);
    const ran = spawnSync(
      process.execPath,
      [runTs, ...args, '--data', root, '--tracker', root, '--dir', sandboxGraph],
      {
        cwd: root,
        env: { ...process.env, NODE_OPTIONS: '', ...env },
        encoding: 'utf8',
      }
    );
    expect([ran.status, ran.stderr]).toEqual([2, expect.stringContaining(message)]);
  });

  it.each([
    [['--help'], 0],
    [[], 0],
    [['status'], 2],
  ] as const)('prints the usage for %o and makes no instance', (args, code) => {
    const repo = tmp('cli-usage');
    const data = tmp('cli-usage-data');
    dirs.push(repo, data);
    git(repo, 'init', '-q');
    const ran = spawnSync(process.execPath, [runTs, ...args, '--data', join(data, 'root')], {
      cwd: repo,
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8',
    });
    expect([ran.status, ran.stdout + ran.stderr, existsSync(join(data, 'root'))]).toEqual([
      code,
      expect.stringContaining('agi <subcommand> [flags]'),
      false,
    ]);
  });
});

describe('the tracker selection', () => {
  const cli = (env: Record<string, string>, ...args: string[]) => {
    const dir = tmp('selection');
    const r = spawnSync(process.execPath, [runTs, ...args, '--data', join(dir, 'data')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        AGENTGRAPH_CONFIG: '',
        AGENTGRAPH_DIR: '',
        AGENTGRAPH_TRACKER: '',
        AGENTGRAPH_APP_ENV: '',
        AGENTGRAPH_APP_ID: '',
        AGENTGRAPH_APP_KEY: '',
        AGENTGRAPH_APP_KEY_FILE: '',
        ...env,
      },
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };

  it('comes from AGENTGRAPH_TRACKER alone, and check says when it names nothing', () => {
    const checked = cli({ AGENTGRAPH_TRACKER: '__nope__' }, 'check', '--dir', sandboxGraph, '--provider', 'litellm');
    expect(checked.code).toBe(1);
    expect(checked.err).toMatch(/^tracker: no tracker plugin __nope__ and no folder /m);
  });

  it('keeps a folder AGENTGRAPH_TRACKER names over the App env, so show asks nothing of GitHub', () => {
    const shown = cli(
      { AGENTGRAPH_TRACKER: tmp('folder'), AGENTGRAPH_APP_ID: '1', AGENTGRAPH_APP_KEY: 'not a key' },
      'show',
      '--dir',
      sandboxGraph
    );
    expect([shown.code, shown.out, shown.err]).toEqual([0, 'Nothing needs you', '']);
  });
});
