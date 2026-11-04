import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Deferred, Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { Graph } from '../src/folder.ts';
import { Sandbox } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore } from '../src/store.ts';
import { makeTestGraph, reply, result, start, stop } from './fixtures.ts';
import { git, tmp } from './kit.ts';
import { fresh, readChecks, removeAfter, services, world } from './world.ts';
import { runStepChecks } from '../src/run/check.ts';
import { runWorkflow } from '../src/run/drive.ts';

const measureChecks = async (sessions: number, judged = false) => {
  const root = tmp('check-gate');
  removeAfter(root);
  const work = join(root, 'work');
  mkdirSync(work);
  mkdirSync(join(root, 'news'));
  git(work, 'init', '-q');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = makeTestGraph('graph');
  const graph = {
    ...base,
    checks: Object.fromEntries(
      ['first', 'second', 'third', 'fourth', 'fifth'].map(name => [
        name,
        {
          name,
          path: `${name}.md`,
          body: '',
          version: 'fixture',
          mode: 'block' as const,
          run: name,
          ...(judged && { agent: 'reviewer' }),
        },
      ])
    ),
  };
  let live = 0;
  let peak = 0;
  let scripts = 0;
  let judges = 0;
  const full = Effect.runSync(Deferred.make<void>());
  const occupy = Effect.acquireRelease(
    Effect.sync(() => {
      peak = Math.max(peak, ++live);
    }),
    () => Effect.sync(() => void live--)
  ).pipe(
    Effect.andThen(
      Effect.suspend(() => (live >= Math.min(sessions, 5) ? Deferred.succeed(full, undefined) : Effect.void))
    ),
    Effect.andThen(Deferred.await(full))
  );
  const sandbox = Layer.succeed(Sandbox, {
    readHead: () => Effect.die('unexpected readHead'),
    removeBranch: () => Effect.die('unexpected cleanup'),
    checkout: () => Effect.die('unexpected checkout'),
    lines: () => Stream.die('unexpected lines'),
    exec: command =>
      Effect.gen(function* () {
        yield* occupy;
        scripts++;
        const name = command.args[1]!;
        return { code: !judged && name === 'second' ? 1 : 0, output: `${name} finding` };
      }),
  });
  const session = Layer.succeed(Session, {
    open: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* occupy;
          judges++;
          return Stream.make(result({ pass: true, why: 'reviewed' }), stop);
        })
      ),
  });
  const layer = Layer.mergeAll(sandbox, session, fileStore(join(root, 'data')));
  const outcomes = await Effect.runPromise(
    Effect.forEach(
      [
        ['first', 'second', 'third'],
        ['fourth', 'fifth'],
      ],
      (checks, index) => {
        const run = `run-${index}`;
        const small = { ...graph, repo: `repo-${index}`, limits: { ...graph.limits, sessions } };
        return runStepChecks(
          { name: 'implement', does: { agent: 'implementor' }, tries: 1, checks },
          {
            run,
            issue: index,
            context: '',
            reply: '',
            proposals: [],
            dir: work,
            base: 'HEAD',
            git: { GIT_DIR: join(work, '.git'), GIT_WORK_TREE: work },
            news: join(root, 'news', `${run}.md`),
          },
          small
        );
      },
      { concurrency: 'unbounded' }
    ).pipe(Effect.provide(layer))
  );
  const findings = ['run-0', 'run-1']
    .flatMap(run =>
      readChecks(join(root, 'data'), run).map(entry => ({
        check: entry.check.check,
        pass: entry.check.pass,
        findings: entry.check.findings,
        exit: entry.exit,
      }))
    )
    .toSorted((a, b) => a.check.localeCompare(b.check));
  return {
    peak,
    live,
    scripts,
    judges,
    findings,
    outcomes: outcomes.map(({ outcome }) => ({
      outcome: {
        ...outcome,
        ...(outcome.kind === 'failed' && {
          checks: outcome.checks.map(({ ms: _ms, ...check }) => check),
        }),
      },
    })),
  };
};

it('caps checks across runs and repositories without changing results or deadlocking sessions and judges', async () => {
  const unrestricted = await measureChecks(100);
  const bounded = await measureChecks(2);
  expect(unrestricted.peak).toBe(5);
  expect(bounded).toEqual({ ...unrestricted, peak: 2 });
  expect(bounded.scripts).toBe(5);
  expect(bounded.live).toBe(0);

  const measured = await measureChecks(1, true);
  expect(measured).toMatchObject({ peak: 1, live: 0, scripts: 5, judges: 5 });
  expect(measured.outcomes).toEqual([{ outcome: { kind: 'pass' } }, { outcome: { kind: 'pass' } }]);

  const where = world();
  const base = makeTestGraph('graph', {
    types: { run: 'printf checked' },
    review: { run: 'printf context', agent: 'reviewer' },
  });
  const graph: Graph = {
    ...base,
    limits: { ...base.limits, sessions: 1 },
    agents: { ...base.agents, implementor: { ...base.agents.implementor!, returns: ['comment'] } },
  };
  const { run, specs } = services(where, [
    [start('implementor'), reply({ kind: 'comment', body: 'Checked.' })],
    [result({ pass: true }), stop],
  ]);
  const ended = await run(runWorkflow(graph.workflows.issue!, { ...fresh(), step: 'implement' }, graph));
  expect(ended).toMatchObject({ status: 'done' });
  expect(specs.map(spec => spec.agent)).toEqual(['implementor', 'reviewer']);
  expect(
    readChecks(where.data, 'run-7')
      .map(entry => entry.check.check)
      .toSorted()
  ).toEqual(['review', 'types']);
});
