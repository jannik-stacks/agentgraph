import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { findIssueNumbers, folderTracker, Tracker, runLocked, writeIssueFile } from '../src/tracker.ts';
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
  writeLineComment,
  writeReview,
  formatGraphName,
  whyGraphUncommitted,
  writeInstanceProvider,
} from '../src/instance.ts';
import { scanIssuesAndRunningRuns, tick } from '../src/run/trigger.ts';
import { stoppedByEngine } from '../src/context.ts';
import { begin } from '../src/workflow.ts';
import { loadGraph } from '../src/folder.ts';
import { fileStore, Store } from '../src/store.ts';
import { start as main, writeTriggeringIssue } from '../src/main.ts';
import { createLoopLock, findLoopLock, readLoopHolder } from '../src/owner.ts';
import type { SessionEvent } from '../src/types.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, reply, start, wrote } from './fixtures.ts';
import type { Services } from '../src/run/execute.ts';
import { findStatus, git, issuePath, tmp, writeIssueAt } from './kit.ts';

import { dirs, makeTrackerWorld as world } from './tracker-cli-fixtures.ts';
const runTs = join(import.meta.dirname, '..', 'bin', 'run.ts');
const sandboxGraph = join(import.meta.dirname, '..', 'examples', 'sandbox');
const holdLock = async (dir: string) => {
  const held = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const holder = runLocked(dir, () => (held.resolve(), gate.promise));
  await held.promise;
  return () => (gate.resolve(), holder);
};

describe('the human verbs on a tracker folder', () => {
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
    const trace = readFileSync(join(w.data, run!.id, 'trace.jsonl'), 'utf8')
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
    await writeIssueFile(dir, { title: 'Race', author: 'a', labels: [] }, '');
    const writer = `import { writeTimelineEvent } from ${JSON.stringify(trackerTs)};
const comment = i => ({ issue: 1, kind: 'comment', actor: 'a', trusted: true, comment: { body: String(i) } });
await Promise.all(Array.from({ length: 50 }, (_, i) => writeTimelineEvent(process.argv[1], comment(i))));`;
    const write = () =>
      new Promise<number | null>(done =>
        spawn('node', ['--input-type=module', '-e', writer, dir], { stdio: 'inherit' }).on('close', done)
      );
    expect(await Promise.all([write(), write()])).toEqual([0, 0]);
    const ids = readFileSync(issuePath(dir, 1, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { comment: { id: string } }).comment.id);
    expect(new Set(ids).size).toBe(100);
  });

  it('holds a CLI write until the tracker lock is free', async () => {
    const dir = tmp('tracker-lock');
    dirs.push(dir);
    const n = await writeIssueFile(dir, { title: 'Lock', author: 'morgan', labels: [] }, '');
    const state = () => readFileSync(issuePath(dir, n), 'utf8').match(/state: (\w+)/)?.[1];
    const free = await holdLock(dir);
    const closing = writeClosed(dir, 'morgan', n);
    await new Promise(done => setTimeout(done, 700));
    expect(state()).toBe('open');
    await free();
    await closing;
    expect(state()).toBe('closed');
  });

  it('makes a callback resumed after its lock was released wait for the next holder', async () => {
    const dir = tmp('tracker-lock-late');
    dirs.push(dir);
    const gate = Promise.withResolvers<void>();
    const entered: string[] = [];
    let late: Promise<void> | undefined;
    await runLocked(dir, async () => {
      late = gate.promise.then(() => runLocked(dir, async () => void entered.push('late')));
    });
    const free = await holdLock(dir);
    gate.resolve();
    await new Promise(done => setTimeout(done, 700));
    entered.push('freed');
    await free();
    await late;
    const nested = await runLocked(dir, () => runLocked(dir, async () => 'nested'));
    const thrown = await runLocked(dir, () => Promise.reject(new Error('boom'))).catch((e: Error) => e.message);
    expect({ entered, nested, thrown, after: await runLocked(dir, async () => 'free') }).toEqual({
      entered: ['freed', 'late'],
      nested: 'nested',
      thrown: 'boom',
      after: 'free',
    });
  });

  it('moves the base only once it holds the tracker lock for the whole merge', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Fix it');
    writeFileSync(join(w.seed, 'fix.txt'), 'fixed\n');
    git(w.seed, 'add', 'fix.txt');
    git(w.seed, 'commit', '-qm', 'fix');
    git(w.seed, 'push', '-q', w.origin, 'HEAD:refs/heads/agentgraph/1');
    const head = git(w.seed, 'rev-parse', 'HEAD');
    const pr = await writeIssueFile(w.dir, { title: 'Fix it', author: 'agentgraph[bot]', labels: [] }, '');
    writeIssueAt(issuePath(w.dir, pr, 'pull.json'), JSON.stringify({ branch: 'agentgraph/1', base: 'main', head }));
    const base = () => git(w.root, '--git-dir', w.origin, 'rev-parse', 'refs/heads/main');
    const before = base();
    const free = await holdLock(w.dir);
    const merging = mergePull({ tracker: w.dir, owner: 'morgan', data: w.data }, pr);
    await new Promise(done => setTimeout(done, 700));
    expect(base()).toBe(before);
    await free();
    expect(await merging).toMatchObject({ base: 'main', head });
    expect(base()).toBe(head);
  });

  it('merges the pull request a run on the issue opened and closes that issue, whatever digits its branch ends in', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Fix it');
    await w.tracker('issue', 'Other');
    git(w.seed, 'commit', '-q', '--allow-empty', '-m', 'fix');
    git(w.seed, 'push', '-q', w.origin, 'HEAD:refs/heads/agentgraph/1-2');
    const head = git(w.seed, 'rev-parse', 'HEAD');
    const pr = await writeIssueFile(w.dir, { title: 'Fix it', author: 'agentgraph[bot]', labels: [] }, '');
    writeIssueAt(issuePath(w.dir, pr, 'pull.json'), JSON.stringify({ branch: 'agentgraph/1-2', base: 'main', head }));
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    const run = begin(graph.workflows.issue!, { id: 'issue-1', issue: 1, started: '2026-10-16T00:00:01.000Z' });
    await Effect.runPromise(
      Effect.flatMap(Store, s => s.put({ ...run, checkout: { branch: 'agentgraph/1-2', base: 'main' } })).pipe(
        Effect.provide(fileStore(w.data))
      )
    );
    expect(await mergePull({ tracker: w.dir, owner: 'morgan', data: w.data }, 1)).toMatchObject({ head });
    const states = [1, 2].map(n => /state: (\w+)/.exec(readFileSync(issuePath(w.dir, n), 'utf8'))?.[1]);
    expect(states).toEqual(['closed', 'open']);
  });

  it('waits for another process moving an issue, for both a comment and a scan', async () => {
    const dir = tmp('tracker-lock-process');
    dirs.push(dir);
    const n = await writeIssueFile(dir, { title: 'Race', author: 'morgan', labels: [] }, '');
    await writeComment(dir, 'morgan', n, 'first');
    const tracker = JSON.stringify(join(import.meta.dirname, '..', 'src', 'tracker.ts'));
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runLocked } from ${tracker};
const dir = process.argv[1];
await runLocked(dir, async () => {
  renameSync(join(dir, '${n}'), join(dir, '.moving'));
  const events = readFileSync(join(dir, '.moving', 'events.jsonl'), 'utf8');
  console.log('held');
  await new Promise(done => setTimeout(done, 1500));
  writeFileSync(join(dir, '.moving', 'events.jsonl'), events);
  mkdirSync(join(dir, 'working'));
  renameSync(join(dir, '.moving'), join(dir, 'working', '${n}'));
});`,
        dir,
      ],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );
    const exited = new Promise(done => child.on('exit', done));
    await new Promise<void>(held => child.stdout.on('data', () => held()));
    const [listed] = await Promise.all([
      Effect.runPromise(Effect.flatMap(Tracker, f => f.issues()).pipe(Effect.provide(folderTracker(dir)))),
      writeComment(dir, 'morgan', n, 'second'),
    ]);
    expect(await exited).toBe(0);
    expect({
      listed: listed.map(t => t.number),
      status: findStatus(dir, n),
      top: existsSync(join(dir, String(n))),
      events: readFileSync(join(dir, 'working', String(n), 'events.jsonl'), 'utf8').includes('second'),
    }).toEqual({ listed: [n], status: 'working', top: false, events: true });
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
    await Effect.runPromise(Effect.flatMap(Store, store => store.put(running)).pipe(Effect.provide(fileStore(w.data))));
    const lock = join(w.data, '.locks', `${running.id}.lock`);
    writeFileSync(lock, String(process.pid));
    expect(await w.run([], issue)).toEqual([running]);
    const dead = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: '' } });
    writeFileSync(lock, String(dead.pid));
    const [recovered] = await w.run([[start('recovered'), reply({ kind: 'comment', body: 'Recovered.' })]], issue);
    expect(recovered).toMatchObject({ id: running.id, status: 'done' });
    expect(existsSync(lock)).toBe(false);
    const trace = readFileSync(join(w.data, running.id, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(trace.filter(t => t.prompt).at(-1).prompt.prompt).toContain('Remember the original request');
  });

  it('sets, removes and prints run labels through the CLI', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    const data = w.data;
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    const run = begin(graph.workflows.triage!, { id: 'triage-1', issue: 1, started: '2026-10-16T00:00:01.000Z' });
    const { issue: _issue, ...imported } = { ...run, id: 'import-1' };
    await Effect.runPromise(
      Effect.flatMap(Store, store => Effect.andThen(store.put(run), store.put(imported))).pipe(
        Effect.provide(fileStore(data))
      )
    );
    const label = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [runTs, 'label', ...args, '--repo', w.seed, '--data', join(w.root, 'instances'), '--tracker', w.dir],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '' },
        }
      );
    const runs = [
      label('triage-1', 'arm=v2', 'model=gpt 6'),
      label('triage-1', 'arm-', 'set=explorer'),
      label('triage-1', 'Bad=1'),
      label('missing-1', 'arm=v2'),
      label('import-1', 'arm=v1'),
      spawnSync(process.execPath, [runTs, 'label', join(data, 'import-1'), 'exclude=flaky docker'], {
        encoding: 'utf8',
        cwd: w.root,
        env: { ...process.env, NODE_OPTIONS: '' },
      }),
    ];
    expect(runs.map(r => [r.status, r.stdout])).toEqual([
      [0, 'arm=v2\nmodel=gpt 6\n'],
      [0, 'model=gpt 6\nset=explorer\n'],
      [2, ''],
      [2, ''],
      [0, 'arm=v1\n'],
      [0, 'arm=v1\nexclude=flaky docker\n'],
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

  it('queues parked runs through the CLI and shows them working', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A task');
    const data = w.data;
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    const parked = {
      ...begin(graph.workflows.triage!, { id: 'triage-1', issue: 1, started: '2026-10-16T00:00:01.000Z' }),
      status: 'waiting' as const,
      retried: true as const,
      reason: `${stoppedByEngine} (SandboxError). Reply to try triage again.`,
    };
    await Effect.runPromise(Effect.flatMap(Store, store => store.put(parked)).pipe(Effect.provide(fileStore(data))));
    const flags = ['--dir', sandboxGraph, '--repo', w.seed, '--data', join(w.root, 'instances'), '--tracker', w.dir];
    const env = {
      ...process.env,
      NODE_OPTIONS: '',
      AGENTGRAPH_PROVIDER: 'litellm',
      AGENTGRAPH_PROXY_KEYS: '*=test',
      AGENTGRAPH_RUNNER: 'box',
      AGENTGRAPH_SANDBOX_URL: 'http://unused',
    };
    const resumed = spawnSync(process.execPath, [runTs, 'resume', 'triage-1', ...flags], {
      encoding: 'utf8',
      env,
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('triage-1 triage running');
    expect(findStatus(w.dir, 1)).toBe('working');
    const stored = await Effect.runPromise(
      Effect.flatMap(Store, store => store.get('triage-1')).pipe(Effect.provide(fileStore(data)))
    );
    expect(stored).toMatchObject({ status: 'running' });
    const empty = spawnSync(process.execPath, [runTs, 'resume', '--parked', ...flags], {
      encoding: 'utf8',
      env,
    });
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toContain('0 runs parked');
    const invalid = spawnSync(process.execPath, [runTs, 'resume', 'triage-1', '--parked', ...flags], {
      encoding: 'utf8',
      env,
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
        '--repo',
        w.seed,
        '--data',
        join(w.root, 'instances'),
        '--tracker',
        w.dir,
        '--workflow',
        'triage',
        '--step',
        'triage',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          AGENTGRAPH_PROVIDER: 'litellm',
          AGENTGRAPH_PROXY_KEYS: '*=test',
          AGENTGRAPH_RUNNER: 'box',
          AGENTGRAPH_SANDBOX_URL: 'http://unused',
        },
      }
    );
    expect(dispatched.status, dispatched.stderr).toBe(0);
    const [run] = await Effect.runPromise(
      Effect.flatMap(Store, store => store.list()).pipe(Effect.provide(fileStore(w.data)))
    );
    expect(run).toMatchObject({ workflow: 'triage', status: 'running', by: 'cli' });
    await expect(w.run([], 1, { kind: 'dispatch', issue: 1, workflow: 'triage' })).rejects.toThrow(
      'a live run holds #1'
    );
    await expect(w.run([], 1, { kind: 'dispatch', issue: 1, workflow: 'nope' })).rejects.toThrow(
      'the graph has no workflow nope'
    );
    const stored = await Effect.runPromise(
      Effect.flatMap(Store, store => store.get(run!.id)).pipe(Effect.provide(fileStore(w.data)))
    );
    expect(stored!.status).toBe('running');
  });

  it('dispatches a workflow without on: dispatch, asked the text given on the command line', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'A task');
    const data = w.data;
    const dispatched = spawnSync(
      process.execPath,
      [
        runTs,
        'dispatch',
        '1',
        'what is left?',
        '--dir',
        sandboxGraph,
        '--repo',
        w.seed,
        '--data',
        join(w.root, 'instances'),
        '--tracker',
        w.dir,
        '--workflow',
        'router',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          AGENTGRAPH_PROVIDER: 'litellm',
          AGENTGRAPH_PROXY_KEYS: '*=test',
          AGENTGRAPH_RUNNER: 'box',
          AGENTGRAPH_SANDBOX_URL: 'http://unused',
        },
      }
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
              fileStore(w.data),
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
    const i = await ensureInstance(root, 'seed', w.seed);
    expect(findIssueNumbers(i.tracker)).toEqual([]);
    expect(existsSync(join(w.seed, '.agentgraph'))).toBe(false);
    expect(cli('show').status).toBe(0);
    const copied = spawnSync('sh', ['-c', message.split('\n')[1]!.trim()], { cwd: w.seed, encoding: 'utf8' });
    expect(copied.status, copied.stderr).toBe(0);
    expect(cli('check').stdout.trim()).toBe('ok');
    const graph = join(i.checkout, '.agentgraph');
    expect(await ensureGraph(i)).toBe(graph);
    expect(cli('show', 'graph').stdout).toContain(`graph ${graph}\n`);
    expect(readFileSync(join(graph, 'workflows', 'issue.md'), 'utf8')).toContain('wait: human');
  });

  it('names a missing tracker folder in the CLI and the studio instead of crashing', async () => {
    const w = world();
    const root = join(w.root, 'agentgraph-data');
    const i = await ensureInstance(root, 'seed', w.seed);
    renameSync(i.tracker, join(i.dir, 'forge'));
    const env = { ...process.env, NODE_OPTIONS: '', AGENTGRAPH_CONFIG: '', AGENTGRAPH_TRACKER: '', AGENTGRAPH_DIR: '' };
    const studio = join(import.meta.dirname, '..', 'studio', 'dev.ts');
    const ran = [
      [runTs, 'show', '--data', root],
      [studio, '--repo', w.seed, '--data', root],
    ].map(args =>
      spawnSync(process.execPath, args, { cwd: w.seed, encoding: 'utf8', env, timeout: 20_000, killSignal: 'SIGKILL' })
    );
    expect(ran.map(r => [r.status, r.stderr.trim()])).toEqual(
      ran.map(() => [
        2,
        `the tracker folder ${i.tracker} has no origin.git; restore it, or move ${i.dir} aside to start anew`,
      ])
    );
  });

  it('shows stored data without discovering the saved tracker and preserves its name when saving the provider', async () => {
    const w = world();
    const root = join(w.root, 'agentgraph-data');
    const i = await ensureInstance(root, 'seed', w.seed);
    const graph = join(w.seed, '.agentgraph');
    cpSync(join(import.meta.dirname, '..', 'examples', 'starter'), graph, { recursive: true });
    const trackerTs = JSON.stringify(join(import.meta.dirname, '..', 'src', 'tracker.ts'));
    mkdirSync(join(graph, 'plugins'));
    writeFileSync(
      join(graph, 'plugins', 'mine.ts'),
      `import { writeFileSync } from 'node:fs';
import { folder } from ${trackerTs};
export default { name: 'mine', tracker: host => (writeFileSync(host.dir + '.picked', ''), folder.tracker(host)) };`
    );
    const file = join(i.dir, 'instance.yaml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}tracker: mine\n`);
    writeInstanceProvider(i, 'other');
    expect(readFileSync(file, 'utf8')).toMatch(/^tracker: mine$/m);
    await writeIssueFile(i.tracker, { title: 'Mine', author: 'morgan', labels: [] }, '');
    const shown = spawnSync(process.execPath, [runTs, 'show', '--data', root], {
      cwd: w.seed,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', AGENTGRAPH_TRACKER: '', AGENTGRAPH_DIR: '', AGENTGRAPH_APP_ENV: '' },
    });
    expect([shown.status, shown.stderr]).toEqual([0, '']);
    expect(existsSync(`${i.tracker}.picked`)).toBe(false);
  });

  it('refuses an instance tracker that keeps its issues outside the instance folder', async () => {
    const w = world();
    const root = join(w.root, 'agentgraph-data');
    const i = await ensureInstance(root, 'seed', w.seed);
    const graph = join(w.seed, '.agentgraph');
    cpSync(join(import.meta.dirname, '..', 'examples', 'starter'), graph, { recursive: true });
    mkdirSync(join(graph, 'plugins'));
    writeFileSync(
      join(graph, 'plugins', 'moved.ts'),
      `import { folder } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'tracker.ts'))};
export default { name: 'moved', tracker: host => folder.tracker({ ...host, dir: host.dir + '/issues' }) };`
    );
    const file = join(i.dir, 'instance.yaml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}tracker: moved\n`);
    const env = {
      ...process.env,
      NODE_OPTIONS: '',
      AGENTGRAPH_TRACKER: '',
      AGENTGRAPH_DIR: '',
      AGENTGRAPH_APP_ENV: '',
    };
    const runs = [
      ['loop', '--once'],
      ['start', 'Fix it'],
      ['close', '1'],
    ].map(args =>
      spawnSync(process.execPath, [runTs, ...args, '--data', root], { cwd: w.seed, encoding: 'utf8', env })
    );
    const why = `tracker moved keeps its issues outside ${i.tracker}`;
    expect(runs.map(r => [r.status, r.stderr.includes(why)])).toEqual(runs.map(() => [1, true]));
    expect(findIssueNumbers(i.tracker)).toEqual([]);
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
    await expect(ensureInstance(join(w.seed, 'data'), 'seed', w.seed)).rejects.toThrow('inside');
    const i = await ensureInstance(root, 'seed', w.seed);
    expect(i).toMatchObject({ base: 'main', owner: 'morgan', made: true });
    expect((await ensureInstance(root, 'seed', w.seed)).made).toBe(false);
    expect(await ensureBase(i)).toBeUndefined();
    expect(await ensureGraph(i, sandboxGraph)).toBe(sandboxGraph);
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    expect(
      await writeTriggeringIssue(
        { ...graph, trust: [i.owner] },
        folderTracker(i.tracker, i.owner),
        'Add a greeting',
        i.owner,
        'issue'
      )
    ).toBe(1);
    const shownGraph = cli('show', 'graph', '--dir', sandboxGraph).out;
    expect(shownGraph).toContain(`graph ${sandboxGraph}`);
    expect(shownGraph).toContain('agents/reviewer.md');
    await writeLabels(i.tracker, i.owner, 1, ['urgent']);
    expect(readFileSync(issuePath(i.tracker, 1), 'utf8')).toContain('urgent');

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

    await writeLineComment(i, 1, 'say world', 'hello.txt:1');
    await writeReview(i, 1, 'changes_requested', 'not quite');
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
    const i = await ensureInstance(join(w.root, 'agentgraph-data'), 'seed', w.seed);
    await ensureBase(i);
    await expect(ensureGraph(i)).rejects.toThrow('Copy an example into this folder first:');
    cpSync(sandboxGraph, join(w.seed, '.agentgraph'), { recursive: true });
    const onDisk = join(i.checkout, '.agentgraph');
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

    vi.stubEnv('AGENTGRAPH_STATE', tmp('state'));
    const lock = await createLoopLock(i.checkout);
    expect(readLoopHolder(i.checkout)?.pid).toBe(process.pid);
    await expect(createLoopLock(i.checkout)).rejects.toThrow();
    await lock.release();
    expect(readLoopHolder(i.checkout)).toBe(undefined);
    vi.unstubAllEnvs();
  });
});

const BAD_FLAGS = [
  [{ AGENTGRAPH_EVERY: 'abc' }, ['show'], 'at ["AGENTGRAPH_EVERY"]'],
  [{ AGENTGRAPH_EVERY: '0' }, ['show'], 'at ["AGENTGRAPH_EVERY"]'],
  [{}, ['check', 'x', '--runs', '--issue', 'abc'], '--issue takes an issue number'],
  [{}, ['check', 'x', '--runs', '--issue', '0'], '--issue takes an issue number'],
  [{}, ['say', '1', 'hi', '--label', 'needs-review'], 'runs inside a git repo'],
  [{}, ['say', '1', 'hi', '--run-label', 'arm=v2'], 'Unrecognized flag: --run-label in command agi say'],
  [{}, ['start', 'x', '--run-label', 'Arm=v2'], '["Arm"]'],
  [{}, ['start', 'x', '--run-label', 'arm-'], 'Expected string'],
] as const;

describe('the CLI flags', () => {
  it.each([
    ['instance', 'SIGTERM'],
    ['instance', 'SIGINT'],
    ['tracker', 'SIGTERM'],
    ['tracker', 'SIGINT'],
  ] as const)('releases the %s loop lock before exiting on %s', async (kind, signal) => {
    const w = world();
    const root = join(w.root, 'loop-data');
    const { checkout } = await ensureInstance(root, 'seed', w.seed);
    vi.stubEnv('AGENTGRAPH_STATE', join(w.root, 'state'));
    if (kind === 'tracker') await w.tracker('init', w.seed);
    const child = spawn(
      process.execPath,
      [
        runTs,
        'loop',
        '--data',
        root,
        '--dir',
        sandboxGraph,
        '--provider',
        'litellm',
        ...(kind === 'tracker' ? ['--tracker', w.dir] : []),
      ],
      {
        cwd: w.seed,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          AGENTGRAPH_STATE: join(w.root, 'state'),
          AGENTGRAPH_TRACKER: '',
          AGENTGRAPH_APP_ENV: '',
          AGENTGRAPH_PROXY_KEYS: 'implementor=test,reviewer=test',
          AGENTGRAPH_RUNNER: 'box',
          AGENTGRAPH_SANDBOX_URL: 'http://unused.invalid',
        },
      }
    );
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    try {
      await expect.poll(() => output, { timeout: 10_000 }).toContain('under a temp dir');
      expect(existsSync(findLoopLock(checkout))).toBe(true);
      child.kill(signal);
      expect(await exited).toBe(signal === 'SIGTERM' ? 143 : 0);
      expect(existsSync(findLoopLock(checkout))).toBe(false);
      const lock = await createLoopLock(checkout);
      await lock.release();
      await lock.release();
    } finally {
      child.kill('SIGKILL');
      await exited;
      vi.unstubAllEnvs();
    }
  });

  it('rejects an explicit missing repo instead of showing all instances', () => {
    const dir = tmp('missing-repo');
    dirs.push(dir);
    const result = spawnSync(
      process.execPath,
      [runTs, 'show', '--repo', join(dir, 'missing'), '--data', join(dir, 'data')],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--repo must name a readable git repo');
  });

  it.each(['tracker', 'instance'])('refuses a %s loop while another host holds the checkout', async kind => {
    const w = world();
    const root = join(w.root, 'loop-data');
    const instance = await ensureInstance(root, 'seed', w.seed);
    const state = join(w.root, 'state');
    mkdirSync(join(state, 'owners'), { recursive: true });
    writeFileSync(join(state, 'owners', 'other-owner'), '');
    vi.stubEnv('AGENTGRAPH_STATE', state);
    const path = findLoopLock(instance.checkout);
    vi.unstubAllEnvs();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '4242:other-owner:elsewhere:lease');
    const ran = spawnSync(
      process.execPath,
      [
        runTs,
        'loop',
        '--data',
        root,
        '--dir',
        sandboxGraph,
        ...(kind === 'tracker' ? ['--tracker', 'folder', '--provider', 'litellm'] : ['--provider', 'litellm']),
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
          AGENTGRAPH_RUNNER: 'box',
          AGENTGRAPH_SANDBOX_URL: 'http://unused.invalid',
        },
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    expect([ran.status, ran.stderr]).toEqual([
      1,
      `pid 4242 on elsewhere already loops on ${instance.checkout}; agi stop --instance seed --data ${root}, or agi restart --instance seed --data ${root}\n`,
    ]);
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

  it('checks the graph against the runner --runner names', () => {
    const checked = cli({}, 'check', '--dir', sandboxGraph, '--provider', 'litellm', '--runner', 'nope');
    expect(checked.code).toBe(1);
    expect(checked.err).toMatch(/^runner: no runner plugin nope; runners: local, box/m);
  });

  it('keeps a folder AGENTGRAPH_TRACKER names over the App env, so show asks nothing of GitHub', () => {
    const w = world();
    const folder = tmp('folder');
    git(folder, 'init', '-q', '--bare', 'origin.git');
    const shown = cli(
      { AGENTGRAPH_TRACKER: folder, AGENTGRAPH_APP_ID: '1', AGENTGRAPH_APP_KEY: 'not a key' },
      'show',
      '--repo',
      w.seed,
      '--dir',
      sandboxGraph
    );
    expect([shown.code, shown.out, shown.err]).toEqual([0, 'Nothing needs you', '']);
  });
});
