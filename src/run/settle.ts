import { Effect, Stream, Result, Schedule } from 'effect';
import { type Run, type Workflow, isQuiet } from '../workflow.ts';
import { currentRunLinkRef, Tracker } from '../tracker.ts';
import { stoppedByRunner, proposeStatusUpdates } from '../context.ts';
import { type StoreError, Store } from '../store.ts';
import type { Graph } from '../folder.ts';
import type { Services } from './execute.ts';
import { runEndedChecks } from './evaluate.ts';
import { LockHeldError } from '../owner.ts';
import { readIssueWithPull } from './hear.ts';
import { type StatusChange, readPlugins } from '../plugin.ts';

/**
 * Files proposed issues in order. A part becomes a sub-issue of the run's issue with its size label and
 * its "Stacks on" and "Depends on" lines; the parts are listed on the issue and each XL part begins the workflow
 * again. A follow-up or a graph change becomes a plain issue labelled with its relation that names the run's issue and
 * starts nothing; one with the title of an open issue is added there as a comment. One refusal files none.
 */
/** Tracker writes made for `run` at its step by `session`; a mark set for the same run and step outside is kept. */
export const useRunLink =
  (run: Run, session = run.sessions[run.step]?.id) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.updateService(effect, currentRunLinkRef, outer =>
      outer?.run === run.id && outer.step === run.step
        ? outer
        : { run: run.id, step: run.step, ...(session && { session }) }
    );

export const isParked = (run: Run) =>
  run.status === 'waiting' && run.retried === true && run.reason?.startsWith(stoppedByRunner) === true;

export const readRunSpend = (id: string) =>
  Effect.flatMap(Store, store =>
    Effect.zipWith(
      Stream.runFold(
        store.read(id),
        () => 0,
        (sum, line) => sum + ('session' in line ? line.session.usd : 0)
      ),
      store.readChecks(id),
      (work, checks) => checks.reduce((sum, e) => sum + e.usd, work)
    )
  );

export const runEndChecks = (graph: Graph, id: string): Effect.Effect<Run | undefined, StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    if (Result.isFailure(yield* Effect.result(store.lock(id)))) return;
    const ended = yield* store.get(id);
    if (!ended?.owed?.length) return ended;
    let run = ended;
    yield* runEndedChecks(graph, ended, ended.owed, {
      settled: name => {
        const { owed: before = [], ...rest } = run;
        const left = before.filter(n => n !== name);
        run = { ...rest, ...(left.length > 0 && { owed: left }) };
        return store.put(run);
      },
    });
    const w = graph.workflows[run.workflow];
    return w ? yield* writeStatus(w, run, graph) : run;
  }).pipe(Effect.scoped);

export const writeStatus = (w: Workflow, run: Run, graph: Graph): Effect.Effect<Run, StoreError, Tracker | Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store
      .lock(`status-${run.issue}`)
      .pipe(Effect.retry({ while: e => e.cause instanceof LockHeldError, schedule: Schedule.spaced('50 millis') }));
    const tracker = yield* Tracker;
    const t = yield* readIssueWithPull(w, run);
    const usd = yield* readRunSpend(run.id);
    const others = yield* Effect.forEach(
      (yield* store.list({ issue: run.issue })).filter(r => r.id !== run.id),
      r =>
        Effect.gen(function* () {
          const workflow = graph.workflows[r.workflow];
          return { run: r, t: workflow ? yield* readIssueWithPull(workflow, r) : t, usd: yield* readRunSpend(r.id) };
        })
    );
    const { to, from, proposals } = proposeStatusUpdates(run, t, tracker.studio, usd, others, isQuiet(w));
    const shown =
      !to || graph.status === false || !tracker.status
        ? true
        : yield* tracker.status(run.issue, to, graph.status).pipe(
            Effect.as(true),
            Effect.catchTag('TrackerError', e => Effect.as(Effect.logWarning(`status of issue ${run.issue}`, e), false))
          );
    const status = yield* Effect.forEach(
      shown ? proposals : proposeStatusUpdates(run, t, tracker.studio, usd, others, true).proposals,
      p => tracker.apply(run.issue, p)
    );
    if (to && shown) yield* announce(graph, { issue: run.issue, repo: graph.repo, to, ...(from && { from }) });
    const reply = status.find(a => a.proposal.kind === 'comment');
    const undone = reply?.ok && run.eyes ? [yield* tracker.apply(run.eyes.issue, run.eyes.undo)] : [];
    yield* Effect.flatMap(Store, s =>
      s.trace(
        run.id,
        ...[...status, ...undone].map(a => ({
          at: new Date().toISOString(),
          step: run.step,
          applied: a,
        }))
      )
    );
    if (!reply && shown === !run.unshown) return run;
    const { comment, eyes, unshown: _unshown, ...rest } = run;
    const next = {
      ...rest,
      ...(eyes && !undone.length && { eyes }),
      ...(reply ? reply.ok && reply.id && { comment: reply.id } : comment && { comment }),
      ...(!shown && { unshown: true as const }),
    };
    yield* store.put(next);
    return next;
  }).pipe(
    Effect.scoped,
    useRunLink(run),
    Effect.catchTag('TrackerError', e => Effect.as(Effect.logWarning(`status of run ${run.id}`, e), run))
  );

const announce = (graph: Graph, change: StatusChange) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const { moveToColumn } = tracker;
    const { hooks } = yield* Effect.tryPromise(() => readPlugins(graph.dir, graph.plugins));
    for (const hook of hooks)
      yield* Effect.tryPromise(async () =>
        hook.status(change, {
          repo: graph.repo,
          settings: hook.settings,
          tracker: {
            searchIssues: (...args) => Effect.runPromise(tracker.searchIssues(...args)),
            ...(moveToColumn && { moveToColumn: (issue, column) => Effect.runPromise(moveToColumn(issue, column)) }),
          },
        })
      ).pipe(Effect.catch(e => Effect.logWarning(`status hook of plugin ${hook.plugin}`, e)));
  }).pipe(Effect.catch(e => Effect.logWarning('status hooks', e)));

export const writeMovedStatus = (w: Workflow, asked: Run, moved: Run, graph: Graph) => {
  const { reason, retried: _retried, ...rest } = moved;
  return writeStatus(w, isParked(asked) && reason === asked.reason ? rest : moved, graph);
};

/** The run with no review thread left to answer: what it says next goes to the top of where a human last spoke. */
export const removeThreads = (run: Run): Run =>
  run.said ? { ...run, said: run.said.slice(0, 1).map(s => ({ issue: s.issue })) } : run;
