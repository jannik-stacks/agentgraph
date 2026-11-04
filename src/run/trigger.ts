import { matchesGlob } from 'node:path';
import { Deferred, Duration, Effect, Exit, FiberSet, Option, Schema, Scope, Semaphore, Stream } from 'effect';
import { formatEventLine, stoppedByRunner } from '../context.ts';
import { Tracker, TrackerError, currentRunLinkRef, formatAgentComment, isAgentBranch } from '../tracker.ts';
import type { Comment, Event, Issue } from '../event.ts';
import type { Proposal } from '../proposal.ts';
import { PluginMetadata } from '../meta.ts';
import type { Graph } from '../folder.ts';
import { Sandbox } from '../sandbox.ts';
import { Store, type StoreError } from '../store.ts';
import { getSha } from '../hash.ts';
import { SessionStop, makeOutcomeLine } from '../trace.ts';
import {
  begin,
  fold,
  getEventOutcome,
  makeRunWithFreshRound,
  transition,
  type Outcome,
  type Run,
  type RunRecord,
  type Workflow,
  isHumanWaitStep,
  isIssueTriggered,
  isQuiet,
  isRunDone,
  parseAgentRequest,
  pickCommandTarget,
} from '../workflow.ts';
import { type Services, formatFailure } from './execute.ts';
import {
  findPullNumber,
  isInScope,
  isBoardGraph,
  isRetro,
  findRouter,
  pickNewest,
  formatTemplate,
  readContinuedRun,
  readRunEvents,
  getHeardEvent,
} from './hear.ts';
import { runLaterChecks } from './evaluate.ts';
import { isParked, writeMovedStatus, writeStatus, runEndChecks } from './settle.ts';
import { findUndispatchable, startProposedRun, formatWaitingOn, makeRunId, startRun } from './start.ts';
import { runAside, runFollow, runCatchUp } from './follow.ts';
import { runWorkflow } from './drive.ts';

/** What a run still waits for: a "Stacks on" issue without a pull request, or a "Depends on" issue not yet closed. */
const pending = (w: Workflow, issue: number, open: Issue[]) =>
  w.branch === undefined
    ? []
    : [...(open.find(t => t.number === issue)?.body ?? '').matchAll(/^\s*(stacks|depends) on #(\d+)\s*$/gim)]
        .filter(
          ([, how, n]) =>
            open.some(t => t.number === Number(n) && (how!.toLowerCase() === 'depends' || !t.pull)) &&
            (how!.toLowerCase() === 'depends' || findPullNumber(w, Number(n), open) === undefined)
        )
        .map(([, , n]) => Number(n));

const spokenByCli = (issue: number, text: string, at: string, parent?: Comment): Event => ({
  issue,
  kind: 'comment',
  actor: 'cli',
  trusted: true,
  at,
  source: 'cli',
  comment: {
    id: '',
    author: 'cli',
    body: formatAgentComment(text),
    agentRequest: text,
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
  | { kind: 'check'; checks: string[]; workflow?: string; issue?: number }
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
            return yield* new TrackerError({ message: `run ${before.id} is not parked by a runner error` });
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
      const runs = yield* Effect.forEach(ended, r => runLaterChecks(graph, r.id, checks), {
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
      r => graph.workflows[r.workflow] && findPullNumber(graph.workflows[r.workflow]!, r.issue, open) === issue.number
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

/** What a parent hears when the run it started settles. */
const settled = (child: Run) =>
  `${child.workflow} on #${child.issue} ${
    child.status === 'done'
      ? 'is done'
      : child.status === 'stopped'
        ? `stopped: ${child.reason}`
        : `asks: ${child.reason}`
  }`;

/** A trusted person's comment, review or pushed commit; a bare `/agent:` command is not feedback. */
const feedback = (m: Event) =>
  m.trusted &&
  (m.kind === 'comment' ||
    m.kind === 'changes_requested' ||
    m.kind === 'commit' ||
    (m.kind === 'approved' && !!m.comment?.body.trim())) &&
  !/^:\S+$/.test(parseAgentRequest(m) ?? '');

/** How long an issue must be quiet before what people did there starts or wakes a run, so a burst counts once. */
export const issueDebounceMs = 30_000;

const logged = (r: Run) => (e: StoreError) => Effect.as(Effect.logError(`run ${r.id}`, e), r);

const runnerRetry = 'Tried again after a runner error. Go on from where the run was.';

const isRunnerRetryDue = (id: string) =>
  Effect.map(
    Effect.flatMap(Store, s => Stream.runCollect(s.read(id))),
    trace => {
      const tries = trace.filter(t => 'outcome' in t && t.outcome.kind === 'answer' && t.outcome.text === runnerRetry);
      const last = trace.at(-1)?.at;
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
    parallel: number,
    effect: Effect.Effect<Run | undefined, never, Services>
  ) => Effect.Effect<void, never, Services>
): Effect.Effect<Run[], TrackerError | StoreError, Services> =>
  Effect.gen(function* () {
    const supplied = yield* decodeRunMeta(meta);
    const store = yield* Store;
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
      const r = all.find(
        r =>
          r.issue !== m.issue &&
          graph.workflows[r.workflow] &&
          !isRetro(graph, r) &&
          findPullNumber(
            graph.workflows[r.workflow]!,
            r.issue,
            m.kind === 'comment' ? issues : [...issues, ...merged]
          ) === m.issue
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
    /** 👀 on the comment that woke a run, or on its issue for a label; the run comes back holding it. */
    const eyes = (run: Run, m: Event): Effect.Effect<Run, StoreError> => {
      if (m.source === 'cli')
        return Effect.gen(function* () {
          const spoken = { ...m, issue: origin.get(m) ?? m.issue };
          const before = yield* Stream.runCollect(store.read(run.id));
          const recorded = before.some(
            t =>
              'spoken' in t &&
              t.spoken.source === 'cli' &&
              t.spoken.at === spoken.at &&
              t.spoken.issue === spoken.issue &&
              t.spoken.comment?.body === spoken.comment?.body
          );
          if (!recorded) yield* store.trace(run.id, { at: m.at, step: run.step, spoken, ...supplied });
          return run;
        });
      if (m.kind !== 'comment' && m.kind !== 'label' && m.kind !== 'column') return Effect.succeed(run);
      const issue = origin.get(m) ?? m.issue;
      const react: Extract<Proposal, { kind: 'react' }> = {
        kind: 'react',
        ...(m.kind === 'comment' &&
          m.comment && {
            comment: m.comment.id,
            ...(m.comment.path !== undefined && { review: true }),
          }),
      };
      return tracker.apply(issue, react).pipe(
        Effect.tap(applied => store.trace(run.id, { at: new Date().toISOString(), step: run.step, applied })),
        Effect.map(a => (a.ok && a.id ? { ...run, eyes: { issue, undo: { ...react, remove: a.id } } } : run)),
        Effect.catchTag('TrackerError', e => Effect.as(Effect.logWarning(`react for run ${run.id}`, e), run))
      );
    };
    const triggered = Object.values(graph.workflows).filter(w => w.on.issue_comment);
    const routed = findRouter(graph) !== undefined;
    /** Whether a trusted event on the issue is younger than `debounce`, so a burst still coming starts nothing yet. */
    const young = (issue: number) =>
      debounce > 0 &&
      latest.some(
        m => (m.issue === issue || onRun(m).issue === issue) && m.trusted && Date.now() - Date.parse(m.at) < debounce
      );
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
          .filter(
            m =>
              !events.some(
                e =>
                  e.source === 'cli' &&
                  e.at === m.at &&
                  (origin.get(e) ?? e.issue) === m.issue &&
                  e.comment?.body === m.comment?.body
              )
          )
          .map(m => {
            const moved = { ...m, issue: run.issue };
            origin.set(moved, m.issue);
            return moved;
          });

        /** A working run takes only a stop here; what else people say reaches it where it works. */
        const taken = (m: Event, lined: Event[] = []) => {
          const o =
            w &&
            getEventOutcome(
              w,
              run,
              tells.includes(m) || (isParked(run) && isQuiet(w)) ? m : getHeardEvent(graph, w, m),
              lined,
              pickCommandTarget(graph, runs, m, tells.includes(m) ? run : undefined)
            );
          return o && (run.status !== 'running' || o.kind === 'stop') ? o : undefined;
        };
        const answers =
          w && !young(run.issue)
            ? [...events, ...pending, ...tells].filter(
                m =>
                  m.issue === run.issue &&
                  m.at > at &&
                  (!isParked(run) || m.at > (trace.at(-1)?.at ?? at)) &&
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
        const seen = makeRunWithFreshRound(w, {
          ...(m.kind === 'comment' && (m.comment?.id || m.source === 'cli') ? yield* eyes(run, m) : run),
          said: heard([m, ...took.filter(a => a !== m)]),
        });
        const step = w.steps.find(s => s.name === run.step);
        const pr = issues.find(t => t.number === findPullNumber(w, run.issue, issues));
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
                    yield* store.trace(run.id, {
                      at: new Date().toISOString(),
                      step: run.step,
                      outcome: { kind: 'ask', question: formatFailure(e) },
                      run: { step: run.step, status: run.status, tries: run.tries, rounds: run.rounds },
                    });
                    if (!run.retried)
                      return {
                        run: { ...run, ...(seen.eyes && { eyes: seen.eyes }), retried: true as const },
                        again: true,
                      };
                    return {
                      run: yield* writeStatus(w, { ...seen, reason: `${stoppedByRunner}.`, retried: true }, graph),
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
            : moved.status === 'running'
              ? moved
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
        const due = !child && parent.reason?.startsWith(stoppedByRunner) && (yield* isRunnerRetryDue(parent.id));
        if (!w || (!child && !due)) return;
        const outcome: Outcome = { kind: 'answer', text: child ? settled(child) : runnerRetry };
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
    /** Begins `w` on `issue`. A restart begins at the step it names, else the first, with the answers of the last run there. */
    const start = (w: Workflow, issue: number, at: string, m?: Event, restart?: string) =>
      Effect.gen(function* () {
        const last = all
          .filter(r => r.issue === issue && r.workflow === w.name)
          .sort((a, b) => a.started.localeCompare(b.started))
          .at(-1);
        const step = w.steps.find(s => s.name === restart);
        const restarts = events.filter(n => {
          const t = n.issue === issue && pickCommandTarget(graph, runs, n);
          return restart !== undefined && !!t && !('why' in t) && t.verb === 'restart';
        });
        const seen = pickNewest(...restarts.map(n => n.at));
        const begun = {
          ...begin(w, { id: makeRunId(w, issue, at), issue, started: at }, step),
          ...supplied,
          ...(seen && seen > at && { seen }),
          ...(m?.kind === 'comment' && { said: heard([m]) }),
          ...(restart !== undefined && last?.answers && { answers: last.answers }),
        };
        const run = yield* startRun(begun.status === 'running' ? begun : { ...begun, unshown: true as const }, run =>
          Effect.flatMap(run.status === 'running' ? Effect.succeed(run) : writeStatus(w, run, graph), r =>
            m ? eyes(r, m) : Effect.succeed(r)
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
      const target = pickCommandTarget(graph, runs, m);
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
          : (sourced ?? (parseAgentRequest(m) !== undefined ? (target?.workflow ?? triggered[0]) : undefined));
      if (!w || (used.has(m) && restart === undefined) || !(sourced || m.trusted) || young(m.issue)) continue;
      if (!open.has(m.issue) && (m.kind !== 'comment' || !isInScope(graph, yield* tracker.issue(m.issue)))) continue;
      /** With a router, a comment concerns only the router's runs; the others hear it through what the router tells them. */
      const concerns = (name: string) => m.kind !== 'comment' || !routed || !!graph.workflows[name]?.on.issue_comment;
      const old =
        restart === undefined &&
        runs.some(
          r =>
            r.issue === m.issue &&
            concerns(r.workflow) &&
            (m.at <= (r.seen ?? r.started) || (sourced && r.workflow === w.name && r.status === 'done'))
        );
      const held =
        restart === undefined
          ? [...busy].some(k => k.endsWith(`#${m.issue}`) && concerns(k.slice(0, k.lastIndexOf('#'))))
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
            return (
              !isRetro(graph, r) && w?.branch !== undefined && branch === formatTemplate(w.branch, { number: r.issue })
            );
          });
          pulls.set(m.issue, by?.issue);
        }
        return pulls.get(m.issue);
      });
    for (const w of Object.values(graph.workflows).filter(w => w.on.feedback)) {
      const heardOn = new Map<number, Event[]>();
      for (const m of latest
        .map(onRun)
        .filter(m => feedback(m) && !('why' in (pickCommandTarget(graph, runs, m) ?? {})))) {
        const issue = yield* workedOn(m);
        if (issue !== undefined && mine({ issue })) heardOn.set(issue, [...(heardOn.get(issue) ?? []), m]);
      }
      for (const [issue, said] of heardOn) {
        const before = all.filter(r => r.issue === issue && r.workflow === w.name);
        if (young(issue)) continue;
        const first = all
          .filter(r => r.issue === issue && !isRetro(graph, r))
          .map(r => r.started)
          .sort()[0];
        const since = pickNewest(first, ...before.map(r => r.started))!;
        const fresh = said.filter(
          m => m.at > since && !touched.some(r => r.issue === issue && r.workflow === w.name && r.seen === m.at)
        );
        if (fresh.length === 0) continue;
        const at = pickNewest(...fresh.map(m => m.at))!;
        const begun: Run = {
          ...begin(w, { id: makeRunId(w, issue, at), issue, started: at }),
          feedback: `## What a person said or pushed\n\n${fresh.map(formatEventLine).join('\n\n')}`,
        };
        if (yield* startRun(begun)) touched.push(begun);
      }
    }

    for (const r of runs.map(current).filter(r => !isRunDone(r))) {
      const w = graph.workflows[r.workflow];
      const head = r.base && issues.find(t => t.number === r.base!.pull)?.pull?.head;
      if (!r.base || !head || !w) continue;
      const tip = issues.find(t => t.number === findPullNumber(w, r.issue, issues))?.pull?.head;
      yield* runFollow(w, r, r.base, head, tip, graph).pipe(
        Effect.catch(e =>
          Effect.gen(function* () {
            yield* Effect.logError(`follow run ${r.id}`, e);
            if (e._tag === 'SandboxError')
              yield* store.trace(r.id, {
                at: new Date().toISOString(),
                step: r.step,
                outcome: { kind: 'ask', question: formatFailure(e) },
                run: { step: r.step, status: r.status, tries: r.tries, rounds: r.rounds },
              });
          })
        )
      );
    }

    for (const before of runs.map(current).filter(r => r.status === 'waiting'))
      yield* Effect.gen(function* () {
        if (!(yield* Effect.isSuccess(store.lock(before.id)))) return;
        const r = yield* store.get(before.id);
        if (!r || r.status !== 'waiting') return;
        const w = graph.workflows[r.workflow];
        const step = w?.steps.find(s => s.name === r.step);
        const pull = w && issues.find(t => t.number === findPullNumber(w, r.issue, issues))?.pull;
        if (!w || !step || !isHumanWaitStep(step) || !pull || all.some(c => c.by === r.id && !isRunDone(c))) return;
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
                  yield* store.trace(r.id, {
                    at: new Date().toISOString(),
                    step: r.step,
                    outcome: { kind: 'ask', question: `Catch-up failed: ${formatFailure(e)}` },
                    run: { step: r.step, status: r.status, tries: r.tries, rounds: r.rounds },
                  });
                  return { run: { ...ready, blocked: { base, head, graph: graph.sha } }, outcome: undefined };
                })
          )
        );
        const next = caught?.outcome && transition(w, caught.run, caught.outcome);
        if (caught?.outcome && next)
          yield* record(
            caught.run,
            caught.outcome,
            next.status === 'running' ? next : yield* writeStatus(w, next, graph)
          );
        else if (caught) yield* store.put(caught.run);
      }).pipe(
        Effect.scoped,
        Effect.catch(e => (e._tag === 'StoreError' ? Effect.fail(e) : Effect.logError(`catch up run ${before.id}`, e)))
      );

    const running = (yield* store.list({ status: 'running' }))
      .filter(mine)
      .filter(r => graph.workflows[r.workflow] && pending(graph.workflows[r.workflow]!, r.issue, issues).length === 0)
      .toSorted((a, b) => a.started.localeCompare(b.started));
    const forkAll = (runs: Run[], f: (r: Run) => Effect.Effect<Run | undefined, StoreError, Services>) =>
      Effect.as(
        Effect.forEach(runs, r => fork!(r.id, graph.limits.parallel, f(r).pipe(Effect.catch(logged(r))))),
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
    const look = (n: number, meta?: Run['meta']) =>
      tick(
        graph,
        n,
        true,
        debounce,
        meta,
        fork && ((id, parallel, effect) => fork(id, parallel, Effect.provideService(effect, Tracker, tracker)))
      ).pipe(
        Effect.provideService(Tracker, {
          ...tracker,
          issue: n => {
            const found = fetched.find(
              (t): t is Effect.Success<ReturnType<Tracker['Service']['issue']>> => t.number === n && 'events' in t
            );
            return found
              ? Effect.succeed(found)
              : tracker.issue(n).pipe(Effect.tap(t => Effect.sync(() => fetched.push(t))));
          },
          issues: filter =>
            filter?.state === 'open' &&
            !filter.labels?.length &&
            filter.parent === undefined &&
            filter.branch === undefined
              ? listing
              : tracker.issues(filter),
          since: at => Stream.fromIterableEffect(at < cursor ? history : latest).pipe(Stream.filter(m => m.at > at)),
          apply: (...args) =>
            tracker
              .apply(...args)
              .pipe(
                Effect.tap(a =>
                  a.ok && ['issue', 'pull_request', 'merge', 'label', 'push', 'rebase'].includes(a.proposal.kind)
                    ? invalidate
                    : Effect.void
                )
              ),
        }),
        Effect.catchTag('TrackerError', e => Effect.as(Effect.logError(`look at #${n}`, e), []))
      );
    return { all, listed, latest, fetched, look };
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
    const asked = said.filter(m => m.trusted && parseAgentRequest(m) !== undefined).map(m => m.issue);
    const issues = [...new Set([...runs.map(r => r.issue), ...asked, ...open.map(t => t.number)])];
    const changed = (yield* Effect.forEach(issues, n => getGate(gates, n).withPermits(1)(look(n, meta)), {
      concurrency: graph.limits.parallel,
    })).flat();
    const sandbox = yield* Sandbox;
    const branches = yield* sandbox
      .readBranches()
      .pipe(Effect.catch(e => Effect.as(Effect.logWarning('local branches', e), [])));
    const kept = yield* Effect.flatMap(Store, s => s.list());
    const uses = (branch: string) => (r: Run) => {
      if (r.checkout) return r.checkout.branch === branch;
      const template = graph.workflows[r.workflow]?.branch;
      return (
        branch.split(/\D+/).includes(String(r.issue)) ||
        (!!template && matchesGlob(branch, template.replaceAll('{issue}', String(r.issue)).replaceAll('{parent}', '*')))
      );
    };
    const cleanBranch = (branch: string, using: Run[]) =>
      Effect.gen(function* () {
        const current = (yield* Effect.forEach([...new Set(using.map(r => r.issue))], issue =>
          Effect.flatMap(Store, s => s.list({ issue }))
        )).flat();
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
      const latest = yield* Effect.cached(
        lower === cursor ? Effect.succeed(events) : Stream.runCollect(tracker.since(lower, isBoardGraph(graph)))
      );
      const scan = yield* Effect.cached(readIssueScan(graph, issueDebounceMs, fork, { cursor: lower, latest }));
      const issues = new Set([...trusted.map(m => m.issue), ...due.keys()]);
      if (trusted.length) {
        const { all, listed, fetched } = yield* scan;
        const missing = yield* Effect.forEach(
          [...issues].filter(n => !listed.some(t => t.number === n)),
          n => tracker.issue(n),
          { concurrency: graph.limits.parallel }
        );
        fetched.push(...missing);
        for (const r of all) {
          const w = graph.workflows[r.workflow];
          const pull = w && findPullNumber(w, r.issue, fetched);
          if (pull !== undefined && issues.has(pull)) issues.add(r.issue);
        }
      }
      yield* Effect.forEach(
        issues,
        n =>
          getGate(gates, n)
            .withPermitsIfAvailable(1)(
              Effect.gen(function* () {
                const { look, fetched, all } = yield* scan;
                yield* look(n);
                const pulls = new Set(
                  all
                    .filter(r => r.issue === n)
                    .flatMap(r => {
                      const w = graph.workflows[r.workflow];
                      const pull = w && findPullNumber(w, n, fetched);
                      return pull === undefined ? [] : [pull];
                    })
                );
                const recent = yield* latest;
                return recent.some(
                  m =>
                    m.trusted &&
                    (m.issue === n || pulls.has(m.issue)) &&
                    Date.now() - Date.parse(m.at) < issueDebounceMs
                );
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

export const startLoopDrives = () => {
  const scope = Scope.makeUnsafe();
  return {
    passes: Effect.runSync(Scope.provide(FiberSet.make(), scope)),
    driving: new Set<string>(),
    gates: new Map<number, Semaphore.Semaphore>(),
    due: new Map<number, string>(),
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
            drives.permits.resize(parallel),
            Effect.suspend(() => {
              if (drives.driving.has(id)) return Effect.void;
              drives.driving.add(id);
              return FiberSet.run(
                own,
                effect.pipe(
                  drives.permits.withPermits(1),
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
