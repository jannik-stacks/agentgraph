import { Effect, Stream } from 'effect';
import type { Issue, Event } from '../event.ts';
import type { Graph } from '../folder.ts';
import { type Workflow, type Run, isRunDone, isQuiet, getEventOutcome, fold } from '../workflow.ts';
import type { IssueWithPull } from '../context.ts';
import { type TrackerError, Tracker } from '../tracker.ts';
import { type StoreError, Store } from '../store.ts';
import { makeContinuedMeta } from '../meta.ts';
import { getStepReturns } from '../graph.ts';

export const formatTemplate = (template: string, t: Pick<Issue, 'number' | 'parent'>) =>
  template.replaceAll('{issue}', String(t.number)).replaceAll('{parent}', String(t.parent ?? ''));

/** Whether a new run may start on an issue: always without a graph milestone, else only in it. */
export const isInScope = (graph: Graph, issue?: Issue) =>
  graph.milestone === undefined || issue?.milestone === graph.milestone;

/** The open pull request on the branch a run of `w` on `issue` works on. */
export const findPullNumber = (w: Workflow, issue: number, open: Issue[]) =>
  w.branch === undefined
    ? undefined
    : open.find(
        t =>
          t.pull?.branch.replace(/^bothub\//, 'agentgraph/') ===
          formatTemplate(w.branch!, open.find(t => t.number === issue) ?? { number: issue })
      )?.number;

/** The run's issue and the pull request on its branch, or for a run with no branch the one it was asked on, fetched before every session. */
export const readIssueWithPull = (
  w: Workflow,
  run: Run
): Effect.Effect<IssueWithPull, TrackerError | StoreError, Tracker | Store> =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const issue = yield* tracker.issue(run.issue);
    const pull = issue.pull
      ? undefined
      : w.branch === undefined
        ? run.said?.find(s => s.issue !== run.issue)?.issue
        : findPullNumber(w, run.issue, yield* tracker.issues(isRunDone(run) ? {} : { state: 'open' }));
    const spoken = (yield* Stream.runCollect((yield* Store).read(run.id))).flatMap(t =>
      'spoken' in t ? [t.spoken] : []
    );
    const review = pull !== undefined ? yield* tracker.issue(pull) : undefined;
    return {
      issue: { ...issue, events: [...issue.events, ...spoken.filter(m => m.issue !== review?.number)] },
      ...(review && {
        pull: { ...review, events: [...review.events, ...spoken.filter(m => m.issue === review.number)] },
      }),
    };
  });

export const pickNewest = (...times: (string | undefined)[]) =>
  times
    .filter(t => t !== undefined)
    .toSorted()
    .at(-1);

/** What the comment workflow told `run`, each as a trusted comment that speaks to it. */
export const readRunEvents = (run: Run) =>
  Effect.flatMap(Store, store => Stream.runCollect(store.read(run.id))).pipe(
    Effect.map(lines =>
      lines.flatMap((t): Event[] =>
        'told' in t
          ? [
              {
                issue: run.issue,
                kind: 'comment',
                actor: t.told.by,
                trusted: true,
                at: t.at,
                comment: { id: '', author: t.told.by, body: t.told.text, at: t.at, agentRequest: t.told.text },
              },
            ]
          : []
      )
    )
  );

export const readContinuedRun = (run: Run, events: Event[]) =>
  Effect.gen(function* () {
    if (!events.some(event => event.source === 'cli')) return run;
    const lines = yield* Stream.runCollect((yield* Store).read(run.id));
    const accepted = lines
      .flatMap(line =>
        'spoken' in line &&
        line.meta &&
        events.some(
          event =>
            event.source === 'cli' &&
            line.spoken.source === 'cli' &&
            event.issue === line.spoken.issue &&
            event.at === line.spoken.at &&
            event.comment?.id === line.spoken.comment?.id &&
            event.comment?.body === line.spoken.comment?.body
        )
          ? [{ meta: line.meta, at: line.spoken.at }]
          : []
      )
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .at(-1);
    return accepted ? { ...run, meta: makeContinuedMeta(run.meta, accepted.meta, accepted.at) } : run;
  });

/** The comment workflow whose agent may `tell`, which then hears every `/agent` on behalf of the other runs. */
export const findRouter = (graph: Graph) =>
  Object.values(graph.workflows).find(
    w => w.on.issue_comment && w.steps.some(s => getStepReturns(s, graph.agents).includes('tell'))
  );

/** The event as a run of `w` hears it: with a router, only the router hears `/agent` from people, the others hear what it tells them. */
export const getHeardEvent = (graph: Graph, w: Workflow, m: Event): Event => {
  if (!findRouter(graph) || w.on.issue_comment || m.comment?.agentRequest === undefined) return m;
  const { agentRequest: _agentRequest, ...comment } = m.comment;
  return { ...m, comment };
};

/** What people said to a live run on its issue and pull request since it last looked, as one outcome, and when the newest of it was said. */
export const readHeardOutcome = (graph: Graph, w: Workflow, run: Run, t: IssueWithPull) =>
  Effect.map(readRunEvents(run), tells => {
    if (isQuiet(w)) return undefined;
    const since = run.seen ?? run.started;
    const said = [...[...t.issue.events, ...(t.pull?.events ?? [])].map(m => getHeardEvent(graph, w, m)), ...tells]
      .filter(m => m.at > since)
      .flatMap(m => {
        const o = getEventOutcome(w, run, { ...m, issue: run.issue });
        return o ? [{ o, at: m.at, event: m }] : [];
      });
    const outcome = fold(said.map(s => s.o));
    return outcome && { outcome, at: pickNewest(...said.map(s => s.at))!, events: said.map(s => s.event) };
  });

/** Whether a run is a retro, a run of a workflow that feedback starts. */
export const isRetro = (graph: Graph, r: Pick<Run, 'workflow'>) => !!graph.workflows[r.workflow]?.on.feedback;
