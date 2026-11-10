import { Effect, Data } from 'effect';
import type { Graph } from '../folder.ts';
import { SandboxError } from '../sandbox.ts';
import { Store } from '../store.ts';
import { pickUsed } from '../trace.ts';
import { formatSqueezed } from '../context.ts';
import { writeCheckoutTree, readGit } from '../git.ts';
import { runShell } from './execute.ts';
import { type Checkout, type Run } from '../types.ts';

/** Runs the graph's setup in a checkout, so its checks find what it installs, and traces how long it took. */
export const runSetup = (graph: Graph, work: Checkout, run: Pick<Run, 'id' | 'step'>) =>
  Effect.gen(function* () {
    if (work.env)
      yield* Effect.flatMap(Store, s =>
        s.trace(run.id, { at: new Date().toISOString(), step: run.step, env: work.env! })
      );

    if (!graph.setup || work.ready) return;
    const started = Date.now();
    const out = yield* runShell(
      graph.setup,
      graph,
      work.dir,
      { AGENTGRAPH_BASE: work.base },
      graph.limits.minutes,
      'proxy'
    );
    const setup = { ms: Date.now() - started, exit: out.code, ...pickUsed(out) };
    yield* Effect.flatMap(Store, s => s.trace(run.id, { at: new Date().toISOString(), step: run.step, setup }));
    if (out.code !== 0)
      return yield* new SandboxError({
        reason: 'infra',
        detail: `setup exited ${out.code}: ${formatSqueezed(out.output)}`,
      });
  });

/** What the checkout changed since its base. */
export const readCheckoutDiff = (work: Checkout, ...args: string[]) =>
  Effect.flatMap(writeCheckoutTree(work), to =>
    readGit(work.git, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', ...args, work.base, to])
  );

/** The most items a fan-out takes when its check sets no `max`; a step fans out over at most this many. */
export const most = 20;

export class EachFailed extends Data.TaggedError('EachFailed')<{ detail: string }> {}

const lines = (text: string) => text.split('\n').filter(line => line.trim());

const splitHunks = (diff: string) =>
  diff
    .split(/^(?=diff --git )/m)
    .filter(Boolean)
    .flatMap(file => {
      const [head = '', ...hunks] = file.split(/^(?=@@ )/m);
      return hunks.map(hunk => `${head}${hunk}`.trimEnd());
    });

/** The items a fan-out runs over: changed files, diff hunks, hunks the base gained since `AGENTGRAPH_FROM`, or the lines a command prints. */
export const findFanOutItems = (
  each: string,
  graph: Graph,
  work: Checkout,
  minutes: number,
  env: Record<string, string> = { AGENTGRAPH_BASE: work.base }
) => {
  if (each === 'hunks') return Effect.map(readCheckoutDiff(work), splitHunks);
  if (each === 'merged')
    return env.AGENTGRAPH_FROM
      ? Effect.map(
          readGit(work.git, ['diff', '--no-color', '--no-ext-diff', '--text', env.AGENTGRAPH_FROM, work.base]),
          splitHunks
        )
      : Effect.succeed([]);
  if (each === 'files') return Effect.map(readCheckoutDiff(work, '--name-only'), lines);
  return Effect.flatMap(runShell(each, graph, work.dir, env, minutes), out =>
    out.code === 0 ? Effect.succeed(lines(out.output)) : Effect.fail(new EachFailed({ detail: out.output.trim() }))
  );
};
