import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duration, Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { gate } from '../src/engine.ts';
import { Session } from '../src/session.ts';
import { fileStore } from '../src/store.ts';
import { hubOf } from './fixtures.ts';
import { git } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Three runs gate one check that judges each of ten items, against a harness that counts its live sessions. */
const peakOf = async (sessions: number) => {
  const root = mkdtempSync(join(tmpdir(), 'agentgraph-sessions-'));
  dirs.push(root);
  const work = join(root, 'work');
  mkdirSync(work);
  mkdirSync(join(root, 'news'));
  git(work, 'init', '-q');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
  const hub = hubOf('hub', { review: { agent: 'reviewer', each: 'seq 10' } });
  const small = { ...hub, dir: root, limits: { ...hub.limits, sessions } };
  const step = small.workflows.issue!.steps.find(s => s.checks.includes('review'))!;
  let live = 0;
  let peak = 0;
  let opened = 0;
  const counting = Layer.succeed(Session, {
    open: () =>
      Stream.acquireRelease(
        Effect.sync(() => {
          opened++;
          peak = Math.max(peak, ++live);
        }),
        () => Effect.sync(() => void live--)
      ).pipe(
        Stream.flatMap(() =>
          Stream.fromEffect(
            Effect.sleep(Duration.millis(10)).pipe(
              Effect.as({ type: 'end', final: 'PASS', ended: 'stop', exit: 0 } as const)
            )
          )
        )
      ),
  });
  const layer = Layer.mergeAll(fileStore(join(root, 'data')), host(join(root, 'origin.git')), counting);
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
    Effect.forEach(['a', 'b', 'c'], run => gate(step, left(run), small), { concurrency: 'unbounded' }).pipe(
      Effect.provide(layer)
    )
  );
  return { peak, opened, live };
};

describe('limits.sessions', () => {
  it('caps live sessions across runs and each items at the limit', async () => {
    expect(await peakOf(4)).toEqual({ peak: 4, opened: 30, live: 0 });
  });

  it('finishes with a single permit', async () => {
    expect(await peakOf(1)).toEqual({ peak: 1, opened: 30, live: 0 });
  });
});
