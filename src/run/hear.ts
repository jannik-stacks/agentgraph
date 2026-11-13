import { Effect, Stream } from 'effect';
import type { Issue, Event } from '../event.ts';
import { getSha } from '../hash.ts';
import type { Graph } from '../folder.ts';
import {
  type Workflow,
  formatTemplate,
  isRunDone,
  isQuiet,
  getEventOutcome,
  fold,
  pickCommandTarget,
} from '../workflow.ts';
import { type IssueWithPull, getEvents } from '../context.ts';
import { Tracker, findBranchPull, parseAgentRequest } from '../tracker.ts';
import { Store } from '../store.ts';
import { makeContinuedMeta } from '../meta.ts';
import { getStepReturns } from '../graph.ts';
import { type Run, type StoreError, type Trace, type TrackerError } from '../types.ts';

export const isInScope = (graph: Graph, issue?: Issue) =>
  graph.milestone === undefined || issue?.milestone === graph.milestone;

export const isBoardGraph = (graph: Graph) => Object.values(graph.workflows).some(w => w.on.issues?.column);

export const formatRunBranch = (
  w: Pick<Workflow, 'branch'> | undefined,
  run: Pick<Run, 'issue' | 'checkout'>,
  issues: Issue[] = []
) =>
  run.checkout?.branch ??
  (w?.branch === undefined
    ? undefined
    : formatTemplate(w.branch, issues.find(t => t.number === run.issue) ?? { number: run.issue }));

export const readEarlierBranch = (w: Workflow, run: Run, named: string) =>
  Effect.gen(function* () {
    const before = (yield* (yield* Store).list({ issue: run.issue }))
      .filter(r => r.workflow === w.name && r.id !== run.id && r.started < run.started && r.checkout?.branch)
      .toSorted((a, b) => a.started.localeCompare(b.started))
      .at(-1);
    const branch = before?.checkout?.branch ?? named;
    const pull = findBranchPull(yield* (yield* Tracker).issues({ branch }), branch);
    return { before, branch, pull };
  });

const readWorkedPull = (graph: Graph, issue: Issue) =>
  Effect.gen(function* () {
    const branch = (yield* (yield* Store).list({ issue: issue.number }))
      .flatMap(r => {
        const branch = formatRunBranch(graph.workflows[r.workflow], r, [issue]);
        return branch === undefined ? [] : [{ started: r.started, branch }];
      })
      .toSorted((a, b) => a.started.localeCompare(b.started))
      .at(-1)?.branch;
    return branch === undefined
      ? undefined
      : findBranchPull(yield* (yield* Tracker).issues({ branch }), branch)?.number;
  });

export const readIssueWithPull = (
  w: Workflow,
  run: Run,
  graph: Graph
): Effect.Effect<IssueWithPull, TrackerError | StoreError, Tracker | Store> =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const issue = yield* tracker.issue(run.issue);
    const pull = issue.pull
      ? undefined
      : w.branch === undefined
        ? (run.said?.find(s => s.issue !== run.issue)?.issue ??
          (w.on.feedback ? yield* readWorkedPull(graph, issue) : undefined))
        : yield* Effect.map(
            tracker.issues(isRunDone(run) ? {} : { state: 'open' }),
            issues => findBranchPull(issues, formatRunBranch(w, run, issues))?.number
          );
    const spoken = (yield* Stream.runCollect((yield* Store).read(run.id))).flatMap(t =>
      'spoken' in t && t.spoken.source === 'cli' ? [t.spoken] : []
    );
    const review = pull !== undefined ? yield* tracker.issue(pull) : undefined;
    return {
      issue: { ...issue, events: [...issue.events, ...spoken.filter(m => m.issue !== review?.number)] },
      ...(review && {
        pull: { ...review, events: [...review.events, ...spoken.filter(m => m.issue === review.number)] },
      }),
    };
  });

const getEventKey = (m: Event) =>
  getSha(
    JSON.stringify([
      m.issue,
      m.id,
      m.kind,
      m.comment?.body,
      m.comment?.edited,
      m.label,
      m.reviewer,
      m.column?.name,
      m.commit?.title,
      m.check?.conclusion,
    ])
  );

export const writeHeardEvents = (run: Pick<Run, 'id' | 'step'>, events: readonly Event[], since?: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const lines = yield* Stream.runCollect(store.read(run.id));
    const known = new Set(lines.flatMap(t => ('spoken' in t ? [getEventKey(t.spoken)] : [])));
    const heard = new Map(events.filter(m => m.source !== 'cli').map(m => [getEventKey(m), m]));
    const at = new Date().toISOString();
    const added: Trace[] = [
      ...(lines.some(t => 'inputs' in t) ? [] : [{ at, step: run.step, inputs: { since: since ?? at } }]),
      ...[...heard].flatMap(([key, spoken]) => (known.has(key) ? [] : [{ at, step: run.step, spoken }])),
    ];
    if (added.length) yield* store.trace(run.id, ...added);
  });

export const pickNewest = (...times: (string | undefined)[]) =>
  times
    .filter(t => t !== undefined)
    .toSorted()
    .at(-1);

export const makeToldEvent = (issue: number, told: { text: string; by: string }, at: string): Event => ({
  id: `told-${at}`,
  issue,
  kind: 'comment',
  actor: told.by,
  bot: false,
  trusted: true,
  at,
  comment: { id: '', author: told.by, body: told.text, at, agentRequest: parseAgentRequest(told.text) },
});

export const readRunEvents = (run: Run) =>
  Effect.flatMap(Store, store => Stream.runCollect(store.read(run.id))).pipe(
    Effect.map(lines => lines.flatMap((t): Event[] => ('told' in t ? [makeToldEvent(run.issue, t.told, t.at)] : [])))
  );

export const readContinuedRun = (run: Run, events: Event[]) =>
  Effect.gen(function* () {
    if (!events.some(event => event.source === 'cli')) return run;
    const lines = yield* Stream.runCollect((yield* Store).read(run.id));
    const accepted = lines
      .flatMap(line =>
        'spoken' in line &&
        line.meta &&
        line.spoken.source === 'cli' &&
        events.some(event => event.source === 'cli' && event.id === line.spoken.id)
          ? [{ meta: line.meta, at: line.spoken.at }]
          : []
      )
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .at(-1);
    return accepted ? { ...run, meta: makeContinuedMeta(run.meta, accepted.meta, accepted.at) } : run;
  });

export const findRouter = (graph: Graph) =>
  Object.values(graph.workflows).find(
    w => w.on.issue_comment && w.steps.some(s => getStepReturns(s, graph.agents).includes('tell'))
  );

export const getHeardEvent = (router: string | undefined, w: Workflow, m: Event): Event => {
  if (!router || w.on.issue_comment || !m.comment?.agentRequest || m.comment.agentRequest.command) return m;
  const { agentRequest: _agentRequest, ...comment } = m.comment;
  return { ...m, comment };
};

export const isHeardBy = (graph: Graph, name: string, m: Pick<Event, 'kind'>) =>
  m.kind !== 'comment' || !findRouter(graph) || !!graph.workflows[name]?.on.issue_comment;

export const readHeardOutcome = (graph: Graph, w: Workflow, run: Run, t: IssueWithPull) =>
  Effect.gen(function* () {
    if (isQuiet(w)) return undefined;
    const router = findRouter(graph)?.name;
    const tells = yield* readRunEvents(run);
    const runs = yield* Effect.flatMap(Store, s => s.list({ issue: run.issue }));
    const since = run.seen ?? run.started;
    const fresh = [...getEvents(t).map(m => getHeardEvent(router, w, m)), ...tells].filter(m => m.at > since);
    const said = fresh.flatMap(m => {
      const heard = { ...m, issue: run.issue };
      const o = getEventOutcome(
        w,
        run,
        heard,
        fresh,
        pickCommandTarget(graph, runs, heard, router, tells.includes(m) ? run : undefined)
      );
      return o ? [{ o, at: m.at, event: m }] : [];
    });
    const outcome = fold(said.map(s => s.o));
    return outcome && { outcome, at: pickNewest(...said.map(s => s.at))!, events: said.map(s => s.event) };
  });

export const isRetro = (graph: Graph, r: Pick<Run, 'workflow'>) => !!graph.workflows[r.workflow]?.on.feedback;

const settledLookbackMs = 86_400_000;

export const findSettledRuns = (graph: Graph, w: Pick<Workflow, 'name' | 'on'>, all: Run[]) => {
  const router = findRouter(graph)?.name;
  return all.filter(r => {
    const since = pickNewest(...all.filter(o => o.issue === r.issue && o.workflow === w.name).map(o => o.started));
    return (
      !!graph.workflows[r.workflow] &&
      !isRetro(graph, r) &&
      r.workflow !== router &&
      isRunDone(r) &&
      (!r.restarted || !!w.on.feedback?.restarts) &&
      r.ended !== undefined &&
      r.ended > (since ?? '') &&
      Date.parse(r.ended) > Date.now() - settledLookbackMs
    );
  });
};
