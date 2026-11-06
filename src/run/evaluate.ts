import { Effect, Stream } from 'effect';
import type { Check, Graph } from '../folder.ts';
import type { RunRecord } from '../workflow.ts';
import { type SandboxError, Sandbox } from '../sandbox.ts';
import { writeCheckoutTree, readGit } from '../git.ts';
import { type StoreError, Store } from '../store.ts';
import type { SessionStop } from '../trace.ts';
import type { TrackerError } from '../tracker.ts';
import { runSetup } from './checkout.ts';
import { type Left, writeCheckFiles, runOneCheck } from './check.ts';
import { formatFailure } from './execute.ts';

const caught = <A, R>(e: Effect.Effect<A, SandboxError | SessionStop | TrackerError | StoreError, R>) =>
  Effect.catch(e, err => (err._tag === 'StoreError' ? Effect.fail(err) : Effect.succeed(formatFailure(err))));

const whyNotApplicable = (check: Check, run: RunRecord, traced: boolean) =>
  check.reads === 'traces'
    ? traced
      ? undefined
      : 'the run has no trace'
    : run.startCommit === undefined
      ? 'the run kept no change'
      : undefined;

const reopen = (graph: Graph, run: RunRecord, traces: boolean, reply: string) =>
  Effect.gen(function* () {
    const made = yield* Effect.flatMap(Sandbox, s =>
      s.checkout(traces ? undefined : `refs/agentgraph/runs/${run.id}`, undefined, undefined, graph)
    );
    const work = { ...made, base: run.startCommit ?? made.base };
    if (!traces) yield* runSetup(graph, work, run);
    const ready = traces ? '' : yield* writeCheckoutTree(work);
    const left: Left = {
      ...work,
      run: run.id,
      ...(run.issue !== undefined && { issue: run.issue }),
      context: [run.title, run.body].filter(Boolean).join('\n\n'),
      reply,
      proposals: [],
      ...(run.answers && { answers: run.answers }),
    };
    yield* writeCheckFiles(graph, left, true);
    const restore = traces
      ? Effect.void
      : Effect.andThen(readGit(work.git, ['read-tree', '-u', '--reset', ready]), readGit(work.git, ['clean', '-fdq']));
    return { left, restore };
  });

export const runEndedChecks = (
  graph: Graph,
  run: RunRecord,
  names: string[],
  o: { later?: true; settled?: (name: string) => Effect.Effect<unknown, StoreError, Store> } = {}
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const lines = yield* Stream.runCollect(store.read(run.id));
    const reply = lines.flatMap(t => ('event' in t && t.event.type === 'end' ? [t.event.final] : [])).at(-1) ?? '';
    const opened = {
      traces: yield* Effect.cached(caught(reopen(graph, run, true, reply))),
      files: yield* Effect.cached(caught(reopen(graph, run, false, reply))),
    };
    const traced = lines.some(t => 'session' in t);
    for (const name of names) {
      const check = graph.checks[name];
      const na = check && whyNotApplicable(check, run, traced);
      const got = !check
        ? `the graph has no check ${name}`
        : (na ??
          (yield* Effect.flatMap(opened[check.reads === 'traces' ? 'traces' : 'files'], open =>
            typeof open === 'string'
              ? Effect.succeed(open)
              : caught(
                  Effect.andThen(
                    open.restore,
                    runOneCheck(
                      run.step,
                      { ...check, mode: check.mode === 'info' ? 'info' : 'warn' },
                      open.left,
                      graph,
                      o.later
                    )
                  )
                )
          )));
      if (typeof got === 'string')
        yield* store.addChecks(run.id, {
          at: new Date().toISOString(),
          step: run.step,
          check: { check: name, pass: false, empty: true, ...(na && { na: true as const }), findings: got, ms: 0 },
          version: check?.version ?? '',
          usd: 0,
          ...(o.later && { later: o.later }),
        });
      if (o.settled) yield* o.settled(name);
    }
  });

export const runLaterChecks = (graph: Graph, id: string, names: string[]) =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (!(yield* Effect.isSuccess(store.lock(id)))) return;
    const run = yield* store.getRecord(id);
    if (!run?.ended) return;
    const after = (yield* store.readChecks(id)).filter(e => e.at >= run.ended! && !e.item);
    const due = names.filter(
      name => !after.some(e => e.check.check === name && e.version === graph.checks[name]?.version)
    );
    if (due.length === 0) return;
    yield* runEndedChecks(graph, run, due, { later: true });
    return run;
  }).pipe(Effect.scoped);
