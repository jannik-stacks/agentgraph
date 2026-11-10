import { randomUUID } from 'node:crypto';
import { Deferred, Duration, Effect, Exit, FiberSet, identity, Option, Schema, Scope, Semaphore, Stream } from 'effect';
import { formatEventLine } from '../context.ts';
import {
  Tracker,
  currentRunLinkRef,
  findBranchPull,
  formatAgentComment,
  isAgentBranch,
  parseAgentRequest,
} from '../tracker.ts';
import type { Comment, Event, Issue } from '../event.ts';
import type { Proposal } from '../proposal.ts';
import { PluginMetadata } from '../meta.ts';
import type { Graph } from '../folder.ts';
import { Sandbox } from '../sandbox.ts';
import { Store } from '../store.ts';
import { getSha } from '../hash.ts';
import { makeOutcomeLine } from '../trace.ts';
import {
  begin,
  fold,
  getEventOutcome,
  makeRunWithFreshRound,
  transition,
  type Workflow,
  isHumanWaitStep,
  isIssueTriggered,
  isQuiet,
  isRunDone,
  getAgentRequest,
  pickCommandTarget,
  isTemplateBranch,
} from '../workflow.ts';
import { type Services, formatFailure } from './execute.ts';
import {
  formatRunBranch,
  isInScope,
  isBoardGraph,
  isRetro,
  findSettledRuns,
  findRouter,
  pickNewest,
  isHeardBy,
  readContinuedRun,
  readRunEvents,
  getHeardEvent,
  writeHeardEvents,
} from './hear.ts';
import { runLaterChecks } from './evaluate.ts';
import { isParked, writeEyes, writeMovedStatus, writeStatus, runEndChecks } from './settle.ts';
import { findUndispatchable, startProposedRun, formatSettled, makeRunId, startRun } from './start.ts';
import { runAside, runFollow, runCatchUp } from './follow.ts';
import { runWorkflow } from './drive.ts';
import {
  stoppedByEngine,
  formatWaitingOn,
  type Outcome,
  type Run,
  type RunRecord,
  SessionStop,
  type StoreError,
  type Trace,
  TrackerError,
} from '../types.ts';

/**
 * Why a run is held: "Depends on" issues not yet closed, and with `stacks` the issue it stacks on while that has no pull
 * request. One closed without its work landing is reported instead of falling back to the base branch.
 */
const findHold = (graph: Graph, r: Run, open: Issue[]) =>
  Effect.gen(function* () {
    const w = graph.workflows[r.workflow]!;
    const t = open.find(t => t.number === r.issue);
    if (w.branch === undefined || !t) return undefined;
    const closes = (t.dependsOn ?? []).filter(n => open.some(o => o.number === n)).map(n => `#${n}`);
    const on = graph.stacks && !r.checkout ? t.stacksOn : undefined;
    const parent = open.find(o => o.number === on);
    const waits = parent && !parent.pull && !findBranchPull(open, formatRunBranch(w, { issue: on! }, open));
    const dropped = on !== undefined && !parent && !(yield* isWorkLanded(w, on));
    const until = [
      closes.length && `${closes.join(', ')} ${closes.length > 1 ? 'close' : 'closes'}`,
      waits && `#${on} has a pull request`,
    ].filter(Boolean);
    const why = [
      until.length && `until ${until.join(' and ')}`,
      dropped && `#${on}, which it stacks on, closed without a merged pull request`,
    ].filter(Boolean);
    return why.length ? why.join('; ') : undefined;
  });

const isWorkLanded = (w: Workflow, n: number) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const parent = yield* tracker.issue(n);
    if (parent.pull) return parent.state === 'merged';
    const run = (yield* (yield* Store).list({ issue: n }))
      .filter(r => r.checkout?.branch)
      .toSorted((a, b) => a.started.localeCompare(b.started))
      .at(-1);
    const branch = formatRunBranch(w, run ?? { issue: n }, [parent]);
    return branch === undefined || (yield* tracker.issues({ branch })).some(p => p.state === 'merged');
  }).pipe(Effect.catch(e => Effect.as(Effect.logWarning(`stack parent #${n}`, e), true)));

const spokenByCli = (issue: number, text: string, at: string, parent?: Comment): Event => ({
  id: randomUUID(),
  issue,
  kind: 'comment',
  actor: 'cli',
  bot: false,
  trusted: true,
  at,
  source: 'cli',
  comment: {
    id: '',
    author: 'cli',
    body: formatAgentComment(text),
    agentRequest: parseAgentRequest(text),
    at,
    ...(parent && { path: parent.path!, line: parent.line, under: parent.under ?? parent.id }),
  },
});

const decodeRunMeta = (meta: Run['meta']) =>
  Schema.decodeUnknownEffect(Schema.UndefinedOr(PluginMetadata))(meta).pipe(
    Effect.map(decoded => (decoded ? { meta: decoded } : {})),
    Effect.mapError(() => new TrackerError({ message: 'invalid run metadata' }))
  );

export type Instruction =
  | { kind: 'say'; issue: number; text: string; comment?: string }
  | ({ kind: 'dispatch'; text?: string } & Omit<Extract<Proposal, { kind: 'run' }>, 'kind'>)
  | { kind: 'check'; checks: readonly string[]; workflow?: string; issue?: number }
  | ({ kind: 'resume' } & (Pick<Run, 'id'> | { parked: true }));

/** CLI instructions use the event handling and dispatch checks of router proposals. */
export const instruct = (
  graph: Graph,
  instruction: Instruction,
  meta?: Run['meta']
): Effect.Effect<RunRecord[], TrackerError | StoreError, Services> =>
  Effect.gen(function* () {
    const supplied = yield* decodeRunMeta(meta);
    if (instruction.kind === 'resume') {
      const store = yield* Store;
      const runs = yield* store.list();
      const selected = 'id' in instruction ? runs.filter(r => r.id === instruction.id) : runs.filter(isParked);
      if ('id' in instruction && !selected.length)
        return yield* new TrackerError({ message: `no run ${instruction.id}` });
      return yield* Effect.forEach(selected, before =>
        Effect.gen(function* () {
          yield* store.lock(before.id);
          const run = yield* store.get(before.id);
          if (!run || !isParked(run))
            return yield* new TrackerError({ message: `run ${before.id} is not parked by an engine error` });
          const workflow = graph.workflows[run.workflow];
          if (!workflow?.steps.some(s => s.name === run.step))
            return yield* new TrackerError({ message: `the graph has no step ${run.workflow}/${run.step}` });
          const outcome = { kind: 'answer', text: '' } as const;
          const next = yield* writeMovedStatus(workflow, run, transition(workflow, run, outcome), graph);
          yield* store.trace(run.id, {
            at: new Date().toISOString(),
            step: run.step,
            outcome,
            run: { step: next.step, status: next.status, tries: next.tries, rounds: next.rounds },
          });
          yield* store.put(next);
          return next;
        }).pipe(Effect.scoped)
      );
    }
    if (instruction.kind === 'check') {
      const { checks, kind: _kind, ...where } = instruction;
      const unknown = checks.filter(name => !(name in graph.checks));
      if (unknown.length) return yield* new TrackerError({ message: `the graph has no check ${unknown.join(', ')}` });
      const ended = (yield* Effect.flatMap(Store, s => s.listRecords(where))).filter(isRunDone);
      const runs = yield* Effect.forEach(ended, r => runLaterChecks(graph, r.id, [...checks]), {
        concurrency: graph.limits.parallel,
      });
      return runs.filter(r => r !== undefined);
    }
    if (instruction.kind === 'dispatch') {
      const { text, ...p } = { ...instruction, kind: 'run' as const };
      const refused = yield* findUndispatchable(graph, { id: 'cli' }, [p], true);
      if (refused.length) return yield* new TrackerError({ message: refused[0]!.reason! });
      const child = yield* startProposedRun(graph, { id: 'cli' }, p, {
        ...(text && { said: [{ issue: p.issue }] }),
        ...supplied,
      });
      if (!child)
        return yield* new TrackerError({
          message: `could not start ${p.workflow} on #${p.issue}: its run id was taken`,
        });
      if (text)
        yield* Effect.flatMap(Store, s =>
          s.trace(child.id, {
            at: child.started,
            step: child.step,
            spoken: spokenByCli(p.issue, text, child.started),
            ...supplied,
          })
        );
      return [child];
    }
    if (!findRouter(graph)) return yield* new TrackerError({ message: 'graph has no router workflow' });
    const tracker = yield* Tracker;
    const issue = yield* tracker.issue(instruction.issue);
    const parent =
      instruction.comment === undefined
        ? undefined
        : issue.events.find(m => m.comment?.id === instruction.comment)?.comment;
    if (instruction.comment !== undefined && (!issue.pull || parent?.path === undefined))
      return yield* new TrackerError({ message: `no review comment ${instruction.comment} on #${issue.number}` });
    const at = new Date().toISOString();
    const event = spokenByCli(issue.number, instruction.text, at, parent);
    const runs = yield* Effect.flatMap(Store, s => s.list());
    const open = yield* tracker.issues({ state: 'open' });
    const owner = runs.find(
      r => findBranchPull(open, formatRunBranch(graph.workflows[r.workflow], r, open))?.number === issue.number
    );
    const target = runs
      .filter(
        r =>
          !isRunDone(r) && r.issue === (owner?.issue ?? issue.number) && graph.workflows[r.workflow]?.on.issue_comment
      )
      .sort((a, b) => a.started.localeCompare(b.started))
      .at(-1);
    if (target)
      yield* Effect.flatMap(Store, store =>
        store.trace(target.id, { at, step: target.step, spoken: event, ...supplied })
      );
    return yield* tick(graph, owner?.issue ?? issue.number, true, 0, supplied.meta).pipe(
      Effect.provideService(Tracker, {
        ...tracker,
        since: () => Stream.make(event),
      })
    );
  });

/** A trusted person's comment, review or pushed commit; a bare `/agent:` command is not feedback. */
const feedback = (m: Event) =>
  m.trusted &&
  (m.kind === 'comment' ||
    m.kind === 'changes_requested' ||
    m.kind === 'commit' ||
    (m.kind === 'approved' && !!m.comment?.body.trim())) &&
  (!getAgentRequest(m)?.command || !!getAgentRequest(m)!.text);

/** How long an issue must be quiet before what people did there starts or wakes a run, so a burst counts once. */
export const issueDebounceMs = 30_000;

const logged = (r: Run) => (e: StoreError) => Effect.as(Effect.logError(`run ${r.id}`, e), r);

const findLastMove = (trace: readonly Trace[]) => trace.findLast(t => !('spoken' in t) && !('inputs' in t))?.at;

const engineRetry = 'Tried again after an engine error. Go on from where the run was.';

const isEngineRetryDue = (id: string) =>
  Effect.map(
    Effect.flatMap(Store, s => Stream.runCollect(s.read(id))),
    trace => {
      const tries = trace.filter(t => 'outcome' in t && t.outcome.kind === 'answer' && t.outcome.text === engineRetry);
      const last = findLastMove(trace);
      return tries.length < 5 && (!last || Date.now() - Date.parse(last) >= 600_000 * 2 ** tries.length);
    }
  );

/**
 * One look at the repo: reenter live runs, begin new ones on a trusted command or label, drive up to `limits.parallel`.
 * With `only`, it looks at that issue alone and begins a run there when none was live; with `marked` too, only on a
 * trusted command or label. An issue with a trusted event younger than `debounce` ms is left for a later look.
 */
export const tick = (
  graph: Graph,
  only?: number,
  marked = false,
  debounce = 0,
  meta?: Run['meta'],
  fork?: (
    id: string,
    parallel: number | undefined,
    effect: Effect.Effect<Run | undefined, never, Services>
  ) => Effect.Effect<void, never, Services>,
  defer: ((issue: number) => void) | undefined = undefined
): Effect.Effect<Run[], TrackerError | StoreError, Services> =>
  Effect.gen(function* () {
    const supplied = yield* decodeRunMeta(meta);
    const store = yield* Store;
    const traceAsk = (r: Run, question: string) =>
      store.trace(r.id, {
        at: new Date().toISOString(),
        step: r.step,
        outcome: { kind: 'ask', question },
        run: { step: r.step, status: r.status, tries: r.tries, rounds: r.rounds },
      });
    const tracker = yield* Tracker;
    const mine = (r: { issue: number }) => only === undefined || r.issue === only;
    const all = yield* store.list();
    const runs = all.filter(mine).filter(r => !isRetro(graph, r) || isParked(r));
    const waiting = runs.filter(r => !isRunDone(r)).map(run => ({ run, at: run.seen ?? run.started }));
    const started = pickNewest(...runs.map(r => r.started));
    const cursor = started === undefined ? '' : [started, ...waiting.map(p => p.at)].sort()[0]!;
    const issues = yield* tracker.issues({ state: 'open' });
    const boards = isBoardGraph(graph);
    const latest = yield* Stream.runCollect(tracker.since(cursor, boards));
    const merged = (yield* Effect.forEach(
      latest.filter(m => m.kind === 'merged' && !issues.some(t => t.number === m.issue)),
      m =>
        tracker
          .issue(m.issue)
          .pipe(Effect.catchTag('TrackerError', e => Effect.as(Effect.logWarning(`#${m.issue}`, e), [])))
    )).flat();
    const origin = new Map<Event, number>();
    const onRun = (m: Event): Event => {
      const pulls = m.kind === 'comment' ? issues : [...issues, ...merged];
      const r = all.find(
        r =>
          r.issue !== m.issue &&
          graph.workflows[r.workflow] &&
          !isRetro(graph, r) &&
          findBranchPull(pulls, formatRunBranch(graph.workflows[r.workflow], r, pulls))?.number === m.issue
      );
      if (!r) return m;
      const moved = { ...m, issue: r.issue };
      origin.set(moved, m.issue);
      return moved;
    };
    /** Where humans spoke, each place once: the issue, and the review comment thread when it was one. */
    const heard = (ms: Event[]): NonNullable<Run['said']> => {
      const places = ms.map(m => {
        const c = m.kind === 'comment' ? m.comment : undefined;
        return { issue: origin.get(m) ?? m.issue, ...(c?.path !== undefined && { under: c.under ?? c.id }) };
      });
      return places.filter((s, i) => places.findIndex(t => t.issue === s.issue && t.under === s.under) === i);
    };
    /** 👀 on what woke a run; the run comes back pointing at that comment. */
    const eyes = (run: Run, m: Event): Effect.Effect<Run, StoreError, Tracker | Store> => {
      if (m.source === 'cli')
        return Effect.gen(function* () {
          const spoken = { ...m, issue: origin.get(m) ?? m.issue };
          const before = yield* Stream.runCollect(store.read(run.id));
          const recorded = before.some(t => 'spoken' in t && t.spoken.source === 'cli' && t.spoken.id === m.id);
          if (!recorded) yield* store.trace(run.id, { at: m.at, step: run.step, spoken, ...supplied });
          return run;
        });
      return Effect.map(writeEyes(run, origin.get(m) ?? m.issue, m), eyes => (eyes ? { ...run, eyes } : run));
    };
    const triggered = Object.values(graph.workflows).filter(w => w.on.issue_comment);
    const router = findRouter(graph)?.name;
    /** Whether a trusted event on the issue is younger than `debounce`, so a burst still coming starts nothing yet. */
    const young = (issue: number) =>
      debounce > 0 &&
      latest.some(
        m => (m.issue === issue || onRun(m).issue === issue) && m.trusted && Date.now() - Date.parse(m.at) < debounce
      );
    if (only !== undefined && young(only)) defer?.(only);
    const events = latest.map(onRun).filter(mine);
    const used = new Set<Event>();
    const touched: Run[] = [];
    const current = (r: Run) => touched.find(t => t.id === r.id) ?? r;
    /** Moves a live run outside a session: traces the outcome and saves where it led. */
    const record = (run: Run, outcome: Outcome, next: Run) =>
      Effect.gen(function* () {
        yield* store.trace(run.id, makeOutcomeLine(run.step, outcome, next));
        yield* store.put(next);
        touched.push(next);
      });
    waiting.sort((a, b) => b.run.started.localeCompare(a.run.started));
    for (const waitingRun of waiting)
      yield* Effect.gen(function* () {
        if (!(yield* Effect.isSuccess(store.lock(waitingRun.run.id)))) return;
        const run = yield* store.get(waitingRun.run.id);
        if (!run || isRunDone(run)) return;
        const at = run.seen ?? run.started;

        const w = graph.workflows[run.workflow];
        const tells = w ? yield* readRunEvents(run) : [];
        const trace = yield* Stream.runCollect(store.read(run.id));
        const spoken = trace.filter(t => 'spoken' in t);
        const pending = spoken
          .map(t => t.spoken)
          .filter(m => m.source === 'cli' && !events.some(e => e.source === 'cli' && e.id === m.id))
          .map(m => {
            const moved = { ...m, issue: run.issue };
            origin.set(moved, m.issue);
            return moved;
          });
        yield* writeHeardEvents(
          run,
          events.filter(m => m.issue === run.issue).map(m => ({ ...m, issue: origin.get(m) ?? m.issue }))
        );

        /** A working run takes only a stop here; what else people say reaches it where it works. */
        const taken = (m: Event, lined: Event[] = []) => {
          const o =
            w &&
            getEventOutcome(
              w,
              run,
              tells.includes(m) || (isParked(run) && isQuiet(w)) ? m : getHeardEvent(router, w, m),
              lined,
              pickCommandTarget(graph, runs, m, router, tells.includes(m) ? run : undefined)
            );
          return o && (run.status !== 'running' || o.kind === 'stop') ? o : undefined;
        };
        const answers =
          w && !young(run.issue)
            ? [...events, ...pending, ...tells].filter(
                m =>
                  m.issue === run.issue &&
                  m.at > at &&
                  (!isParked(run) || m.at > (findLastMove(trace) ?? at)) &&
                  !used.has(m) &&
                  taken(m)
              )
            : [];
        const m =
          answers.find(m => m.kind === 'merged') ?? answers.find(a => taken(a)!.kind !== 'answer') ?? answers[0];
        if (!w || !m) return;
        /** A stop, pass or merge takes only itself, so what else people asked stays for the comment workflow. */
        const took = taken(m)!.kind === 'answer' ? answers : [m];
        for (const a of took) used.add(a);
        const lined = events.filter(
          l =>
            l.trusted && l.issue === run.issue && l.kind === 'comment' && l.comment?.path && l.at > at && l.at <= m.at
        );
        const outcome = fold([m, ...took.filter(a => a !== m)].map(a => taken(a, a === m ? lined : [])!))!;
        yield* Effect.forEach(
          took.filter(a => a !== m),
          a => writeEyes(run, origin.get(a) ?? a.issue, a)
        );
        const seen = makeRunWithFreshRound(w, {
          ...(m.kind === 'comment' && (m.comment?.id || m.source === 'cli') ? yield* eyes(run, m) : run),
          said: heard([m, ...took.filter(a => a !== m)]),
        });
        const step = w.steps.find(s => s.name === run.step);
        const pr = findBranchPull(issues, formatRunBranch(w, run, issues));
        const asked: { run: Run; outcome?: Outcome; again?: boolean } | undefined =
          outcome.kind !== 'answer' || !step || !isHumanWaitStep(step)
            ? undefined
            : yield* (
                pr?.pull && !(tells.includes(m) && step.back)
                  ? runAside(w, seen, graph, outcome.text, pr.pull, pr.number)
                  : step.back
                    ? Effect.succeed({ run: seen, outcome: { kind: 'back', why: outcome.text } as const })
                    : Effect.fail(
                        new SessionStop({
                          reason: 'provider',
                          detail: 'this wait step has no pull request or way back',
                        })
                      )
              ).pipe(
                Effect.catch(e =>
                  Effect.gen(function* () {
                    yield* Effect.logError(`aside of run ${run.id}`, e);
                    if (e._tag === 'StoreError') return yield* e;
                    yield* traceAsk(run, formatFailure(e));
                    if (!run.retried)
                      return {
                        run: { ...run, ...(seen.eyes && { eyes: seen.eyes }), retried: true as const },
                        again: true,
                      };
                    return {
                      run: yield* writeStatus(w, { ...seen, reason: `${stoppedByEngine}.`, retried: true }, graph),
                      again: true,
                    };
                  })
                )
              );
        if (asked?.again) {
          yield* store.put(asked.run);
          return;
        }
        const moved = yield* readContinuedRun(
          {
            ...transition(w, asked?.run ?? seen, asked?.outcome ?? outcome),
            seen: pickNewest(...took.map(a => a.at))!,
          },
          took.map(event => ({ ...event, issue: origin.get(event) ?? event.issue }))
        );
        const next =
          run.status === 'waiting' && run.reason && (moved.status !== 'waiting' || isParked(run))
            ? yield* writeMovedStatus(w, run, moved, graph)
            : yield* writeStatus(w, moved, graph);
        yield* record(run, outcome, next);
      }).pipe(Effect.scoped);
    for (const before of runs.filter(r => r.status === 'waiting' && !touched.some(t => t.id === r.id)))
      yield* Effect.gen(function* () {
        if (!(yield* Effect.isSuccess(store.lock(before.id)))) return;
        const parent = yield* store.get(before.id);
        if (!parent || parent.status !== 'waiting') return;
        const w = graph.workflows[parent.workflow];
        const child = all.find(
          c => c.by === parent.id && parent.reason === formatWaitingOn(c) && c.status !== 'running'
        );
        const due = !child && parent.reason?.startsWith(stoppedByEngine) && (yield* isEngineRetryDue(parent.id));
        if (!w || (!child && !due)) return;
        const outcome: Outcome = { kind: 'answer', text: child ? formatSettled(child) : engineRetry };
        const next = transition(w, parent, outcome);
        yield* record(parent, outcome, child ? next : yield* writeMovedStatus(w, parent, next, graph));
      }).pipe(Effect.scoped);

    const busy = new Set(
      runs
        .map(current)
        .filter(r => !isRunDone(r) && !isRetro(graph, r))
        .map(r => `${r.workflow}#${r.issue}`)
    );
    const open = new Set(issues.filter(t => isInScope(graph, t)).map(t => t.number));
    const labelled = Object.values(graph.workflows).filter(w => w.on.issues?.label);
    /** The label workflow whose label an issue carries, when a maintainer put it there last. */
    const assigned = (issue: number) =>
      Effect.map(tracker.issue(issue), t =>
        labelled.find(w => {
          const last = t.events
            .filter(m => (m.kind === 'label' || m.kind === 'unlabel') && m.label === w.on.issues!.label)
            .at(-1);
          return last?.kind === 'label' && last.trusted;
        })
      );
    /** Begins `w` on `issue`. A restart begins at the step it names, else the first, with the answers and reports of the last run there. */
    const start = (w: Workflow, issue: number, at: string, m?: Event, restart?: string) =>
      Effect.gen(function* () {
        const last = all
          .filter(r => r.issue === issue && r.workflow === w.name)
          .sort((a, b) => a.started.localeCompare(b.started))
          .at(-1);
        const step = w.steps.find(s => s.name === restart);
        const restarts = events.filter(n => {
          const t = n.issue === issue && pickCommandTarget(graph, runs, n, router);
          return restart !== undefined && !!t && !('why' in t) && t.verb === 'restart';
        });
        const seen = pickNewest(...restarts.map(n => n.at));
        const begun = {
          ...begin(
            w,
            {
              id: makeRunId(w, issue, at),
              issue,
              started: at,
              ...(restart !== undefined && last?.reported && { reported: last.reported }),
            },
            step
          ),
          ...supplied,
          ...(seen && seen > at && { seen }),
          ...(m?.kind === 'comment' && { said: heard([m]) }),
          ...(restart !== undefined && last?.answers && { answers: last.answers }),
        };
        const run = yield* startRun(begun, run =>
          Effect.andThen(
            writeHeardEvents(run, m ? [{ ...m, issue: origin.get(m) ?? m.issue }] : [], run.started),
            Effect.flatMap(writeStatus(w, run, graph), r => (m ? eyes(r, m) : Effect.succeed(r)))
          )
        );
        if (!run) return;
        busy.add(`${w.name}#${issue}`);
        const mark = w.on.issues?.label;
        if (mark !== undefined && m && m.kind !== 'label' && isIssueTriggered(w, m))
          yield* tracker.apply(issue, { kind: 'label', add: [mark] }).pipe(
            Effect.flatMap(applied => store.trace(run.id, { at: new Date().toISOString(), step: run.step, applied })),
            Effect.catchTag('TrackerError', e => Effect.logWarning(`label for run ${run.id}`, e))
          );
        touched.push(run);
      });
    const refuse = (m: Event, why: string) =>
      Effect.gen(function* () {
        const issue = origin.get(m) ?? m.issue;
        const key = getSha(JSON.stringify(['refuse', issue, m.comment?.id, m.at, m.comment?.body]));
        if (!(yield* Effect.isSuccess(store.lock(`refuse-${key}`)))) return;
        const reply = { kind: 'comment', body: why } as const;
        if (yield* tracker.findPost(issue, reply, key)) return;
        yield* Effect.updateService(tracker.apply(issue, reply), currentRunLinkRef, () => ({
          run: '',
          step: '',
          operation: key,
        }));
      }).pipe(
        Effect.scoped,
        Effect.catchTag('TrackerError', e => Effect.logWarning(`reply on #${m.issue}`, e))
      );
    for (const m of events) {
      const target = pickCommandTarget(graph, runs, m, router);
      if (target && 'why' in target) {
        if (m.trusted) yield* refuse(m, target.why);
        continue;
      }
      if (target && (target.verb === 'stop' || target.verb === 'cancel' || (!target.verb && target.run))) continue;
      const relabelled = events.some(
        n => n.issue === m.issue && n.label === m.label && n.at > m.at && (n.kind === 'label' || n.kind === 'unlabel')
      );
      const sourced = Object.values(graph.workflows).find(w => isIssueTriggered(w, m));
      const restart = target?.verb === 'restart' ? (target.step ?? '') : undefined;
      const w =
        m.kind === 'label' && relabelled
          ? undefined
          : (sourced ?? (getAgentRequest(m) !== undefined ? (target?.workflow ?? triggered[0]) : undefined));
      if (!w || (used.has(m) && restart === undefined) || !(sourced || m.trusted) || young(m.issue)) continue;
      if (!open.has(m.issue) && (m.kind !== 'comment' || !isInScope(graph, yield* tracker.issue(m.issue)))) continue;
      const old =
        restart === undefined &&
        runs.some(
          r =>
            r.issue === m.issue &&
            isHeardBy(graph, r.workflow, m) &&
            (m.at <= (r.seen ?? r.started) || (sourced && r.workflow === w.name && r.status === 'done'))
        );
      const held =
        restart === undefined
          ? [...busy].some(k => k.endsWith(`#${m.issue}`) && isHeardBy(graph, k.slice(0, k.lastIndexOf('#')), m))
          : busy.has(`${w.name}#${m.issue}`);
      if (!held && !old) yield* start(w, m.issue, m.at, m, restart);
    }
    if (
      only !== undefined &&
      !marked &&
      !runs.some(r => !isRunDone(r) && !isRetro(graph, r)) &&
      !touched.some(r => r.issue === only)
    ) {
      const w = triggered[0] ?? (yield* assigned(only));
      if (
        w &&
        isInScope(
          graph,
          issues.find(t => t.number === only)
        )
      )
        yield* start(w, only, new Date().toISOString());
    }

    /** The issue a run worked on for what was said there, or on a pull request of its branch that is no longer open; `onRun` maps an open one. */
    const pulls = new Map<number, number | undefined>();
    const workedOn = (m: Event) =>
      Effect.gen(function* () {
        if (all.some(r => r.issue === m.issue && !isRetro(graph, r))) return m.issue;
        if (issues.some(t => t.number === m.issue)) return undefined;
        if (!pulls.has(m.issue)) {
          const branch = Option.getOrUndefined(yield* Effect.option(tracker.issue(m.issue)))?.pull?.branch;
          const by = all.find(r => {
            const w = graph.workflows[r.workflow];
            return !isRetro(graph, r) && w?.branch !== undefined && branch === formatRunBranch(w, r);
          });
          pulls.set(m.issue, by?.issue);
        }
        return pulls.get(m.issue);
      });
    for (const w of Object.values(graph.workflows).filter(w => w.on.feedback)) {
      const heardOn = new Map<number, Event[]>();
      for (const m of latest
        .map(onRun)
        .filter(m => feedback(m) && !('why' in (pickCommandTarget(graph, runs, m, router) ?? {})))) {
        const issue = yield* workedOn(m);
        if (issue !== undefined && mine({ issue })) heardOn.set(issue, [...(heardOn.get(issue) ?? []), m]);
      }
      const ends = findSettledRuns(graph, w, all).filter(mine);
      for (const issue of new Set([...heardOn.keys(), ...ends.map(r => r.issue)])) {
        const before = all.filter(r => r.issue === issue && r.workflow === w.name);
        if (young(issue)) continue;
        const first = all
          .filter(r => r.issue === issue && !isRetro(graph, r))
          .map(r => r.started)
          .sort()[0];
        const since = pickNewest(first, ...before.map(r => r.started))!;
        const fresh = (heardOn.get(issue) ?? []).filter(
          m => m.at > since && !touched.some(r => r.issue === issue && r.workflow === w.name && r.seen === m.at)
        );
        const ended = ends.filter(r => r.issue === issue);
        if (fresh.length + ended.length === 0) continue;
        const at = pickNewest(...fresh.map(m => m.at), ...ended.map(r => r.ended))!;
        const begun: Run = {
          ...begin(w, { id: makeRunId(w, issue, at), issue, started: at }),
          feedback: [
            fresh.length > 0 && `## What a person said or pushed\n\n${fresh.map(formatEventLine).join('\n\n')}`,
            ended.length > 0 &&
              `## How the runs ended\n\n${ended.map(r => `${r.id}: ${formatSettled(r)}`).join('\n\n')}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        };
        const heard = fresh.map(m => ({ ...m, issue: origin.get(m) ?? m.issue }));
        if (yield* startRun(begun, r => Effect.as(writeHeardEvents(r, heard, r.started), r))) touched.push(begun);
      }
    }

    for (const r of runs.map(current).filter(r => !isRunDone(r))) {
      const w = graph.workflows[r.workflow];
      const head = r.base && issues.find(t => t.number === r.base!.pull)?.pull?.head;
      if (!r.base || !head || !w) continue;
      const branch = formatRunBranch(w, r, issues);
      const tip =
        findBranchPull(issues, branch)?.pull.head ??
        (branch &&
          (yield* Effect.flatMap(Sandbox, s => s.readHead(branch)).pipe(Effect.orElseSucceed(() => undefined))));
      yield* runFollow(w, r, r.base, head, tip, graph).pipe(
        Effect.catch(e =>
          Effect.gen(function* () {
            yield* Effect.logError(`follow run ${r.id}`, e);
            if (e._tag === 'SandboxError') yield* traceAsk(r, formatFailure(e));
          })
        )
      );
    }

    const newest = (r: Run) =>
      ![...all, ...touched].some(o => o.issue === r.issue && o.workflow === r.workflow && o.started > r.started);
    for (const before of runs.map(current).filter(r => r.status === 'waiting' || r.status === 'done'))
      yield* Effect.gen(function* () {
        if (!(yield* Effect.isSuccess(store.lock(before.id)))) return;
        const r = yield* store.get(before.id);
        if (!r || (r.status !== 'waiting' && r.status !== 'done') || r.onto || isParked(r) || !newest(r)) return;
        const w = graph.workflows[r.workflow];
        const pull = w && findBranchPull(issues, formatRunBranch(w, r, issues))?.pull;
        if (!w?.steps.some(isHumanWaitStep) || !pull || all.some(c => c.by === r.id && !isRunDone(c))) return;
        const sandbox = yield* Sandbox;
        const base = yield* sandbox.readHead(pull.base);
        if (r.blocked?.base === base && r.blocked.head === pull.head && r.blocked.graph === graph.sha) return;
        const { blocked: _, ...ready } = r;
        if (r.blocked) yield* store.put(ready);
        const caught = yield* runCatchUp(w, r, graph, pull).pipe(
          Effect.catch(e =>
            e._tag === 'StoreError'
              ? Effect.fail(e)
              : Effect.gen(function* () {
                  const head = yield* sandbox.readHead(pull.branch).pipe(Effect.orElseSucceed(() => pull.head));
                  yield* traceAsk(r, `Catch-up failed: ${formatFailure(e)}`);
                  const moved = (yield* store.get(r.id))?.moved;
                  return {
                    run: { ...ready, ...(moved && { moved }), blocked: { base, head, graph: graph.sha } },
                    outcome: undefined,
                  };
                })
          )
        );
        const next = caught?.outcome && transition(w, caught.run, caught.outcome);
        if (caught?.outcome && next) yield* record(caught.run, caught.outcome, yield* writeStatus(w, next, graph));
        else if (caught) yield* store.put(caught.run);
      }).pipe(
        Effect.scoped,
        Effect.catch(e => (e._tag === 'StoreError' ? Effect.fail(e) : Effect.logError(`catch up run ${before.id}`, e)))
      );

    const live = (yield* store.list({ status: 'running' })).filter(mine).filter(r => graph.workflows[r.workflow]);
    const holds = new Map(
      yield* Effect.forEach(live, r => Effect.map(findHold(graph, r, issues), why => [r.id, why] as const))
    );
    const hold = (r: Run) => holds.get(r.id);
    yield* Effect.forEach(
      live.filter(r => r.reason !== hold(r)),
      before =>
        Effect.gen(function* () {
          if (!(yield* Effect.isSuccess(store.lock(before.id)))) return;
          const r = yield* store.get(before.id);
          if (r?.status !== 'running') return;
          const { reason: _, ...rest } = r;
          const why = hold(r);
          const next = { ...rest, ...(why && { reason: why }) };
          yield* store.put(next);
          yield* writeStatus(graph.workflows[r.workflow]!, next, graph);
        }).pipe(Effect.scoped)
    );
    const running = live.filter(r => !hold(r)).toSorted((a, b) => a.started.localeCompare(b.started));
    const forkAll = (runs: Run[], f: (r: Run) => Effect.Effect<Run | undefined, StoreError, Services>) =>
      Effect.as(
        Effect.forEach(runs, r =>
          fork!(r.id, r.workflow === router ? undefined : graph.limits.parallel, f(r).pipe(Effect.catch(logged(r))))
        ),
        []
      );
    const drive = (r: Run) => runWorkflow(graph.workflows[r.workflow]!, r, graph);
    const driven = fork
      ? yield* forkAll(running, drive)
      : yield* Effect.forEach(running, r => drive(r).pipe(Effect.catch(logged(r))), {
          concurrency: graph.limits.parallel,
        });
    const looked = [...touched, ...running];
    yield* Effect.forEach(
      (yield* store.list()).filter(
        r => r.unshown && mine(r) && graph.workflows[r.workflow] && !looked.some(l => l.id === r.id)
      ),
      before =>
        Effect.gen(function* () {
          if (!(yield* Effect.isSuccess(store.lock(before.id)))) return;
          const r = yield* store.get(before.id);
          if (r?.unshown) yield* writeStatus(graph.workflows[r.workflow]!, r, graph);
        }).pipe(Effect.scoped)
    );
    const owing = (yield* store.list()).filter(r => r.owed && mine(r));
    const ended = fork
      ? yield* forkAll(owing, r => runEndChecks(graph, r.id))
      : (yield* Effect.forEach(owing, r => runEndChecks(graph, r.id), { concurrency: graph.limits.parallel })).filter(
          r => r !== undefined
        );
    const moved = [...touched.filter(r => !driven.some(d => d.id === r.id)), ...driven];
    return [...moved.filter(r => !ended.some(e => e.id === r.id)), ...ended];
  });

const getGate = (gates: Map<number, Semaphore.Semaphore>, n: number) => {
  const gate = gates.get(n) ?? Semaphore.makeUnsafe(1);
  gates.set(n, gate);
  return gate;
};

const readIssueScan = (
  graph: Graph,
  debounce: number,
  fork?: Parameters<typeof tick>[5],
  poll: { cursor: string; latest: Effect.Effect<Event[], TrackerError> } | undefined = undefined
) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const [listing, invalidate] = yield* Effect.cachedInvalidateWithTTL(
      tracker.issues({ state: 'open' }),
      Duration.infinity
    );
    const listed = yield* listing;
    const fetched = [...listed];
    const readFresh = (n: number) => tracker.issue(n).pipe(Effect.tap(t => Effect.sync(() => fetched.push(t))));
    const closed = new Map<number, ReturnType<typeof readFresh>>();
    const read = (n: number) => {
      if (listed.some(t => t.number === n)) return readFresh(n);
      const once = closed.get(n) ?? Effect.runSync(Effect.cached(readFresh(n)));
      closed.set(n, once);
      return once;
    };
    const all = yield* Effect.flatMap(Store, s => s.list());
    const cursor =
      poll?.cursor ??
      (all.length
        ? new Date(
            Date.parse(all.flatMap(r => [r.started, r.seen ?? r.started]).toSorted()[0]!) - debounce
          ).toISOString()
        : '');
    const boards = isBoardGraph(graph);
    const latest = yield* Effect.cached(poll?.latest ?? Stream.runCollect(tracker.since(cursor, boards)));
    const history = cursor && !poll ? yield* Effect.cached(Stream.runCollect(tracker.since('', boards))) : latest;
    const deferred = new Set<number>();
    const look = (n: number, meta?: Run['meta']) =>
      tick(
        graph,
        n,
        true,
        debounce,
        meta,
        fork && ((id, parallel, effect) => fork(id, parallel, Effect.provideService(effect, Tracker, tracker))),
        n => deferred.add(n)
      ).pipe(
        Effect.provideService(Tracker, {
          ...tracker,
          issue: read,
          issues: filter =>
            filter?.state === 'open' &&
            !filter.labels?.length &&
            filter.parent === undefined &&
            filter.branch === undefined
              ? listing
              : tracker.issues(filter),
          since: at => Stream.fromIterableEffect(at < cursor ? history : latest).pipe(Stream.filter(m => m.at > at)),
          apply: (...args) =>
            tracker.apply(...args).pipe(
              Effect.tap(a =>
                a.ok && ['issue', 'pull_request', 'merge', 'label', 'push', 'rebase'].includes(a.proposal.kind)
                  ? Effect.andThen(
                      invalidate,
                      Effect.sync(() => closed.clear())
                    )
                  : Effect.void
              )
            ),
        }),
        Effect.catchTag('TrackerError', e => Effect.as(Effect.logError(`look at #${n}`, e), []))
      );
    return { all, listed, latest, fetched, look, deferred, read };
  });

/**
 * One pass over the issues of live runs, then wherever a trusted `/agent` was said since the newest run began, closed or
 * merged ones too, then the open issues, up to `limits.parallel` at once: each gets one look, and a new run only on a trusted
 * mark. Each issue is read from its own last run on, so it catches up on what a repo-wide look has passed. `debounce` is
 * as for `tick`.
 */
export const scanIssuesAndRunningRuns = (
  graph: Graph,
  debounce = 0,
  meta?: Run['meta'],
  fork?: Parameters<typeof tick>[5],
  gates = new Map<number, Semaphore.Semaphore>()
): Effect.Effect<Run[], TrackerError | StoreError, Services> =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const { all, listed, latest, fetched, look } = yield* readIssueScan(graph, debounce, fork);
    const runs = all.filter(r => !isRunDone(r) || r.owed);
    const from = pickNewest(...all.map(r => r.started));
    const open = listed.filter(t => !t.pull && isInScope(graph, t));
    const said = from === undefined ? [] : (yield* latest).filter(m => Date.parse(m.at) > Date.parse(from) - debounce);
    const asked = said.filter(m => m.trusted && getAgentRequest(m) !== undefined).map(m => m.issue);
    const ended = Object.values(graph.workflows)
      .filter(w => w.on.feedback)
      .flatMap(w => findSettledRuns(graph, w, all));
    const issues = [
      ...new Set([...runs.map(r => r.issue), ...ended.map(r => r.issue), ...asked, ...open.map(t => t.number)]),
    ];
    const changed = (yield* Effect.forEach(issues, n => getGate(gates, n).withPermits(1)(look(n, meta)), {
      concurrency: graph.limits.parallel,
    })).flat();
    const kept = yield* Effect.flatMap(Store, s => s.list());
    const sandbox = yield* Sandbox;
    const branches = yield* sandbox
      .readBranches()
      .pipe(Effect.catch(e => Effect.as(Effect.logWarning('local branches', e), [])));
    const uses = (branch: string) => (r: Run) => {
      if (r.checkout) return r.checkout.branch === branch;
      const template = graph.workflows[r.workflow]?.branch;
      return !!template && isTemplateBranch(template, branch, r.issue);
    };
    const cleanBranch = (branch: string, using: Run[]) =>
      Effect.gen(function* () {
        const current = yield* Effect.flatMap(Store, s => s.list());
        if (current.filter(uses(branch)).some(r => !isRunDone(r) || r.owed)) return;
        const isLanded = (t: Issue) => t.state === 'merged' && t.pull?.branch === branch;
        const pull = (
          fetched.find(isLanded) ??
          (yield* tracker
            .issues({ branch })
            .pipe(Effect.catch(e => Effect.as(Effect.logWarning(`1 skipped PR lookup ${branch}`, e), [])))).find(
            isLanded
          )
        )?.pull;
        yield* sandbox
          .removeBranch(
            branch,
            using.some(r => !r.checkout)
              ? undefined
              : (pull?.base ?? using.reduce((a, b) => (a.started > b.started ? a : b)).checkout!.base),
            pull?.head
          )
          .pipe(Effect.catch(e => Effect.logWarning(`checkout cleanup ${branch}`, e)));
      });
    for (const branch of branches.filter(isAgentBranch)) {
      const using = kept.filter(uses(branch));
      if (!using.length) continue;
      yield* [...new Set(using.map(r => r.issue))].reduce(
        (effect, n) => getGate(gates, n).withPermits(1)(effect),
        cleanBranch(branch, using)
      );
    }
    return changed;
  });

export const scanTrackerEvents = (
  graph: Graph,
  cursor: string,
  fork: Parameters<typeof tick>[5],
  gates: NonNullable<Parameters<typeof scanIssuesAndRunningRuns>[4]>,
  due: Map<number, string>
) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const events = yield* Stream.runCollect(tracker.since(cursor, isBoardGraph(graph)));
    const trusted = events.filter(m => m.trusted);
    yield* Effect.gen(function* () {
      const lower = [cursor, ...due.values()].toSorted()[0]!;
      const latest =
        lower === cursor ? Effect.succeed(events) : Stream.runCollect(tracker.since(lower, isBoardGraph(graph)));
      const scan = yield* Effect.cached(readIssueScan(graph, issueDebounceMs, fork, { cursor: lower, latest }));
      const issues = new Set([...trusted.map(m => m.issue), ...due.keys()]);
      if (trusted.length) {
        const { all, listed, fetched, read } = yield* scan;
        yield* Effect.forEach(
          [...issues].filter(n => !listed.some(t => t.number === n)),
          read,
          { concurrency: graph.limits.parallel }
        );
        for (const r of all) {
          const w = graph.workflows[r.workflow];
          const pull = findBranchPull(fetched, formatRunBranch(w, r, fetched))?.number;
          if (pull !== undefined && issues.has(pull)) issues.add(r.issue);
        }
      }
      yield* Effect.forEach(
        issues,
        n =>
          getGate(gates, n)
            .withPermitsIfAvailable(1)(
              Effect.gen(function* () {
                const { look, deferred } = yield* scan;
                yield* look(n);
                return deferred.has(n);
              })
            )
            .pipe(
              Effect.tap(result =>
                Effect.sync(() => {
                  if (Option.isSome(result) && !result.value) due.delete(n);
                  else due.set(n, due.get(n) ?? cursor);
                })
              )
            ),
        { concurrency: graph.limits.parallel }
      );
    }).pipe(Effect.catchTag('TrackerError', e => Effect.logError(e)));
    return pickNewest(cursor, ...events.map(m => m.at)) ?? cursor;
  });

export const startLoopDrives = (host?: Semaphore.Semaphore) => {
  const scope = Scope.makeUnsafe();
  return {
    host,
    passes: Effect.runSync(Scope.provide(FiberSet.make(), scope)),
    driving: new Set<string>(),
    gates: new Map<number, Semaphore.Semaphore>(),
    due: new Map<number, string>(),
    cursor: new Date(Date.now() - 300_000).toISOString(),
    permits: Semaphore.makeUnsafe(1),
    settled: [] as Run[],
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

export const runPass = <A, E, R>(
  drives: ReturnType<typeof startLoopDrives>,
  pass: (fork: NonNullable<Parameters<typeof tick>[5]>) => Effect.Effect<A, E, R | Scope.Scope>
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const decided = yield* Deferred.make<A, E>();
    yield* FiberSet.run(
      drives.passes,
      Effect.gen(function* () {
        const own = yield* FiberSet.make<Run | undefined>();
        const fork: Parameters<typeof pass>[0] = (id, parallel, effect) =>
          Effect.andThen(
            parallel === undefined ? Effect.void : drives.permits.resize(parallel),
            Effect.suspend(() => {
              if (drives.driving.has(id)) return Effect.void;
              drives.driving.add(id);
              return FiberSet.run(
                own,
                effect.pipe(
                  drives.host && parallel !== undefined ? drives.host.withPermits(1) : identity,
                  parallel === undefined ? identity : drives.permits.withPermits(1),
                  Effect.tap(r => Effect.sync(() => r && drives.settled.push(r))),
                  Effect.ensuring(Effect.sync(() => drives.driving.delete(id)))
                )
              );
            })
          );
        yield* Effect.andThen(
          Effect.flatMap(Effect.exit(pass(fork)), exit => Deferred.done(decided, exit)),
          FiberSet.awaitEmpty(own)
        ).pipe(Effect.ensuring(FiberSet.clear(own)));
      }).pipe(Effect.scoped, Effect.ensuring(Deferred.interrupt(decided)))
    );
    return yield* Deferred.await(decided);
  });
