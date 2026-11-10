import { Effect, Option, Stream } from 'effect';
import { Sandbox } from '../sandbox.ts';
import { readGit, gitIdentity, writeCheckoutTree, hostGit, mergeTreeOnto } from '../git.ts';
import { type Workflow, isRunDone, isHumanWaitStep, formatFailedTryFeedback } from '../workflow.ts';
import type { Graph } from '../folder.ts';
import { Store } from '../store.ts';
import { Tracker } from '../tracker.ts';
import type { Issue, Applied } from '../event.ts';
import type { Proposal } from '../proposal.ts';
import { context, getEvents, formatSqueezed } from '../context.ts';
import { getStepReturns } from '../graph.ts';
import { formatRunBranch, readIssueWithPull, writeHeardEvents } from './hear.ts';
import { writeAppliedTrace, writeStatus, removeThreads, writeProposals, useRunLink } from './settle.ts';
import { startProposedRun } from './start.ts';
import { runSetup } from './checkout.ts';
import { runStepChecks } from './check.ts';
import { shapes, parseProposals, findUngranted } from './attempt.ts';
import { makeAgentSessionSpec, runSession } from './execute.ts';
import { type Checkout, type Run, SessionStop } from '../types.ts';

/** A checkout measured from `onto`; on a first try its files become the branch merged onto it, conflicts marked. */
export const moveCheckoutOnto = (work: Checkout, onto: string, first: boolean) =>
  Effect.gen(function* () {
    const tip = work.head ?? work.base;
    if (first && (yield* readGit(work.git, ['merge-base', onto, tip])) !== onto) {
      const head = yield* readGit(work.git, [
        ...gitIdentity,
        'commit-tree',
        yield* writeCheckoutTree(work),
        '-p',
        tip,
        '-m',
        'Saved work',
      ]);
      yield* hostGit(work.git, ['read-tree', '-u', '--reset', (yield* mergeTreeOnto(work, onto, head)).tree]);
    }
    work.base = onto;
    return work;
  });

/** Rebases a stacked branch onto its parent's head; a branch not pushed yet only takes the new head as its base. */
export const runFollow = (
  w: Workflow,
  given: Run,
  known: NonNullable<Run['base']>,
  head: string,
  tip: string | undefined,
  graph: Graph
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const tracker = yield* Tracker;
    if (!(yield* Effect.isSuccess(store.lock(given.id)))) return;
    const run = (yield* store.get(given.id)) ?? given;
    if (isRunDone(run)) return;
    const base = run.base ?? known;
    const seen = tip ?? '';
    if (base.sha === head && (!base.from || base.tip === seen)) return;
    const from = base.from ?? base.sha;
    const branch = formatRunBranch(w, run, [yield* tracker.issue(run.issue)])!;
    const work = yield* Effect.flatMap(Sandbox, s => s.checkout(base.branch, branch));
    const applied = work.head && (yield* tracker.apply(run.issue, { kind: 'rebase', branch, from, onto: head }, work));
    if (applied) yield* store.trace(run.id, { at: new Date().toISOString(), step: run.step, applied });
    const failed = applied && !applied.ok ? applied : undefined;
    const refused = failed?.moved
      ? (yield* Stream.runCollect(store.read(run.id))).filter(
          t =>
            'applied' in t &&
            t.applied.moved &&
            t.applied.proposal.kind === 'rebase' &&
            t.applied.proposal.onto === head
        ).length
      : 0;
    const stuck = `#${base.pull} moved and ${branch} could not follow`;
    const { from: _pending, tip: _tip, ...rest } = base;
    const { reason, ...kept } = run;
    const asked = reason?.split(stuck)[0]!.trimEnd();
    const body = failed && `${stuck}: ${failed.reason}. Rebase it by hand, or say what to do.`;
    const said = [asked, body].filter(Boolean).join('\n\n');
    yield* store.put(
      yield* writeStatus(
        w,
        {
          ...kept,
          ...(said && { reason: said }),
          base: {
            ...rest,
            sha: head,
            ...(failed && { from, ...((!failed.moved || refused >= 3) && { tip: seen }) }),
          },
        },
        graph
      )
    );
  }).pipe(Effect.scoped);

export const readBaseGain = (git: Checkout['git'], base: string, from: string, onto: string) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const log = yield* readGit(git, ['log', '--no-decorate', '--format=%h %s%n%b', `${from}..${onto}`]);
    const diff = yield* readGit(git, ['diff', '--no-color', '--no-ext-diff', '--text', from, onto]);
    const read = (numbers: number[]) =>
      Effect.map(
        Effect.forEach([...new Set(numbers)].slice(0, 10), n => Effect.option(tracker.issue(n))),
        found => found.flatMap(o => (Option.isSome(o) ? [o.value] : []))
      );
    const named = yield* read([...log.matchAll(/(?<![\w/])#(\d+)\b/g)].map(m => Number(m[1])));
    const closed = yield* read(
      named
        .flatMap(t => (t.pull ? [...t.body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)/gi)] : []))
        .map(m => Number(m[1]))
        .filter(n => !named.some(t => t.number === n))
    );
    return [
      '## What the base gained',
      `${base} moved from ${from.slice(0, 7)} to ${onto.slice(0, 7)} since this change was written. Read why before you judge or change anything that touches it.`,
      ...[...named, ...closed].map(
        t => `### #${t.number} ${t.title} (${t.pull ? 'pull request' : 'issue'})\n\n${formatSqueezed(t.body, 4000)}`
      ),
      `### Commits\n\n${formatSqueezed(log, 8000)}`,
      `### Diff\n\n\`\`\`diff\n${formatSqueezed(diff, 60_000)}\n\`\`\``,
    ].join('\n\n');
  });

/**
 * Brings a run waiting on a human, or done with its pull request open, up to what is current: the head of its pull
 * request's base, and the graph. A run waiting at another step only follows its base as its workflow's last human
 * step would, and its next session hears what the base gained. A branch behind its base follows it with no model, by
 * a merge or a rebase as the step's `follow` says, or stays where it is when that says none. When the change stays the
 * same, the step's own checks run again, scripts first and judged ones only once those pass; a changed change or a
 * new graph runs every check of the step it goes back to. Judges read what the base gained. A failed check sends the
 * run back as a request for changes would, with what the base gained. A conflict does what the step's `conflict`
 * says: go back to start on the new base with markers left, start that `conflict` workflow there while the run
 * waits, or ask; when that already happened for this base head, it is said on the issue once. The followed range is
 * kept on the run until its checks decide. What the base gained is the pull requests and issues its commits name, the issues those pull
 * requests close, the commits and their diff. Undefined when nothing moved.
 */
export const runCatchUp = (w: Workflow, run: Run, graph: Graph, pull: NonNullable<Issue['pull']>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const tracker = yield* Tracker;
    const at = w.steps.find(s => s.name === run.step)!;
    const waits = run.status === 'waiting' && isHumanWaitStep(at);
    const checked = waits || run.status === 'done';
    const step = waits ? at : w.steps.findLast(isHumanWaitStep)!;
    const to = w.steps.find(s => s.name === step.back?.to);
    const { ready: _, ...made } = yield* Effect.flatMap(Sandbox, s =>
      s.checkout(pull.base, undefined, undefined, graph)
    );
    const work = { ...made, head: pull.head };
    const onto = work.base;
    const from = yield* readGit(work.git, ['merge-base', pull.head, onto]);
    const behind = step.follow !== 'none' && !run.base && from !== onto;
    const pending = checked && run.moved?.onto === onto ? run.moved : undefined;
    const renewed = waits && (run.blocked !== undefined || (run.graph ?? graph.sha) !== graph.sha);
    const { blocked: _blocked, moved: _moved, ...current } = { ...removeThreads(run), graph: graph.sha };
    const reopened = waits ? current : { ...current, step: step.name, status: 'waiting' as const };
    if (!behind && !renewed && !pending)
      return run.graph ? undefined : { run: { ...current, ...(run.moved && { moved: run.moved }) } };
    let same = false;
    let since = pending?.from;
    if (behind) {
      const merge = step.follow !== 'rebase';
      const branch = pull.branch;
      const verb = merge ? 'merges with' : 'rebases onto';
      const proposal: Proposal = merge
        ? {
            kind: 'push',
            branch,
            message: `Merge ${pull.base} into ${branch}`,
            onto,
            merge: true,
          }
        : { kind: 'rebase', branch, from, onto };
      const tried = (yield* Stream.runCollect(store.read(run.id))).filter(
        t => 'applied' in t && !t.applied.ok && 'onto' in t.applied.proposal && t.applied.proposal.onto === onto
      ).length;
      const conflict =
        step.conflict ?? Object.values(graph.workflows).find(w => w.on.conflict)?.name ?? (to ? 'back' : 'ask');
      const resolver = conflict === 'back' || conflict === 'ask' ? undefined : graph.workflows[conflict];
      const handled = conflict === 'back' || resolver !== undefined;
      if (tried >= (handled ? 2 : 1)) return { run: current };
      const { tree, files } = yield* mergeTreeOnto(work, onto, pull.head);
      if (merge && files.length === 0) yield* hostGit(work.git, ['read-tree', '-u', '--reset', tree]);
      const applied: Applied =
        files.length > 0
          ? { proposal, ok: false, reason: `conflicts in ${files.join(', ')}` }
          : yield* tracker.apply(run.issue, proposal, work);
      yield* store.trace(run.id, {
        at: new Date().toISOString(),
        step: run.step,
        applied,
      });
      if (!applied.ok && tried === 0 && handled) {
        const why = [
          [
            `${branch} no longer ${verb} ${pull.base} at ${onto.slice(0, 7)}: ${applied.reason}.`,
            `The work tree now starts on ${pull.base} with this change applied and conflict markers left where they clash.`,
            'Resolve each conflict so both sides keep working, remove every marker, and push.',
          ].join(' '),
          yield* readBaseGain(work.git, pull.base, run.moved?.from ?? from, onto),
        ].join('\n\n');
        const seed = {
          onto: { sha: onto, ...(merge && { merge: true as const }) },
          feedback: why,
        };
        if (!resolver)
          return {
            run: { ...reopened, onto: seed.onto },
            outcome: { kind: 'back', why } as const,
          };
        const proposed = {
          kind: 'run',
          workflow: resolver.name,
          issue: run.issue,
        } as const;
        if (
          yield* startProposedRun(graph, run, proposed, {
            ...seed,
            ...(run.checkout && { checkout: run.checkout }),
          })
        )
          return { run: current };
      }
      if (!applied.ok) {
        const body = `${branch} no longer ${verb} ${pull.base}: ${applied.reason}. Update it by hand.`;
        const reason = waits ? body : [current.reason, body].filter(Boolean).join('\n\n');
        return { run: yield* writeStatus(w, { ...current, reason }, graph) };
      }
      since = run.moved?.from ?? from;
      yield* store.put({ ...run, moved: { from: since, onto } });
      const patch = (diff: Buffer) =>
        Effect.map(
          hostGit(work.git, ['patch-id', '--stable'], {
            input: diff.toString('utf8'),
          }),
          out => out.toString('utf8').split(' ')[0]
        );
      const before = yield* patch(yield* hostGit(work.git, ['diff', from, pull.head]));
      const after = yield* patch(yield* hostGit(work.git, ['diff', onto, yield* writeCheckoutTree(work)]));
      same = before === after;
    } else yield* hostGit(work.git, ['read-tree', '-u', '--reset', pull.head]);
    if (!checked)
      return {
        run: {
          ...current,
          ...(since !== undefined && { moved: { from: since, onto } }),
        },
      };
    if (!to) return { run: current };
    yield* runSetup(graph, work, run);
    const t = yield* readIssueWithPull(w, run, graph);
    yield* writeHeardEvents(run, getEvents(t));
    const gain = since === undefined ? undefined : yield* readBaseGain(work.git, pull.base, since, onto);
    const left = {
      run: run.id,
      ...work,
      issue: run.issue,
      context: context(t),
      reply: '',
      proposals: [],
      answers: run.answers,
      ...(since !== undefined && gain !== undefined && { moved: { from: since, text: gain } }),
    };
    const own = same && !renewed;
    const judged = (name: string) => graph.checks[name]?.agent !== undefined;
    const scripts = step.checks.filter(c => !judged(c));
    const later = own ? step.checks.filter(judged) : [];
    let { outcome } = yield* runStepChecks(own ? { ...step, checks: scripts } : to, left, graph);
    if (outcome.kind === 'pass' && later.length > 0) {
      const reply = [
        `The base ${pull.base} moved from ${from.slice(0, 7)} to ${onto.slice(0, 7)}; the change stays the same.`,
        scripts.length > 0 && `These checks passed on the updated branch: ${scripts.join(', ')}.`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const second = yield* runStepChecks({ ...step, checks: later }, { ...left, reply }, graph);
      outcome = second.outcome;
    }
    return outcome.kind === 'failed'
      ? {
          run: reopened,
          outcome: {
            kind: 'back',
            why: [formatFailedTryFeedback(outcome), gain].filter(Boolean).join('\n\n'),
          } as const,
        }
      : outcome.kind === 'pass'
        ? { run: current }
        : { run: current, outcome };
  }).pipe(Effect.scoped);

/**
 * Answers what a human said to a run waiting at a human step: a fork of the session of the step it goes back to, in a
 * throwaway checkout of the pull request head. Its comments land on pull request `number` and the run keeps waiting; a
 * `back` comes back as the outcome, with the fork as that step's session, even when the reply could not land.
 */
export const runAside = (
  w: Workflow,
  run: Run,
  graph: Graph,
  said: string,
  pull: NonNullable<Issue['pull']>,
  number: number
) =>
  Effect.gen(function* () {
    const step = w.steps.find(s => s.name === run.step)!;
    const to = w.steps.find(s => s.name === step.back?.to);
    if (!to || !('agent' in to.does))
      return yield* new SessionStop({ reason: 'provider', detail: 'this wait step has no answering session' });
    const comments = getStepReturns(to, graph.agents).includes('comment');
    const kept = run.sessions[to.name];
    const work = yield* Effect.flatMap(Sandbox, s => s.checkout(pull.branch, undefined, undefined, graph));
    const t = kept ? undefined : yield* readIssueWithPull(w, run, graph);
    if (t) yield* writeHeardEvents(run, getEvents(t));
    const prompt = [
      t && [w.body, context(t)].join('\n\n'),
      `A human said this on the pull request while it waits at ${step.name}:\n\n${said}`,
      'This checkout is the pull request head; anything you change here is thrown away.',
      comments
        ? 'Answer with a comment. When it asks for a change, or you find one is needed, also propose back with why.'
        : 'When it asks for a change, or you find one is needed, propose back with why.',
      `End your reply with a fenced agentgraph block holding a JSON array of proposals:\n${[...(comments ? [shapes.comment] : []), shapes.back].join('\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const r = yield* runSession(
      graph,
      run.id,
      step.name,
      {
        ...makeAgentSessionSpec(graph, to.does.agent, { dir: work.dir }),
        limits: { ...graph.limits, ...to.limits },
        prompt,
        ...(kept && { resume: kept, fork: true as const }),
      },
      undefined,
      undefined,
      {
        ...(run.eyes && { issue: run.eyes.issue }),
        ...(run.eyes?.undo.comment !== undefined && { comment: run.eyes.undo.comment }),
        ...(run.eyes?.undo.review && { review: true as const }),
      }
    );
    if (r.ended !== 'stop')
      return yield* new SessionStop({ reason: 'provider', detail: `aside ended ${r.ended} (exit ${r.exit ?? 0})` });
    const { proposals } = parseProposals(r.final, false);
    const ungranted = findUngranted(to, graph, proposals, true);
    if (ungranted.length > 0) return yield* new SessionStop({ reason: 'provider', detail: ungranted.join('\n') });
    const back = proposals.find(p => p.kind === 'back');
    const landed = yield* writeProposals(
      run,
      proposals.filter(p => p.kind === 'comment'),
      number
    ).pipe(
      useRunLink(run, r.id),
      Effect.catchTag('TrackerError', e =>
        back ? Effect.as(Effect.logWarning(`aside reply of run ${run.id}`, e), []) : e
      )
    );
    if (!back && !landed.some(a => a.ok))
      return yield* new SessionStop({ reason: 'provider', detail: 'no aside reply landed' });
    yield* writeAppliedTrace(run.id, step.name, landed);
    const { eyes: _eyes, ...replied } = removeThreads(run);
    const answered = landed.some(a => a.ok) ? replied : run;
    if (!back || r.id === undefined) return { run: answered };
    const sessions = { ...run.sessions, [to.name]: { id: r.id, home: r.home, ...(kept?.seen && { seen: kept.seen }) } };
    return { run: { ...answered, sessions }, outcome: { kind: 'back', why: back.why } as const };
  }).pipe(Effect.scoped);
