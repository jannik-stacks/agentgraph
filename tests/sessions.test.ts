import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duration, Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { Session } from '../src/session.ts';
import { fileStore } from '../src/store.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { makeTestGraph, result, start, stop } from './fixtures.ts';
import type { SessionSpec } from '../src/types.ts';
import { git } from './kit.ts';
import { runStepChecks } from '../src/run/check.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Three runs gate one check that judges each of ten items, against a harness that counts its live sessions. */
const findPeakSessions = async (sessions: number) => {
  const root = mkdtempSync(join(tmpdir(), 'agentgraph-sessions-'));
  dirs.push(root);
  const work = join(root, 'work');
  mkdirSync(work);
  mkdirSync(join(root, 'news'));
  git(work, 'init', '-q');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
  const graph = makeTestGraph('graph', { review: { agent: 'reviewer', each: 'seq 10' } });
  const small = { ...graph, dir: root, limits: { ...graph.limits, sessions } };
  const step = small.workflows.issue!.steps.find(s => s.checks.includes('review'))!;
  let live = 0;
  let peak = 0;
  let opened = 0;
  const counting = Layer.succeed(Session, {
    open: () =>
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.sync(() => {
            opened++;
            peak = Math.max(peak, ++live);
          }),
          () => Effect.sync(() => void live--)
        ).pipe(
          Effect.as(
            Stream.fromEffect(Effect.as(Effect.sleep(Duration.millis(10)), result({ pass: true, why: 'fine' }))).pipe(
              Stream.concat(Stream.make(stop))
            )
          )
        )
      ),
  });
  const layer = Layer.mergeAll(fileStore(join(root, 'data')), hostSandbox(join(root, 'origin.git')), counting);
  const left = (run: string) => ({
    run,
    issue: 7,
    context: '',
    reply: '',
    dir: work,
    base: 'HEAD',
    git: { GIT_DIR: join(work, '.git'), GIT_WORK_TREE: work },
    news: join(root, 'news', 'news.md'),
    proposals: [],
  });
  await Effect.runPromise(
    Effect.forEach(['a', 'b', 'c'], run => runStepChecks(step, left(run), small), { concurrency: 'unbounded' }).pipe(
      Effect.provide(layer)
    )
  );
  return { peak, opened, live };
};

describe('limits.sessions', () => {
  it('caps live sessions across runs and each items at the limit', async () => {
    expect(await findPeakSessions(4)).toEqual({ peak: 4, opened: 30, live: 0 });
  });

  it('finishes with a single permit', async () => {
    expect(await findPeakSessions(1)).toEqual({ peak: 1, opened: 30, live: 0 });
  });
});

describe('a judge in the same session', () => {
  it('judges items one after another as turns of one session, and resumes it on the next try saying the change may have moved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentgraph-sessions-'));
    dirs.push(root);
    const work = join(root, 'work');
    mkdirSync(work);
    mkdirSync(join(root, 'news'));
    git(work, 'init', '-q');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
    const graph = makeTestGraph('graph', { review: { agent: 'reviewer', each: 'seq 3' } });
    const reviewer = { ...graph.agents.reviewer!, session: 'same' as const };
    const small = { ...graph, dir: root, agents: { ...graph.agents, reviewer } };
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('review'))!;
    const specs: SessionSpec[] = [];
    const recording = Layer.succeed(Session, {
      open: spec => {
        specs.push(spec);
        return Stream.make(start(spec.resume?.id ?? 'j'), result({ pass: true, why: 'fine' }), stop);
      },
    });
    const layer = Layer.mergeAll(fileStore(join(root, 'data')), hostSandbox(join(root, 'origin.git')), recording);
    const left = {
      run: 'a',
      issue: 7,
      context: '',
      reply: '',
      dir: work,
      base: 'HEAD',
      git: { GIT_DIR: join(work, '.git'), GIT_WORK_TREE: work },
      news: join(root, 'news', 'news.md'),
      proposals: [],
    };
    const first = await Effect.runPromise(runStepChecks(step, left, small).pipe(Effect.provide(layer)));
    expect(first.judges).toEqual({ review: { id: 'j', home: '/homes/j', harness: 'opencode' } });
    await Effect.runPromise(
      runStepChecks(
        step,
        { ...left, moved: { from: 'HEAD', text: 'The base gained a fix.' }, judges: first.judges },
        small
      ).pipe(Effect.provide(layer))
    );
    expect(specs.map(s => s.resume?.id)).toEqual([undefined, 'j', 'j', 'j', 'j', 'j']);
    expect(specs.map(s => s.prompt.split('\n')[0]!.startsWith('The change may have moved'))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
  });
});
