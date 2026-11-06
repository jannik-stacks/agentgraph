import { randomUUID } from 'node:crypto';
import { Effect, Stream, Schedule } from 'effect';
import { type Run, type Workflow, isQuiet } from '../workflow.ts';
import { currentRunLinkRef, Tracker, type TrackerError } from '../tracker.ts';
import { stoppedByRunner, findIssueStatus, proposeUpdates } from '../context.ts';
import { type StoreError, Store } from '../store.ts';
import type { Graph } from '../folder.ts';
import { LockHeldError } from '../owner.ts';
import { type StatusChange, readPlugins } from '../plugin.ts';
import type { Proposal } from '../proposal.ts';
import { getSha } from '../hash.ts';
import type { Applied } from '../event.ts';
import type { Checkout } from '../sandbox.ts';
import type { Services } from './execute.ts';
import { runEndedChecks } from './evaluate.ts';
import { readIssueWithPull } from './hear.ts';

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
    if (!(yield* Effect.isSuccess(store.lock(id)))) return;
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

const showStatus = (w: Workflow, run: Run, graph: Graph) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const tracker = yield* Tracker;
    const before = yield* store.get(run.id);
    const t = yield* readIssueWithPull(w, run);
    const pulled = (t.pull ?? t.issue.pull) !== undefined;
    const others = (yield* store.list({ issue: run.issue })).filter(r => {
      const of = graph.workflows[r.workflow];
      return r.id !== run.id && of !== undefined && !isQuiet(of);
    });
    const from = findIssueStatus(run.unshown || !before ? others : [...others, before], pulled);
    const to = findIssueStatus([...others, run], pulled)!;
    const shown =
      to === from || graph.status === false || !tracker.status
        ? true
        : yield* tracker.status(run.issue, to, graph.status).pipe(
            Effect.as(true),
            Effect.catchTag('TrackerError', e => Effect.as(Effect.logWarning(`status of issue ${run.issue}`, e), false))
          );
    if (to !== from && shown) yield* announce(graph, { issue: run.issue, repo: graph.repo, to, ...(from && { from }) });
    const said = yield* Effect.forEach(
      proposeUpdates(before, run, t, [...others, run], w.branch !== undefined, tracker.studio),
      p => tracker.apply((t.pull ?? t.issue).number, p)
    );
    yield* writeAppliedTrace(run.id, run.step, said);
    return shown;
  });

export const writeStatus = (w: Workflow, run: Run, graph: Graph): Effect.Effect<Run, StoreError, Tracker | Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store
      .lock(`status-${run.issue}`)
      .pipe(Effect.retry({ while: e => e.cause instanceof LockHeldError, schedule: Schedule.spaced('50 millis') }));
    const tracker = yield* Tracker;
    const undone = run.eyes && run.status !== 'running' ? [yield* tracker.apply(run.eyes.issue, run.eyes.undo)] : [];
    yield* writeAppliedTrace(run.id, run.step, undone);
    const shown = isQuiet(w) || (yield* showStatus(w, run, graph));
    if (undone.length === 0 && shown === !run.unshown) return run;
    const { eyes, unshown: _unshown, ...rest } = run;
    const next = {
      ...rest,
      ...(eyes && !undone.some(a => a.ok) && { eyes }),
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
    const { writeField } = tracker;
    const { hooks } = yield* Effect.tryPromise(() => readPlugins(graph.dir, graph.plugins));
    for (const hook of hooks)
      yield* Effect.tryPromise(async () =>
        hook.status(change, {
          repo: graph.repo,
          settings: hook.settings,
          tracker: {
            searchIssues: (...args) => Effect.runPromise(tracker.searchIssues(...args)),
            ...(writeField && { writeField: (issue, field) => Effect.runPromise(writeField(issue, field)) }),
          },
        })
      ).pipe(Effect.catch(e => Effect.logWarning(`status hook of plugin ${hook.plugin}`, e)));
  }).pipe(Effect.catch(e => Effect.logWarning('status hooks', e)));

export const writeMovedStatus = (w: Workflow, asked: Run, moved: Run, graph: Graph) => {
  const { reason, retried: _retried, ...rest } = moved;
  return writeStatus(w, isParked(asked) && reason === asked.reason ? rest : moved, graph);
};

export const writeAppliedTrace = (id: string, step: string, applied: Applied[]) =>
  Effect.flatMap(Store, store =>
    store.trace(id, ...applied.filter(a => !a.operation).map(a => ({ at: new Date().toISOString(), step, applied: a })))
  );

/** The run with no review thread left to answer: what it says next goes to the top of where a human last spoke. */
export const removeThreads = (run: Run): Run =>
  run.said ? { ...run, said: run.said.slice(0, 1).map(s => ({ issue: s.issue })) } : run;

export const getOperationKey = (run: Run, issue: number, proposal: Proposal, slot: string, tree?: string) =>
  getSha(
    JSON.stringify([
      run.id,
      run.step,
      run.tries,
      run.rounds,
      issue,
      slot,
      Object.entries(proposal).toSorted(([a], [b]) => a.localeCompare(b)),
      tree,
    ])
  );

const writeApplied = (run: Run, issue: number, key: string, applied: Applied) =>
  Effect.flatMap(Store, store => {
    const recorded = { ...applied, operation: key, issue };
    return Effect.as(
      store.trace(run.id, { at: new Date().toISOString(), step: run.step, applied: recorded }),
      recorded
    );
  });

export const findAppliedBefore = (run: Run, issue: number, key: string, proposal?: Proposal) =>
  Effect.gen(function* () {
    const lines = yield* Stream.runCollect((yield* Store).read(run.id));
    const traced = lines.findLast(t => 'applied' in t && t.applied.operation === key && t.applied.ok);
    if (traced && 'applied' in traced) return traced.applied;
    const posted = proposal && (yield* (yield* Tracker).findPost(issue, proposal, key));
    return posted && (yield* writeApplied(run, issue, key, posted));
  });

export const writeOnce = (
  run: Run,
  issue: number,
  key: string,
  write: Effect.Effect<Applied, TrackerError | StoreError, Tracker | Store>,
  proposal?: Proposal
) =>
  Effect.gen(function* () {
    const before = yield* findAppliedBefore(run, issue, key, proposal);
    if (before) return before;
    const marked = Effect.updateService(write, currentRunLinkRef, link => link && { ...link, operation: key });
    return yield* writeApplied(run, issue, key, yield* marked);
  });

const unpushed = 'The push with this reply failed, so its changes are not on the pull request yet.';

/**
 * Applies the accepted proposals after a pass, pushes first. A comment with no thread of its own goes once to a place in
 * `run.said` that no comment here answers, the top level before the newest thread, else to where a human last spoke,
 * else to `to`.
 */
export const writeProposals = (
  run: Run,
  proposals: Proposal[],
  to?: number,
  checkout?: { work: Checkout; tree: string }
): Effect.Effect<Applied[], TrackerError | StoreError, Tracker | Store> =>
  Effect.flatMap(Tracker, tracker =>
    Effect.gen(function* () {
      const threads = new Set(proposals.flatMap(p => (p.kind === 'comment' && p.under !== undefined ? [p.under] : [])));
      const open = (run.said ?? []).filter(s => s.under === undefined || !threads.has(s.under));
      const places = open.length > 0 ? open : [{ issue: run.said?.[0]?.issue ?? to ?? run.issue }];
      const place = places.find(s => s.under === undefined) ?? places.at(-1)!;
      const sent = proposals
        .toSorted((a, b) => Number(b.kind === 'push') - Number(a.kind === 'push'))
        .flatMap((p): [number, Proposal][] =>
          p.kind !== 'comment'
            ? [[run.issue, p]]
            : p.under !== undefined
              ? [[run.said?.find(s => s.under === p.under)?.issue ?? to ?? run.issue, p]]
              : [[place.issue, { ...p, ...(place.under !== undefined && { under: place.under }) }]]
        );
      const applied: Applied[] = [];
      let refused = false;
      let thrown: TrackerError | undefined;
      for (const [i, [issue, proposed]] of sent.entries()) {
        if (refused && !(proposed.kind === 'comment' && proposed.under !== undefined)) {
          applied.push({ proposal: proposed, ok: false, reason: 'push failed; not applied' });
          continue;
        }
        const p =
          refused && proposed.kind === 'comment' ? { ...proposed, body: `${proposed.body}\n\n${unpushed}` } : proposed;
        const write = writeOnce(
          run,
          issue,
          checkout
            ? getOperationKey(run, issue, proposed, `land:${i}`, p.kind === 'push' ? checkout.tree : undefined)
            : randomUUID(),
          tracker.apply(issue, p, checkout?.work),
          checkout && p
        );
        const a =
          p.kind === 'push'
            ? yield* Effect.catchTag(write, 'TrackerError', e => {
                thrown = e;
                return Effect.succeed<Applied>({ proposal: p, ok: false, reason: e.message });
              })
            : yield* write;
        applied.push(a);
        if (p.kind === 'push' && !a.ok) refused = true;
      }
      if (thrown) return yield* thrown;
      return applied;
    })
  ).pipe(useRunLink(run));
