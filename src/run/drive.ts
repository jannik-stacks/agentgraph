import { Effect, Result, Option } from 'effect';
import { type Workflow, type Run, type Outcome, transition, isRunDone } from '../workflow.ts';
import type { Issue } from '../event.ts';
import type { Graph } from '../folder.ts';
import { type StoreError, Store } from '../store.ts';
import { type TrackerError, Tracker } from '../tracker.ts';
import { type SessionStop, makeOutcomeLine } from '../trace.ts';
import { stoppedByRunner } from '../context.ts';
import { Sandbox, SandboxError, formatCause } from '../sandbox.ts';
import { ensureGraphRef, readGit, writeCheckoutTree, gitIdentity, commitCheckout } from '../git.ts';
import { findPullNumber, formatTemplate, readIssueWithPull, readHeardOutcome, readContinuedRun } from './hear.ts';
import { type Services, formatFailure } from './execute.ts';
import { formatWaitingOn } from './start.ts';
import { writeAppliedTrace, writeProposals, removeThreads, writeStatus, readRunSpend, runEndChecks } from './settle.ts';
import { moveCheckoutOnto } from './follow.ts';
import { runSetup } from './checkout.ts';
import { runAttempt } from './attempt.ts';

/** The open pull request a run on `issue` stacks on, from a "Stacks on #n" line naming it or its issue. */
const findStackBase = (w: Workflow, issue: Issue, open: Issue[]): Run['base'] => {
  const n = Number(/^\s*stacks on #(\d+)\s*$/im.exec(issue.body)?.[1]);
  const on = open.find(t => t.number === n);
  const pull = on?.pull ? on : open.find(t => t.number === findPullNumber(w, n, open));
  return (
    pull?.pull && {
      pull: pull.number,
      branch: pull.pull.branch,
      sha: pull.pull.head,
    }
  );
};

const rejected = 'the model provider rejected the key or login. Fix it, then start a new run.';

/**
 * Hears what was said while the run waited, runs the graph's setup, tries until the run stops running, then runs the end
 * checks it left owed. A runner error is retried once, then parks the run at its step, so an
 * answer tries that step again with the feedback it had. Files are kept under `refs/agentgraph/runs/<run id>`.
 */
export const runWorkflow = (w: Workflow, run: Run, graph: Graph): Effect.Effect<Run, StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const tracker = yield* Tracker;
    let current = run;
    const settle = (outcome: Outcome, next: Run, failure?: SessionStop['reason']) =>
      Effect.gen(function* () {
        yield* store.trace(next.id, makeOutcomeLine(current.step, outcome, next, failure));
        const child = (yield* store.list()).some(r => r.by === next.id && next.reason === formatWaitingOn(r));
        if (next.status === 'waiting' && next.reason && !next.reason.startsWith(stoppedByRunner) && !child) {
          const body = outcome.kind === 'failed' ? 'How should I proceed?' : next.reason;
          const said = yield* Effect.result(writeProposals(removeThreads(next), [{ kind: 'comment', body }]));
          if (Result.isSuccess(said)) yield* writeAppliedTrace(next.id, next.step, said.success);
        }
        current = yield* writeStatus(w, next, graph);
        yield* store.put(current);
      });
    const hear = (all: boolean) =>
      Effect.gen(function* () {
        const t = yield* Effect.option(readIssueWithPull(w, current));
        const queued = Option.isSome(t) ? yield* readHeardOutcome(graph, w, current, t.value) : undefined;
        if (queued && (all || queued.outcome.kind !== 'answer' || w.concurrency === 'cancel'))
          yield* settle(
            queued.outcome,
            yield* readContinuedRun({ ...transition(w, current, queued.outcome), seen: queued.at }, queued.events)
          );
      });
    const walk = Effect.gen(function* () {
      const base = w.base ?? (yield* tracker.base);
      const issue = yield* tracker.issue(run.issue);
      current = yield* writeStatus(
        w,
        {
          ...current,
          title: issue.title,
          body: issue.body,
          graph: graph.sha,
        },
        graph
      );
      yield* store.put(current);
      const stacked =
        graph.stacks && !current.base && findStackBase(w, issue, yield* tracker.issues({ state: 'open' }));
      if (stacked) yield* store.put((current = { ...current, base: stacked }));
      const named = w.branch && formatTemplate(w.branch, issue);
      const old = named && named.replace(/^agentgraph\//, 'bothub/');
      const own =
        old && old !== named && (yield* tracker.issues({ state: 'open' })).some(t => t.pull?.branch === old)
          ? old
          : named;
      const ref =
        (own && issue.pull?.branch === own && issue.pull.base) ||
        ((issue.state === 'open' ? issue.pull?.branch : undefined) ??
          current.base?.branch ??
          formatTemplate(base, issue));
      yield* store.put((current = { ...current, checkout: { base: ref, ...(own && { branch: own }) } }));
      const made = yield* Effect.flatMap(Sandbox, s => s.checkout(ref, own, `refs/agentgraph/runs/${run.id}`, graph));
      if (current.graphTree === undefined)
        yield* store.put((current = { ...current, graphTree: yield* ensureGraphRef(made.git, graph.dir) }));
      if (own && made.saved) {
        const message = yield* readGit(made.git, ['log', '-1', '--format=%B', made.saved]);
        const from =
          /^baseline ([0-9a-f]{40,64})$/m.exec(message)?.[1] ??
          (yield* readGit(made.git, ['rev-parse', `${made.saved}^`]));
        const onto = made.head ?? made.base;
        const tree = yield* writeCheckoutTree(made);
        if (from !== onto && tree !== (yield* readGit(made.git, ['rev-parse', `${onto}^{tree}`]))) {
          const head = yield* readGit(made.git, [...gitIdentity, 'commit-tree', tree, '-p', from, '-m', 'Saved work']);
          const applied = yield* tracker.apply(run.issue, { kind: 'rebase', branch: own, from, onto, head }, made);
          yield* store.trace(run.id, { at: new Date().toISOString(), step: current.step, applied });
          if (!applied.ok)
            current = {
              ...current,
              feedback: [
                current.feedback,
                `${own} moved: ${applied.reason}.`,
                'Resolve each conflict so both sides keep working, remove every marker, and push.',
              ]
                .filter(Boolean)
                .join('\n\n'),
            };
        }
      }

      const onto = current.onto?.sha ?? (made.saved && !made.head ? current.base?.sha : undefined);
      const work = onto ? yield* moveCheckoutOnto(made, onto, !current.onto || current.tries === 0) : made;
      current = { ...current, startCommit: work.base };

      if (!w.on.feedback) yield* runSetup(graph, work, current);
      const attempts = `refs/agentgraph/attempts/${run.id}/`;
      let count = (yield* readGit(work.git, ['rev-parse', `--glob=${attempts}*`])).split('\n').filter(Boolean).length;
      while (current.status === 'running') {
        const tried = yield* runAttempt({ ...w, base }, current, graph, work, own);
        yield* commitCheckout({ ...work, ...(tried.tree && { tree: tried.tree }) }, `${attempts}${++count}`, '', [
          work.head ?? work.base,
          work.saved,
          work.published,
        ]);
        if ('failure' in tried) {
          current = tried.run;
          return yield* tried.failure;
        }
        if (
          tried.outcome.kind === 'failed' &&
          tried.outcome.proposals.some(a => !a.ok && a.proposal.kind === 'push' && a.moved)
        ) {
          current = tried.run;
          yield* store.put(current);
          return;
        }

        yield* settle(tried.outcome, transition(w, tried.run, tried.outcome));
        const usd = current.status === 'running' ? yield* readRunSpend(current.id) : 0;
        if (usd > graph.limits.usdPerRun) {
          const why = `Spent $${usd.toFixed(2)}, over the graph's usd-per-run of ${graph.limits.usdPerRun}.`;
          yield* settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why }));
        }
        if (!isRunDone(current)) yield* hear(true);
      }
      const files = made.written && (yield* Effect.promise(made.written));
      if (files !== undefined)
        yield* store.trace(run.id, { at: new Date().toISOString(), step: current.step, cache: { files } });
    });
    const halt = (e: SandboxError | SessionStop | TrackerError) => {
      const why = formatFailure(e);
      const said = `${stoppedByRunner}.`;
      if (e._tag === 'SessionStop' && e.reason === 'human')
        return settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why: 'Stopped by a person.' }));
      if (e._tag === 'SessionStop' && e.reason === 'login')
        return settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why: rejected }), 'login');
      const host = e._tag === 'SandboxError' && e.reason === 'host';
      if (!current.retried && !host) return settle({ kind: 'ask', question: why }, { ...current, retried: true });
      return settle(
        { kind: 'ask', question: why },
        { ...removeThreads(current), status: 'waiting', reason: said, retried: true }
      );
    };
    yield* store.lock(run.id);
    current = (yield* store.get(run.id)) ?? run;
    if (current.status !== 'running') return { run: current, drove: false };
    yield* hear(false);
    while (current.status === 'running')
      yield* walk.pipe(
        Effect.catchDefect(defect =>
          Effect.andThen(
            Effect.logError(`run ${current.id}`, defect),
            new SandboxError({ reason: 'infra', detail: formatCause(defect) })
          )
        ),
        Effect.scoped,
        Effect.catchTags({
          SandboxError: halt,
          SessionStop: halt,
          TrackerError: halt,
        })
      );
    return { run: current, drove: true };
  }).pipe(
    Effect.scoped,
    Effect.flatMap(({ run, drove }) =>
      drove && run.owed ? Effect.map(runEndChecks(graph, run.id), ended => ended ?? run) : Effect.succeed(run)
    )
  );
