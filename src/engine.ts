import { dirname } from 'node:path';
import { Duration, Effect, Result, Option, Schema, Stream } from 'effect';
import { formatRequest, context, formatEventLine, news, stoppedByRunner, formatSqueezed } from './context.ts';
import { Tracker, TrackerError } from './tracker.ts';
import type { Applied, Comment, Event, Issue } from './event.ts';
import type { Proposal } from './proposal.ts';
import { PluginMetadata } from './meta.ts';
import type { Graph } from './folder.ts';
import { getStepReturns } from './graph.ts';
import { formatCause, Sandbox, SandboxError, type Checkout } from './sandbox.ts';
import { commitCheckout, ensureGraphRef, gitIdentity, readGit, writeCheckoutTree } from './git.ts';
import { Store, type StoreError } from './store.ts';
import { SessionStop, pickUsed } from './trace.ts';
import {
  begin,
  fold,
  getEventOutcome,
  makeRunWithFreshRound,
  transition,
  type CheckResult,
  type Outcome,
  type Run,
  type RunRecord,
  type Seen,
  type Workflow,
  isHumanWaitStep,
  isIssueTriggered,
  isQuiet,
  isRunDone,
  parseAgentRequest,
} from './workflow.ts';
import { type Services, runShell, runSession, formatFailure } from './run/execute.ts';
import { findFanOutItems, readCheckoutDiff, most, runSetup } from './run/checkout.ts';
import {
  findPullNumber,
  isInScope,
  isRetro,
  findRouter,
  pickNewest,
  readIssueWithPull,
  formatTemplate,
  readHeardOutcome,
  readContinuedRun,
  readRunEvents,
  getHeardEvent,
} from './run/hear.ts';
import { makeScriptEnv, formatTracesPrompt, writeTraces, getTraceFiles, runStepChecks } from './run/check.ts';
import { runLaterChecks } from './run/evaluate.ts';
import {
  useRunLink,
  isParked,
  writeMovedStatus,
  removeThreads,
  writeStatus,
  readRunSpend,
  runEndChecks,
  findAppliedBefore,
  getOperationKey,
  writeOnce,
  writeProposals,
} from './run/settle.ts';
import {
  findUndispatchable,
  startProposedRun,
  readFiledIssues,
  findRecipient,
  writeTold,
  type Child,
  createIssues,
  formatWaitingOn,
} from './run/start.ts';
import { writeNews, shapes, pickLastHeard, parseProposals, pickTryOutcome, block } from './run/attempt.ts';
import { moveCheckoutOnto, runAside, runFollow, runCatchUp } from './run/follow.ts';

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
    body: `/agent ${text}`,
    agentRequest: text,
    at,
    ...(parent && { path: parent.path!, line: parent.line, under: parent.under ?? parent.id }),
  },
});

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
    const supplied = yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(PluginMetadata))(meta).pipe(
      Effect.mapError(() => new TrackerError({ message: 'invalid run metadata' }))
    );
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
        ...(supplied && { meta: supplied }),
      });
      if (text)
        yield* Effect.flatMap(Store, s =>
          s.trace(child.id, {
            at: child.started,
            step: child.step,
            spoken: spokenByCli(p.issue, text, child.started),
            ...(supplied && { meta: supplied }),
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
        store.trace(target.id, { at, step: target.step, spoken: event, ...(supplied && { meta: supplied }) })
      );
    return yield* tick(graph, owner?.issue ?? issue.number, true, 0, supplied).pipe(
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

/** A trusted person's comment, review or pushed commit; a bare stop, cancel or restart is a command, not feedback. */
const feedback = (m: Event) =>
  m.trusted &&
  (m.kind === 'comment' ||
    m.kind === 'changes_requested' ||
    m.kind === 'commit' ||
    (m.kind === 'approved' && !!m.comment?.body.trim())) &&
  !/^(stop|cancel|restart(\s+\S+)?)$/i.test(parseAgentRequest(m) ?? '');

/** One try of the current step: a session, a script or a wait, then its checks, then apply proposals on a pass. */
const runAttempt = (
  w: Workflow & Required<Pick<Workflow, 'base'>>,
  run: Run,
  graph: Graph,
  work: Checkout,
  own?: string
): Effect.Effect<{ outcome: Outcome; run: Run }, SandboxError | SessionStop | TrackerError | StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const step = w.steps.find(s => s.name === run.step)!;
    const minutes = graph.limits.minutes;
    const done = (outcome: Outcome, next = run) => ({ outcome, run: next });
    const returns = getStepReturns(step, graph.agents);
    /** The first session of a run a comment started, which may answer that comment. */
    const asked = returns.includes('comment') && run.said !== undefined && Object.keys(run.sessions).length === 0;
    const before = asked ? yield* writeCheckoutTree(work) : undefined;
    if ('wait' in step.does) {
      const { issue, pull } = yield* readIssueWithPull(w, run);
      const open = w.branch === undefined || issue.pull !== undefined || pull !== undefined;
      return done({
        kind: 'ask',
        question: open
          ? `${step.name} waits for a human`
          : `No pull request is open for branch ${formatTemplate(w.branch!, issue)}. Open one, or say what to do.`,
      });
    }

    const replies: string[] = [];
    let tried = run;
    let spoke: string | undefined;
    /** Refreshes the news file every minute and ends with what a human said that cuts the try short. */
    const watch = (by: Run, seen: Seen) =>
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep('1 minute');
          const now = yield* Effect.result(readIssueWithPull(w, run));
          if (Result.isFailure(now)) {
            yield* Effect.logWarning(`news for run ${run.id}`, now.failure);
            continue;
          }
          yield* writeNews(run, work, seen, now.success);
          const cut = yield* readHeardOutcome(graph, w, by, now.success).pipe(
            Effect.catch(e => Effect.as(Effect.logWarning(`interrupt for run ${run.id}`, e), undefined))
          );
          if (cut && (cut.outcome.kind !== 'answer' || w.concurrency === 'cancel')) return cut;
        }
      });
    const t = yield* readIssueWithPull(w, run);
    /** Whether the work a comment-only reply answers exists: no branch, a pull request, or a finished run. */
    const held =
      w.branch === undefined ||
      t.issue.pull !== undefined ||
      t.pull !== undefined ||
      (yield* store.list({ issue: run.issue })).some(r => r.workflow === w.name && r.status === 'done');
    const answering = asked && held;
    if ('run' in step.does) {
      const started = Date.now();
      const reads = step.does.reads === 'traces';
      if (reads) yield* writeTraces(graph, run.issue, run.id, work);
      const env = { ...makeScriptEnv(work, run.issue), ...(reads && getTraceFiles(work)) };
      const out = yield* runShell(step.does.run, graph, work.dir, env, minutes);
      const result: CheckResult = {
        check: step.name,
        pass: out.code === 0,
        ...(out.code !== 0 && { findings: formatSqueezed(out.output) }),
        ms: Date.now() - started,
      };
      const log = yield* store.log(out.output, result.pass);
      yield* store.addChecks(run.id, {
        at: new Date().toISOString(),
        step: step.name,
        check: result,
        version: graph.sha.slice(0, 12),
        usd: 0,
        exit: out.code,
        ...pickUsed(out),
        ...(log && { log }),
      });
      if (!result.pass)
        return done({
          kind: 'failed',
          checks: [result],
          proposals: [],
          problems: [],
        });
      replies.push(out.output);
    } else {
      const name = step.does.agent;
      const agent = graph.agents[name]!;
      const issue = t.issue;
      const kept = step.each === undefined ? run.sessions[step.name] : undefined;
      const kinds = [...agent.returns.filter(k => k !== 'ask' && k !== 'back'), 'ask', ...(step.back ? ['back'] : [])];
      /** A step that judges the change, and does not fan out over it, opens on the whole of it. */
      const diff = step.back && !step.each && !kept ? yield* readCheckoutDiff(work) : '';
      if (agent.reads) yield* writeTraces(graph, run.issue, run.id, work);
      const ending = [
        'End your reply with a fenced agentgraph block holding a JSON array of proposals. The runner commits, pushes,',
        'opens pull requests and posts comments from them, so do not run git or gh yourself. The shape of each kind:',
        ...kinds.map(k => shapes[k as keyof typeof shapes]),
      ].join('\n');
      const scratch = (yield* Sandbox).scratch;
      const prompt = [
        formatRequest(t, run.started),
        ...[step.does.skill, ...(graph.skills[step.does.skill ?? '']?.uses ?? [])].map(s => s && graph.skills[s]?.body),
        w.body,
        context(t),
        diff && `## The change on the branch\n\n\`\`\`\`diff\n${formatSqueezed(diff, 20_000)}\n\`\`\`\``,
        w.branch &&
          `Work on the branch ${formatTemplate(w.branch, issue)}; pull requests go into ${run.base?.branch ?? issue.pull?.base ?? formatTemplate(w.base, issue)}.`,
        step.back?.until && `Propose back with a reason while this does not hold: ${step.back.until}`,
        step.checks.length > 0 &&
          `When you stop, the runner checks the change: ${step.checks
            .map(n => (graph.checks[n]?.run ? `${n} runs \`${graph.checks[n].run}\`` : n))
            .join(', ')}.`,
        answering &&
          'A comment started this run. When it does not ask for work, answer it with comment proposals only; that ends the run.',
        `People may comment while you work: ${work.news} holds what is new, refreshed every minute. Read it before you finish.`,
        scratch &&
          `Use ${scratch} for large temporary files, isolated source trees and build outputs outside the checkout. It is disk-backed, writable and removed when the checkout ends. /tmp is a small memory-backed filesystem.`,
        agent.reads && formatTracesPrompt(work),
        agent.returns.includes('issue') && (yield* readFiledIssues()),
        run.feedback,
        ending,
      ]
        .filter(Boolean)
        .join('\n\n');
      const listed: (string | undefined)[] = step.each
        ? yield* findFanOutItems(step.each, graph, work, minutes).pipe(
            Effect.catchTag('EachFailed', e =>
              Effect.fail(
                new SandboxError({
                  reason: 'infra',
                  detail: `each failed: ${e.detail}`,
                })
              )
            )
          )
        : [undefined];
      const items = listed.length > most ? [listed.join('\n\n')] : listed;
      const caught = news(t, kept ? (kept.seen ?? { at: run.started }) : { at: '' });
      tried = { ...tried, seen: pickNewest(run.seen, run.started, pickLastHeard(t))! };
      const talk = (prompt: string, seen: Seen, resume?: Run['sessions'][string], item?: string) =>
        Effect.gen(function* () {
          const r = yield* runSession(
            graph,
            run.id,
            step.name,
            {
              harness: agent.harness,
              agent: name,
              minutes,
              ...(agent.model !== undefined && { model: agent.model }),
              system: agent.body,
              prompt,
              dir: work.dir,
              base: work.base,
              tools: agent.tools,
              read: [dirname(work.news)],
              ...(resume && { resume }),
            },
            item,
            watch(tried, seen)
          );
          spoke = r.id ?? spoke;
          tried = yield* readContinuedRun(
            tried,
            [...t.issue.events, ...(t.pull?.events ?? [])].filter(m => m.at > (run.seen ?? run.started))
          );
          tried = {
            ...tried,
            ...(step.each === undefined &&
              r.id !== undefined && {
                sessions: { ...tried.sessions, [step.name]: { id: r.id, home: r.home, seen } },
              }),
          };
          if (!r.cut && r.ended !== 'stop')
            return yield* new SessionStop({
              reason: r.ended === 'login' ? 'login' : 'provider',
              detail: `session ended ${r.ended} (exit ${r.exit ?? 0}), final: ${formatSqueezed(r.final, 200)}`,
            });
          return r;
        });
      for (const item of items) {
        yield* writeNews(run, work, caught.seen, t);
        const r = yield* talk(
          kept
            ? [run.feedback ?? 'Continue.', caught.text, ending].filter(Boolean).join('\n\n')
            : item === undefined
              ? prompt
              : `${prompt}\n\n## Item\n\n${item}`,
          caught.seen,
          kept,
          item
        );
        if (r.cut) return done(r.cut.outcome, yield* readContinuedRun({ ...tried, seen: r.cut.at }, r.cut.events));
        replies.push(r.final);
      }
      const session = step.each === undefined ? tried.sessions[step.name] : undefined;
      const now = session && Option.getOrUndefined(yield* Effect.option(readIssueWithPull(w, run)));
      const late = now ? yield* readHeardOutcome(graph, w, tried, now) : undefined;
      if (late && late.outcome.kind !== 'answer')
        return done(late.outcome, yield* readContinuedRun({ ...tried, seen: late.at }, late.events));
      if (now && late && w.concurrency === 'steer') {
        const since = news(now, caught.seen);
        const r = yield* talk(
          `${since.text}\n\nTake this into account, then end your reply with the whole agentgraph block again.`,
          since.seen,
          session
        );
        if (r.cut) return done(r.cut.outcome, yield* readContinuedRun({ ...tried, seen: r.cut.at }, r.cut.events));
        replies.splice(0, replies.length, r.final);
        tried = yield* readContinuedRun(
          { ...tried, seen: pickNewest(tried.seen, late.at, pickLastHeard(now))! },
          late.events
        );
      }
    }

    const parsed = replies.map(reply => parseProposals(reply, !('run' in step.does)));
    const proposals = parsed.flatMap(p => p.proposals);
    const merges = own
      ? yield* Effect.forEach(
          proposals.flatMap(p => (p.kind === 'merge' ? [p.number] : [])),
          n =>
            Effect.flatMap(Tracker, f => f.issue(n)).pipe(
              Effect.catchIf(
                e => e.status === 404,
                () => Effect.succeed(undefined)
              ),
              Effect.map(target => [n, target?.pull?.branch] as const)
            )
        )
      : [];
    const diff = yield* readCheckoutDiff(work);
    const tree = yield* writeCheckoutTree(work);
    const published = yield* readGit(work.git, ['rev-parse', `${work.published ?? work.head ?? work.base}^{tree}`]);
    const verdict = pickTryOutcome({
      step,
      graph,
      run,
      branch: w.branch,
      own,
      proposals,
      problems: parsed.flatMap(p => p.problems),
      asked,
      held,
      open: t.issue.pull !== undefined || t.pull !== undefined,
      merges: Object.fromEntries(merges),
      diff,
      untouched: tree === before,
      dirty: tree !== published,
    });
    if ('outcome' in verdict) return done(verdict.outcome, tried);
    const { world, back, problems, answered } = verdict;
    const checked = answered
      ? { outcome: { kind: 'pass' } as const }
      : yield* Effect.raceFirst(
          runStepChecks(
            step,
            {
              run: run.id,
              ...work,
              issue: run.issue,
              context: context(t),
              reply: replies.join('\n\n'),
              proposals: world,
              ...(run.answers && { answers: run.answers }),
            },
            graph
          ),
          Effect.map(watch(tried, { at: tried.seen ?? run.started }), cut => ({ cut }))
        );
    if ('cut' in checked)
      return done(checked.cut.outcome, yield* readContinuedRun({ ...tried, seen: checked.cut.at }, checked.cut.events));
    const { outcome: gated } = checked;
    if (gated.kind === 'failed' || (gated.kind === 'pass' && problems.length > 0))
      return done(
        gated.kind === 'failed'
          ? { ...gated, problems: [...gated.problems, ...problems] }
          : { kind: 'failed', checks: [], proposals: [], problems },
        tried
      );
    if (gated.kind !== 'pass') return done(gated, tried);
    if (back) return done({ kind: 'back', why: back.why }, tried);

    const to = world.some(p => p.kind === 'comment' && (!run.said || p.under !== undefined))
      ? findPullNumber(w, run.issue, yield* Effect.flatMap(Tracker, f => f.issues({ state: 'open' })))
      : undefined;
    const runs = world.filter(p => p.kind === 'run');
    const tells = yield* Effect.forEach(
      world.filter(p => p.kind === 'tell'),
      (p, i) =>
        Effect.gen(function* () {
          const key = getOperationKey(tried, p.issue, p, `tell:${i}`);
          const prior = yield* findAppliedBefore(tried, p.issue, key);
          const to = prior?.id ? yield* store.get(prior.id) : yield* findRecipient(graph, p.issue, run.id);
          return { p, to, key };
        })
    );
    const refused = [
      ...(yield* findUndispatchable(graph, run, runs)),
      ...tells.flatMap(({ p, to }): Applied[] =>
        to ? [] : [{ proposal: p, ok: false, reason: `no live run on #${p.issue} to tell` }]
      ),
    ];
    if (refused.length > 0) return done({ kind: 'failed', checks: [], proposals: refused, problems: [] }, tried);
    const delivered = yield* Effect.forEach(tells, ({ p, key }) =>
      writeOnce(
        tried,
        p.issue,
        key,
        Effect.map(writeTold(graph, p.issue, p.text, run.id), to => ({ proposal: p, ok: true, id: to.id }))
      )
    );
    const children = world.filter((p): p is Child => p.kind === 'issue');
    const rest = world.filter(p => p.kind !== 'issue' && p.kind !== 'run' && p.kind !== 'tell');
    const landed = yield* Effect.result(
      Effect.gen(function* () {
        const applied = yield* writeProposals(tried, rest, work, to);
        if (applied.some(a => !a.ok && a.proposal.kind === 'push'))
          return [
            ...applied,
            ...children.map((proposal): Applied => ({ proposal, ok: false, reason: 'push failed; not applied' })),
          ];
        return [...applied, ...(yield* createIssues(w, tried, children))];
      }).pipe(useRunLink(tried, spoke))
    );
    if (Result.isFailure(landed) && landed.failure._tag === 'StoreError') return yield* landed.failure;
    if (Result.isFailure(landed))
      return done(
        {
          kind: 'ask',
          question: `GitHub failed: ${formatSqueezed(landed.failure.message, 200)}`,
        },
        tried
      );
    const failed = landed.success.filter(a => !a.ok);
    if (landed.success.some(a => a.ok)) tried = removeThreads(tried);
    if (tried.onto && landed.success.some(a => a.ok && a.proposal.kind === 'push')) {
      const { onto: _landed, ...rest } = tried;
      tried = rest;
    }
    const child = runs[0] && !failed.length ? yield* startProposedRun(graph, tried, runs[0]) : undefined;
    const applied = [
      ...landed.success,
      ...delivered,
      ...(child ? [{ proposal: runs[0]!, ok: true, id: child.id }] : []),
    ];
    yield* store.trace(
      run.id,
      ...applied.filter(a => !a.operation).map(a => ({ at: new Date().toISOString(), step: step.name, applied: a }))
    );
    return done(
      failed.length
        ? { kind: 'failed', checks: [], proposals: failed, problems: [] }
        : child
          ? { kind: 'ask', question: formatWaitingOn(child) }
          : {
              kind: 'pass',
              text: replies
                .map(reply => reply.replace(block, '').trim())
                .filter(Boolean)
                .join('\n\n'),
              ...(answered && { answered: true as const }),
            },
      tried
    );
  });

const rejected = 'the model provider rejected the key or login. Fix it, then start a new run.';

/**
 * Runs the graph's setup, then tries until the run stops running. A runner error is retried once, then parks the run at its step, so an
 * answer tries that step again with the feedback it had. Files are kept under `refs/agentgraph/runs/<run id>`.
 * @internal
 */
export const drive = (w: Workflow, run: Run, graph: Graph): Effect.Effect<Run, StoreError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const tracker = yield* Tracker;
    let current = run;
    const settle = (outcome: Outcome, next: Run, failure?: SessionStop['reason']) =>
      Effect.gen(function* () {
        yield* store.trace(next.id, {
          at: new Date().toISOString(),
          step: current.step,
          outcome,
          ...(failure && { failure }),
          run: {
            step: next.step,
            status: next.status,
            tries: next.tries,
            rounds: next.rounds,
            ...(next.reason !== undefined && { reason: next.reason }),
          },
        });
        const child = (yield* store.list()).some(r => r.by === next.id && next.reason === formatWaitingOn(r));
        if (next.status === 'waiting' && next.reason && !next.reason.startsWith(stoppedByRunner) && !child) {
          const body = outcome.kind === 'failed' ? 'How should I proceed?' : next.reason;
          const said = yield* Effect.result(writeProposals(removeThreads(next), [{ kind: 'comment', body }]));
          if (Result.isSuccess(said))
            yield* store.trace(
              next.id,
              ...said.success
                .filter(a => !a.operation)
                .map(applied => ({
                  at: new Date().toISOString(),
                  step: next.step,
                  applied,
                }))
            );
        }
        current = yield* writeStatus(w, next, graph);
        yield* store.put(current);
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

      const work = current.onto ? yield* moveCheckoutOnto(made, current.onto.sha, current.tries === 0) : made;
      current = { ...current, startCommit: work.base };

      if (!w.on.feedback) yield* runSetup(graph, work, current);
      const attempts = `refs/agentgraph/attempts/${run.id}/`;
      let count = (yield* readGit(work.git, ['rev-parse', `--glob=${attempts}*`])).split('\n').filter(Boolean).length;
      while (current.status === 'running') {
        const tried = yield* runAttempt({ ...w, base }, current, graph, work, own);
        yield* commitCheckout(work.git, `${attempts}${++count}`, '', [
          work.head ?? work.base,
          work.saved,
          work.published,
        ]);
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
        const t = !isRunDone(current) ? yield* Effect.option(readIssueWithPull(w, current)) : Option.none();
        const queued = Option.isSome(t) ? yield* readHeardOutcome(graph, w, current, t.value) : undefined;
        if (queued)
          yield* settle(
            queued.outcome,
            yield* readContinuedRun({ ...transition(w, current, queued.outcome), seen: queued.at }, queued.events)
          );
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
    if (current.status !== 'running') return current;
    do {
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
    } while (current.status === 'running');
    return current;
  }).pipe(Effect.scoped);

/** How long an issue must be quiet before what people did there starts or wakes a run, so a burst counts once. */
export const issueDebounceMs = 30_000;

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
  meta?: Run['meta']
): Effect.Effect<Run[], TrackerError | StoreError, Services> =>
  Effect.gen(function* () {
    const supplied = yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(PluginMetadata))(meta).pipe(
      Effect.mapError(() => new TrackerError({ message: 'invalid run metadata' }))
    );
    const store = yield* Store;
    const tracker = yield* Tracker;
    const mine = (r: { issue: number }) => only === undefined || r.issue === only;
    const all = yield* store.list();
    const runs = all.filter(mine).filter(r => !isRetro(graph, r) || isParked(r));
    const waiting = runs.filter(r => !isRunDone(r)).map(run => ({ run, at: run.seen ?? run.started }));
    const started = runs
      .map(r => r.started)
      .sort()
      .at(-1);
    const cursor = started === undefined ? '' : [started, ...waiting.map(p => p.at)].sort()[0]!;
    const issues = yield* tracker.issues({ state: 'open' });
    const boards = Object.values(graph.workflows).some(w => w.on.issues?.column);
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
          if (!recorded)
            yield* store.trace(run.id, { at: m.at, step: run.step, spoken, ...(supplied && { meta: supplied }) });
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
    /** Moves a live run outside a session: traces the outcome and saves where it led. */
    const record = (run: Run, outcome: Outcome, next: Run) =>
      Effect.gen(function* () {
        yield* store.trace(run.id, {
          at: new Date().toISOString(),
          step: run.step,
          outcome,
          run: {
            step: next.step,
            status: next.status,
            tries: next.tries,
            rounds: next.rounds,
            ...(next.reason !== undefined && { reason: next.reason }),
          },
        });
        yield* store.put(next);
        touched.push(next);
      });
    waiting.sort((a, b) => b.run.started.localeCompare(a.run.started));
    for (const waitingRun of waiting)
      yield* Effect.gen(function* () {
        if (Result.isFailure(yield* Effect.result(store.lock(waitingRun.run.id)))) return;
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
              lined
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
        if (Result.isFailure(yield* Effect.result(store.lock(before.id)))) return;
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
        .map(r => touched.find(t => t.id === r.id) ?? r)
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
        const begun = {
          ...begin(w, { id: `${w.name}-${issue}-${at.replace(/\D/g, '')}`, issue, started: at }, step),
          ...(supplied && { meta: supplied }),
          ...(m?.kind === 'comment' && { said: heard([m]) }),
          ...(restart !== undefined && last?.answers && { answers: last.answers }),
        };
        if (Result.isFailure(yield* Effect.result(store.lock(begun.id)))) return;
        if (yield* store.get(begun.id)) return;
        const first = begun.status === 'running' ? begun : yield* writeStatus(w, begun, graph);
        busy.add(`${w.name}#${issue}`);
        yield* store.put(first);
        const run = m ? yield* eyes(first, m) : first;
        if (run !== first) yield* store.put(run);
        const mark = w.on.issues?.label;
        if (mark !== undefined && m && m.kind !== 'label' && isIssueTriggered(w, m))
          yield* tracker.apply(issue, { kind: 'label', add: [mark] }).pipe(
            Effect.flatMap(applied => store.trace(run.id, { at: new Date().toISOString(), step: run.step, applied })),
            Effect.catchTag('TrackerError', e => Effect.logWarning(`label for run ${run.id}`, e))
          );
        touched.push(run);
      }).pipe(Effect.scoped);
    for (const m of events) {
      const words = parseAgentRequest(m)?.split(/\s+/) ?? [];
      const named = triggered.find(w => w.name === words[0]);
      const relabelled = events.some(
        n => n.issue === m.issue && n.label === m.label && n.at > m.at && (n.kind === 'label' || n.kind === 'unlabel')
      );
      const sourced = Object.values(graph.workflows).find(w => isIssueTriggered(w, m));
      const w =
        m.kind === 'label' && relabelled
          ? undefined
          : (sourced ?? (parseAgentRequest(m) !== undefined ? (named ?? triggered[0]) : undefined));
      const [verb = '', step = ''] = named ? words.slice(1) : words;
      const restart = /^restart$/i.test(verb) ? step : undefined;
      if (!w || (used.has(m) && restart === undefined) || !(sourced || m.trusted) || young(m.issue)) continue;
      if (!open.has(m.issue) && (m.kind !== 'comment' || !isInScope(graph, yield* tracker.issue(m.issue)))) continue;
      /** With a router, a comment concerns only the router's runs; the others hear it through what the router tells them. */
      const concerns = (name: string) => m.kind !== 'comment' || !routed || !!graph.workflows[name]?.on.issue_comment;
      if (
        /^(stop|cancel)$/i.test(verb) &&
        !runs.some(r => r.issue === m.issue && !isRunDone(r) && !concerns(r.workflow))
      )
        continue;
      const old =
        restart === undefined &&
        runs.some(
          r =>
            r.issue === m.issue &&
            concerns(r.workflow) &&
            (m.at <= (r.seen ?? r.started) || (sourced && r.workflow === w.name && r.status === 'done'))
        );
      const held = [...busy].some(k => k.endsWith(`#${m.issue}`) && concerns(k.slice(0, k.lastIndexOf('#'))));
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
      for (const m of latest.map(onRun).filter(feedback)) {
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
          ...begin(w, { id: `${w.name}-${issue}-${at.replace(/\D/g, '')}`, issue, started: at }),
          feedback: `## What a person said or pushed\n\n${fresh.map(formatEventLine).join('\n\n')}`,
        };
        yield* Effect.gen(function* () {
          if (Result.isFailure(yield* Effect.result(store.lock(begun.id)))) return;
          if (yield* store.get(begun.id)) return;
          yield* store.put(begun);
          touched.push(begun);
        }).pipe(Effect.scoped);
      }
    }

    for (const r of runs.map(r => touched.find(t => t.id === r.id) ?? r).filter(r => !isRunDone(r))) {
      const w = graph.workflows[r.workflow];
      const head = r.base && issues.find(t => t.number === r.base!.pull)?.pull?.head;
      if (
        !w ||
        !r.base ||
        !head ||
        (head === r.base.sha && !r.base.from) ||
        findPullNumber(w, r.issue, issues) === undefined
      )
        continue;
      yield* runFollow(w, r, r.base, head, graph).pipe(
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

    for (const before of runs.map(r => touched.find(t => t.id === r.id) ?? r).filter(r => r.status === 'waiting'))
      yield* Effect.gen(function* () {
        if (Result.isFailure(yield* Effect.result(store.lock(before.id)))) return;
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
    const driven = yield* Effect.forEach(
      running,
      r =>
        drive(graph.workflows[r.workflow]!, r, graph).pipe(
          Effect.catch(e => Effect.as(Effect.logError(`run ${r.id}`, e), r))
        ),
      { concurrency: graph.limits.parallel }
    );
    const looked = [...touched, ...driven];
    yield* Effect.forEach(
      (yield* store.list()).filter(
        r => r.unshown && mine(r) && graph.workflows[r.workflow] && !looked.some(l => l.id === r.id)
      ),
      r => writeStatus(graph.workflows[r.workflow]!, r, graph)
    );
    const owing = (yield* store.list()).filter(r => r.owed && mine(r));
    const ended = (yield* Effect.forEach(owing, r => runEndChecks(graph, r.id), {
      concurrency: graph.limits.parallel,
    })).filter(r => r !== undefined);
    const moved = [...touched.filter(r => !driven.some(d => d.id === r.id)), ...driven];
    return [...moved.filter(r => !ended.some(e => e.id === r.id)), ...ended];
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
  meta?: Run['meta']
): Effect.Effect<Run[], TrackerError | StoreError, Services> =>
  Effect.gen(function* () {
    const tracker = yield* Tracker;
    const [listing, invalidate] = yield* Effect.cachedInvalidateWithTTL(
      tracker.issues({ state: 'open' }),
      Duration.infinity
    );
    const listed = yield* listing;
    const open = listed.filter(t => !t.pull && isInScope(graph, t));
    const all = yield* Effect.flatMap(Store, s => s.list());
    const runs = all.filter(r => !isRunDone(r) || r.owed);
    const from = pickNewest(...all.map(r => r.started));
    const cursor = from
      ? new Date(Date.parse(all.flatMap(r => [r.started, r.seen ?? r.started]).toSorted()[0]!) - debounce).toISOString()
      : '';
    const boards = Object.values(graph.workflows).some(w => w.on.issues?.column);
    const latest = yield* Effect.cached(Stream.runCollect(tracker.since(cursor, boards)));
    const history = cursor ? yield* Effect.cached(Stream.runCollect(tracker.since('', boards))) : latest;
    const said = from === undefined ? [] : (yield* latest).filter(m => Date.parse(m.at) > Date.parse(from) - debounce);
    const asked = said.filter(m => m.trusted && parseAgentRequest(m) !== undefined).map(m => m.issue);
    const issues = [...new Set([...runs.map(r => r.issue), ...asked, ...open.map(t => t.number)])];
    const look = (n: number) =>
      tick(graph, n, true, debounce, meta).pipe(
        Effect.provideService(Tracker, {
          ...tracker,
          issues: filter =>
            filter?.state === 'open' && !filter.labels?.length && filter.parent === undefined
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
    return (yield* Effect.forEach(issues, look, { concurrency: graph.limits.parallel })).flat();
  });
