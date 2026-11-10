import { Effect, Option } from 'effect';
import { type Workflow, formatTemplate, transition, isRunDone, isQuiet } from '../workflow.ts';
import type { Event, Issue } from '../event.ts';
import { type Graph, formatLimitRaise, makeRunGraph, parseIssueLimits } from '../folder.ts';
import { Store } from '../store.ts';
import { Tracker, findBranchPull } from '../tracker.ts';
import { formatSpend, makeOutcomeLine } from '../trace.ts';
import { context, getEvents } from '../context.ts';
import { Sandbox, SandboxError } from '../sandbox.ts';
import { ensureGraphRef, readGit, writeCheckoutTree, gitIdentity, commitCheckout, readEngineVersions } from '../git.ts';
import {
  formatRunBranch,
  readIssueWithPull,
  readHeardOutcome,
  readContinuedRun,
  writeHeardEvents,
  readEarlierBranch,
} from './hear.ts';
import { type Services, formatFailure } from './execute.ts';
import { formatSettled } from './start.ts';
import { removeThreads, writeEyes, writeStatus, readRunSpend, runEndChecks } from './settle.ts';
import { moveCheckoutOnto, readBaseGain } from './follow.ts';
import { runSetup } from './checkout.ts';
import { runAttempt } from './attempt.ts';
import { type Outcome, type Run, type SessionStop, type StoreError, type TrackerError, formatCause } from '../types.ts';

/** The open pull request a run on `issue` stacks on: the one it names, or the one of the issue it names. */
const findStackBase = (w: Workflow, issue: Issue, open: Issue[]): Run['base'] => {
  const on = open.find(t => t.number === issue.stacksOn);
  const pull = on?.pull ? on : findBranchPull(open, formatRunBranch(w, { issue: issue.stacksOn! }, open));
  return (
    pull?.pull && {
      pull: pull.number,
      branch: pull.pull.branch,
      sha: pull.pull.head,
    }
  );
};

const findFreeBranch = (named: string) =>
  Effect.gen(function* () {
    const runs = yield* (yield* Store).list();
    const tracker = yield* Tracker;
    const sandbox = yield* Sandbox;
    for (let n = 2; ; n++) {
      const branch = `${named}-${n}`;
      if (runs.some(r => r.checkout?.branch === branch)) continue;
      if ((yield* tracker.issues({ branch })).length > 0) continue;
      if (yield* Effect.isSuccess(sandbox.readHead(branch))) continue;
      return branch;
    }
  });

const formatClosedAttempt = (
  earlier: Effect.Success<ReturnType<typeof readEarlierBranch>> & { pull: Issue },
  feedback?: string
) =>
  Effect.gen(function* () {
    const pull = yield* (yield* Tracker).issue(earlier.pull.number);
    return [
      `## The earlier attempt\n\nPull request #${pull.number} from ${earlier.branch} was closed without merging: ${pull.url}. This run starts over on a new branch from the current base. Learn from it; do not copy it blindly.`,
      earlier.before && `Its run: ${formatSettled(earlier.before)}.`,
      context({ issue: pull }),
      feedback,
    ]
      .filter(Boolean)
      .join('\n\n');
  });

const rejected = 'the model provider rejected the key or login. Fix it, then start a new run.';

/**
 * Hears what was said while the run waited, runs the graph's setup, tries until the run stops running, then runs the end
 * checks it left owed. An engine error is retried once, then parks the run at its step, so an
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
        current = yield* writeStatus(w, next, graph);
        yield* store.put(current);
      });
    const hear = (all: boolean) =>
      Effect.gen(function* () {
        const t = yield* Effect.option(readIssueWithPull(w, current, graph));
        if (Option.isSome(t)) yield* writeHeardEvents(current, getEvents(t.value));
        const queued = Option.isSome(t) ? yield* readHeardOutcome(graph, w, current, t.value) : undefined;
        if (queued && (all || queued.outcome.kind !== 'answer' || w.concurrency === 'cancel')) {
          yield* Effect.forEach(queued.events, m => writeEyes(current, m.issue, m));
          yield* settle(
            queued.outcome,
            yield* readContinuedRun({ ...transition(w, current, queued.outcome), seen: queued.at }, queued.events)
          );
        }
        if (current.status === 'running') yield* admit(Option.getOrUndefined(t)?.issue);
      });
    const formatTimeout = (limits: NonNullable<Run['limits']>) =>
      `A command ran past the ${limits.minutes.value}-minute limit, ${formatLimitRaise(graph.limits, limits, 'minutes')}`;
    const waitOnLimits = (why: string, run = current) =>
      settle(
        { kind: 'ask', question: why, waiting: { on: 'limits', why } },
        isQuiet(w)
          ? transition(w, run, { kind: 'stop', why })
          : { ...removeThreads(run), status: 'waiting', waiting: { on: 'limits', why } }
      );
    const admit = (issue?: Issue & { events: readonly Event[] }) =>
      Effect.gen(function* () {
        const read = issue
          ? parseIssueLimits(graph.limits, issue)
          : (current.limits ?? parseIssueLimits(graph.limits, { labels: [], events: [] }));
        if ('why' in read) return yield* waitOnLimits(read.why);
        const timeout = current.limits?.timeout && read.minutes.value <= current.limits.minutes.value;
        const limits = timeout ? { ...read, timeout } : read;
        if (JSON.stringify(limits) !== JSON.stringify(current.limits))
          yield* store.put((current = { ...current, limits }));
        if (limits.timeout) return yield* waitOnLimits(formatTimeout(limits));
        const spend = yield* readRunSpend(current.id);
        if (spend.usd >= limits.usdPerRun.value)
          yield* waitOnLimits(
            `Spent ${formatSpend(spend)} of the $${limits.usdPerRun.value} usd-per-run limit, ${formatLimitRaise(graph.limits, limits, 'usd-per-run')}`
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
      const earlier = !current.checkout && named ? yield* readEarlierBranch(w, current, named) : undefined;
      const closed = earlier?.pull?.state === 'closed' ? { ...earlier, pull: earlier.pull } : undefined;
      const own =
        current.checkout?.branch ?? (closed && named ? yield* findFreeBranch(named) : earlier?.branch) ?? named;
      if (closed) current = { ...current, feedback: yield* formatClosedAttempt(closed, current.feedback) };
      const ref =
        (own && issue.pull?.branch === own && issue.pull.base) ||
        ((issue.state === 'open' ? issue.pull?.branch : undefined) ??
          current.base?.branch ??
          formatTemplate(base, issue));
      yield* store.put((current = { ...current, checkout: { base: ref, ...(own && { branch: own }) } }));
      const readonly = w.steps.every(s => 'agent' in s.does && graph.agents[s.does.agent]?.readonly);
      const made = yield* Effect.flatMap(Sandbox, s =>
        s.checkout(ref, own, `refs/agentgraph/runs/${run.id}`, { ...graph, readonly })
      );
      if (current.graphTree === undefined) {
        const { image } = made;
        const versions = {
          ...(yield* readEngineVersions),
          ...(image && {
            image: image.id,
            harnesses: Object.fromEntries(
              Object.values(graph.agents).map(a => [a.harness, image.packages[a.package ?? ''] ?? 'unknown'])
            ),
          }),
        };
        yield* store.put((current = { ...current, graphTree: yield* ensureGraphRef(made.git, graph.dir), versions }));
      }
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

      if (current.moved) {
        const { moved, ...rest } = current;
        const gain = yield* readBaseGain(made.git, ref, moved.from, moved.onto);
        yield* store.put((current = { ...rest, feedback: [rest.feedback, gain].filter(Boolean).join('\n\n') }));
      }
      if (!w.on.feedback && !readonly) yield* runSetup(makeRunGraph(graph, current), made, current);
      const onto = current.onto?.sha ?? (made.saved && !made.head ? current.base?.sha : undefined);
      const work = onto ? yield* moveCheckoutOnto(made, onto, !current.onto || current.tries === 0) : made;
      current = { ...current, startCommit: work.base };
      const attempts = `refs/agentgraph/attempts/${run.id}/`;
      let count = (yield* readGit(work.git, ['rev-parse', `--glob=${attempts}*`])).split('\n').filter(Boolean).length;
      while (current.status === 'running') {
        const tried = yield* runAttempt({ ...w, base }, current, makeRunGraph(graph, current), work, own);
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
        if (!isRunDone(current)) yield* hear(true);
      }
      const files = made.written && (yield* Effect.promise(made.written));
      if (files !== undefined)
        yield* store.trace(run.id, { at: new Date().toISOString(), step: current.step, cache: { files } });
    });
    const halt = (e: SandboxError | SessionStop | TrackerError) => {
      const why = formatFailure(e);
      if (e._tag === 'SessionStop' && e.reason === 'human')
        return settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why: 'Stopped by a person.' }));
      if (e._tag === 'SessionStop' && e.reason === 'login')
        return settle({ kind: 'stop', why }, transition(w, current, { kind: 'stop', why: rejected }), 'login');
      if ('reason' in e && e.reason === 'timeout' && current.limits) {
        const limits = { ...current.limits, timeout: true as const };
        return waitOnLimits(formatTimeout(limits), { ...current, limits });
      }
      const host = e._tag === 'SandboxError' && e.reason === 'host';
      if (!current.retried && !host) return settle({ kind: 'ask', question: why }, { ...current, retried: true });
      return settle(
        { kind: 'ask', question: why },
        { ...removeThreads(current), status: 'waiting', waiting: { on: 'engine', error: e._tag }, retried: true }
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
