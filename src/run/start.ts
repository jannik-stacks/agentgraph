import { Effect } from 'effect';
import type { Said, Proposal } from '../proposal.ts';
import { type TrackerError, Tracker, withheld } from '../tracker.ts';
import { type Workflow, type Run, type RunRecord, begin, isRunDone } from '../workflow.ts';
import type { Applied } from '../event.ts';
import { Store } from '../store.ts';
import { LockHeldError } from '../owner.ts';
import type { Graph } from '../folder.ts';
import { findAppliedBefore, getOperationKey, writeOnce, useRunLink } from './settle.ts';
import { isInScope, isRetro } from './hear.ts';

export const makeRunId = (w: Pick<Workflow, 'name'>, issue: number, at: string) =>
  `${w.name}-${issue}-${at.replace(/\D/g, '')}`;

export type Child = Extract<Said, { kind: 'issue' }>;

/** Saves a new run once, under its id's lock and only when no run has that id, then lets `ready` finish it under that lock. */
export const startRun = <A extends RunRecord, E = never, R = never>(
  run: A,
  ready: (run: A) => Effect.Effect<A, E, R> = Effect.succeed
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const locked = yield* store.lock(run.id).pipe(
      Effect.as(true),
      Effect.catchIf(
        e => e.cause instanceof LockHeldError,
        () => Effect.succeed(false)
      )
    );
    if (!locked) return;
    if (yield* store.getRecord(run.id)) return;
    yield* store.put(run);
    const first = yield* ready(run);
    if (first !== run) yield* store.put(first);
    return first;
  }).pipe(Effect.scoped);

export const isPart = (p: Child): p is Extract<Child, { relation: 'part' }> => p.relation === 'part';

/** How deep a run's issue may sit and still file children. */
const deepest = 3;

/** How many parents sit above issue `n`, counted up to `deepest`. */
const findIssueDepth = (n: number, above = 0): Effect.Effect<number, TrackerError, Tracker> =>
  Effect.flatMap(Tracker, f => f.issue(n)).pipe(
    Effect.flatMap(t =>
      t.parent === undefined || above >= deepest ? Effect.succeed(above) : findIssueDepth(t.parent, above + 1)
    )
  );

export const createIssues = (w: Workflow, run: Run, children: Child[]) =>
  Effect.gen(function* () {
    if (children.length === 0) return [];
    const tracker = yield* Tracker;
    const issue = yield* tracker.issue(run.issue);
    const depth = yield* findIssueDepth(run.issue);
    const open = new Map((yield* tracker.issues({ state: 'open' })).map(t => [t.title.trim().toLowerCase(), t.number]));
    const cached = yield* Effect.forEach(children, (p, i) =>
      findAppliedBefore(
        run,
        run.issue,
        getOperationKey(run, run.issue, p, `file:${i}`),
        isPart(p) ? { kind: 'issue', title: p.title, body: p.body } : undefined
      )
    );
    const refusal = (p: Child, i: number) => {
      if (issue.body === withheld(issue.author, 'issue text')) return `#${run.issue} is withheld text from an outsider`;
      if (isPart(p) && open.has(p.title.trim().toLowerCase()) && !cached[i])
        return `${p.title}: an open issue has this title`;
      if (!/^#+\s*done when\b/im.test(p.body)) return `${p.title}: say when it is done under a "Done when" heading`;
      if (!isPart(p)) return;
      if (depth >= deepest) return `#${run.issue} sits ${depth} issues deep; split it by hand`;
      const named = [...(p.stacks_on === undefined ? [] : [p.stacks_on]), ...(p.depends_on ?? [])];
      if (named.some(k => k < 1 || k > i))
        return `${p.title}: stacks_on and depends_on name an earlier issue here by position`;
    };
    const refused = children.flatMap((p, i): Applied[] => {
      const reason = refusal(p, i);
      return reason === undefined ? [] : [{ proposal: p, ok: false, reason }];
    });
    if (refused.length > 0) return refused;

    const applied: Applied[] = [];
    const numbers: number[] = [];
    for (const [i, p] of children.entries()) {
      const key = getOperationKey(run, run.issue, p, `file:${i}`);
      if (cached[i]) {
        const a = cached[i]!;
        applied.push(a);
        numbers.push(a.proposal.kind === 'issue' ? Number(a.id) : a.issue!);
        continue;
      }
      const lines = isPart(p)
        ? [
            ...(p.stacks_on === undefined ? [] : [`Stacks on #${numbers[p.stacks_on - 1]}`]),
            ...(p.depends_on ?? []).map(k => `Depends on #${numbers[k - 1]}`),
          ]
        : [`Found while working on #${run.issue}`];
      const same = isPart(p) ? undefined : open.get(p.title.trim().toLowerCase());
      if (same !== undefined) {
        const comment: Proposal = { kind: 'comment', body: [p.body, ...lines].join('\n\n') };
        applied.push(yield* writeOnce(run, same, key, tracker.apply(same, comment), comment));
        numbers.push(same);
        continue;
      }
      const filed: Proposal = {
        kind: 'issue',
        title: p.title,
        body: [p.body, ...(lines.length > 0 ? [lines.join('\n')] : [])].join('\n\n'),
        ...(isPart(p) ? { parent: run.issue, labels: [`size/${p.size}`] } : { labels: [p.relation] }),
      };
      const a = yield* writeOnce(run, run.issue, key, tracker.apply(run.issue, filed), filed);
      applied.push(a);
      if (!a.ok) break;
      numbers.push(Number(a.id));
    }
    const parts = numbers.filter((_, i) => isPart(children[i]!));
    if (parts.length === 0) return applied;
    const summary: Proposal = { kind: 'comment', body: `Split into:\n\n${parts.map(n => `- [ ] #${n}`).join('\n')}` };
    applied.push(
      yield* writeOnce(
        run,
        run.issue,
        getOperationKey(run, run.issue, summary, 'file-summary'),
        tracker.apply(run.issue, summary),
        summary
      )
    );
    for (const [i, n] of numbers.entries()) {
      const p = children[i]!;
      if (!isPart(p) || p.size !== 'XL' || depth + 1 >= deepest) continue;
      const at = new Date().toISOString();
      yield* startRun(begin(w, { id: makeRunId(w, n, at), issue: n, started: at }));
    }
    return applied;
  }).pipe(useRunLink(run));

/** The open follow-up and graph issues, so an agent adds to one by its title instead of filing it again. */
export const readFiledIssues = () =>
  Effect.map(
    Effect.flatMap(Tracker, f => f.issues({ state: 'open' })),
    open => {
      const listed = open.filter(t => t.labels.some(l => l === 'follow-up' || l === 'graph'));
      return (
        listed.length > 0 &&
        `Open follow-up and graph issues. To add to one, propose an issue with its exact title:\n${listed.map(t => `- #${t.number} ${t.title}`).join('\n')}`
      );
    }
  );

/** The reason a run waits while a run it started works. */
export const formatWaitingOn = (child: Run) => `waiting on ${child.id}`;

/**
 * Why the `run` proposals may not start: one at a time, on an open issue in scope that no other live run holds. An agent
 * may start only a workflow with `on: dispatch`, a human any workflow.
 */
export const findUndispatchable = (
  graph: Graph,
  run: Pick<Run, 'id'>,
  asked: Extract<Proposal, { kind: 'run' }>[],
  isHuman = false
) =>
  Effect.gen(function* () {
    const [p] = asked;
    if (!p) return [];
    const w = graph.workflows[p.workflow];
    const issue = (yield* Effect.flatMap(Tracker, f => f.issues({ state: 'open' }))).find(t => t.number === p.issue);
    const held = (yield* Effect.flatMap(Store, s => s.list({ issue: p.issue }))).some(
      r => !isRunDone(r) && r.id !== run.id
    );
    const reason =
      asked.length > 1
        ? 'propose one run at a time'
        : !w
          ? `the graph has no workflow ${p.workflow}`
          : !isHuman && !w.on.dispatch
            ? `${p.workflow} is not a workflow with on: dispatch`
            : !issue || issue.pull
              ? `#${p.issue} is not an open issue`
              : !isInScope(graph, issue)
                ? `#${p.issue} is outside the graph milestone`
                : held
                  ? `a live run holds #${p.issue}`
                  : undefined;
    return reason === undefined ? [] : asked.map((proposal): Applied => ({ proposal, ok: false, reason }));
  });

/** Begins the workflow a `run` proposal names, as a run `by` the run that proposed it, seeded with `seed`. A taken id gets a fresh one, a few times, then nothing starts. */
export const startProposedRun = (
  graph: Graph,
  run: Pick<Run, 'id'>,
  p: Extract<Proposal, { kind: 'run' }>,
  seed?: Pick<Run, 'onto' | 'feedback' | 'said' | 'meta'>
) =>
  Effect.gen(function* () {
    const w = graph.workflows[p.workflow]!;
    for (let tries = 0; tries < 3; tries++) {
      const at = new Date().toISOString();
      const child: Run = {
        ...begin(
          w,
          { id: makeRunId(w, p.issue, at), issue: p.issue, started: at },
          w.steps.find(s => s.name === p.step)
        ),
        by: run.id,
        ...seed,
      };
      const started = yield* startRun(child);
      if (started) return started;
      yield* Effect.sleep('1 millis');
    }
    return undefined;
  });

export const findRecipient = (graph: Graph, issue: number, by: string) =>
  Effect.flatMap(Store, s =>
    s.list({ issue }).pipe(
      Effect.map(rs => rs.filter(r => !isRunDone(r) && r.id !== by)),
      Effect.map(rs => rs.find(r => !isRetro(graph, r)) ?? rs[0])
    )
  );

/** Passes trusted text to the live run `to`, as a router proposal. */
export const writeTold = (to: Run, text: string, by: string) =>
  Effect.as(
    Effect.flatMap(Store, s => s.trace(to.id, { at: new Date().toISOString(), step: to.step, told: { text, by } })),
    to
  );
