import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import {
  backOf,
  effectiveRun,
  effectiveReturns,
  nextOf,
  returnKinds,
  stepOrder,
  stepsBefore,
  triesOf,
} from '../config.ts';
import type { PlannedJob } from '../dispatch.ts';
import { digest } from '../fingerprint.ts';
import { parkedBranch } from '../workspace.ts';
import { fanOut } from '../over.ts';
import { roles } from '../issues.ts';
import { extractProposals, validate } from '../outputs.ts';
import { runScript, type ScriptResult } from '../runner.ts';
import type { Closure, ProposalKind, Return, Step } from '../schema.ts';
import type { Run, Stopped } from '../store.ts';
import { type JobResult, type Pipeline, issuesOf, launcher, pullsOf, skip } from './context.ts';
import { type Handoff, type Target, fenced, handoffEnv, targetOf } from './prompt.ts';
import { type Attempt, failingChecks, findingsFor, holds, issueEnv, runOnItem } from './checks.ts';
import { continuing, saidSince, seeded } from './continue.ts';
import { closed, finish, remember, settle } from './landing.ts';
import { type Worktree, defaultBranchFor, fanned, proposalProblems, requestsEnv, stepItems } from './attempt.ts';

/**
 * Runs a script step: once, or once per item its `over` names with the item in `BOTHUB_ITEM` and on stdin. It fails
 * when any run fails; the output of every run is stored on the step's run. A script that may return proposals ends
 * its output with a `bothub` block, validated and applied like a bot's; a script that may merge also gets the open
 * requests into its `into` from `requestsEnv`.
 */
const scriptStep = (
  planned: PlannedJob,
  step: Step & { run: string },
  handoff: Handoff,
  target: Target,
  p: Pipeline,
  issue?: string
) =>
  Effect.gen(function* () {
    const { store, event } = p;
    const created = yield* Effect.promise(() =>
      store.create({ workflow: planned.workflow, job: planned.job, event, ...(issue && { issue }) })
    );
    const timeout = step.minutes ?? p.config.hub.limits.minutes;
    const returns = step.returns ?? [];
    const kinds = returnKinds(returns);
    const once = (cwd: string, env: Record<string, string>) =>
      runScript(step.run, cwd, timeout, env, launcher(p), { hub: p.hub });
    const each = async (worktree: Worktree) => {
      const { items, error, scope } = await stepItems(step, worktree, handoff, p);
      if (error) return { ok: false, output: error, stdout: '' };
      const outputs: string[] = [];
      let stdout = '';
      let ok = true;
      let stopped: ScriptResult['stopped'];
      for (const item of items) {
        const result = await runOnItem(step.run, item, scope, p);
        ok &&= result.ok;
        stopped ??= result.stopped;
        stdout += result.stdout;
        if (result.output) outputs.push(items.length > 1 ? `${item.label}:\n${result.output}` : result.output);
      }
      return { ok, output: outputs.join('\n\n'), stdout, ...(stopped && { stopped }) };
    };
    const execute = (worktree: Worktree) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          store.update(created.id, { status: 'running', startedAt: new Date().toISOString() })
        );
        const env = {
          ...handoffEnv(handoff),
          ...issueEnv(p),
          BOTHUB_BASE: worktree.base,
          ...(yield* Effect.promise(() => requestsEnv(kinds, target, p))),
        };
        const { ok, output, stdout, stopped }: ScriptResult = yield* Effect.promise(() =>
          fanOut(step.over) ? each(worktree) : once(worktree.cwd, env)
        );
        const ts = new Date().toISOString();
        yield* Effect.promise(async () => {
          if (output) await store.append(created.id, { ts, seq: 0, event: { type: 'text', text: output } });
          await store.append(created.id, { ts, seq: output ? 1 : 0, event: { type: 'end', ok } });
        });
        const why = stopped === 'sandbox' ? output : 'the script exited non-zero';
        if (!ok || !kinds.length) {
          const run = yield* Effect.promise(() =>
            store.update(created.id, {
              status: ok ? 'succeeded' : 'failed',
              ...(stopped && { stopped }),
              ...(ok ? closed('done') : { error: why, ...closed('blocked', why) }),
              endedAt: ts,
            })
          );
          yield* Effect.promise(() => remember(run, undefined, p));
          return { ...planned, run } satisfies JobResult;
        }
        const extracted = extractProposals(stdout);
        const defaultBranch = yield* Effect.promise(() => defaultBranchFor(kinds, p));
        const allowance = { returns, paths: step.paths, ...target, ...(defaultBranch && { defaultBranch }) };
        const validated = validate(extracted.proposals, allowance);
        const said = extracted.proposals.length || extracted.errors.length;
        const problems = said ? proposalProblems(extracted, validated, kinds) : [];
        const run = yield* Effect.promise(() =>
          store.update(created.id, {
            status: problems.length ? 'failed' : 'succeeded',
            ...(problems.length && { error: problems.join('; ') }),
            endedAt: ts,
          })
        );
        const a: Attempt = {
          planned,
          step,
          worktree: worktree.id,
          cwd: worktree.cwd,
          base: worktree.base,
          parent: run,
          handoff,
          target,
          ...(worktree.replace && { replace: worktree.replace }),
        };
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, problems.length ? undefined : validated.accepted, a, p)
        );
        return yield* finish(planned, run, outcome, kinds, p);
      });
    return yield* withWorktree(created, execute, handoff, p, {
      target,
      lock: lockOf(target, returns),
      wait: timeout,
      fresh: planned.rerun === 'fresh',
    });
  });

/**
 * Where a job's worktree starts when its own branch does not exist yet: the handed-off branch, the `into` of a job
 * whose branch goes into one, so every job into it forks from the same place, the event's ref, or for an event on a
 * merge request without one, the request's branch.
 */
const startOf = async (target: Target, handoff: Handoff, p: Pipeline) => {
  if (handoff.branch) return handoff.branch;
  if (target.branch && target.into && pullsOf(p)) return target.into;
  const { ref, pull } = p.event;
  if (ref || pull === undefined || target.branch) return ref;
  return (
    await pullsOf(p)
      ?.get(pull)
      .catch(() => undefined)
  )?.branch;
};

/**
 * Whether a merging job has nothing to do: no open request from a `bothub/` branch into its `into`, and no request
 * from `into` into the default branch left to open, because `into` is the default branch, the job may not open one
 * or one is already open.
 */
const nothingToMerge = async (kinds: ProposalKind[], target: Target, p: Pipeline) => {
  const pulls = pullsOf(p);
  if (!kinds.includes('merge') || !pulls) return false;
  const main = await pulls.defaultBranch();
  const into = target.into ?? main;
  if ((await pulls.list({ into })).some(pull => pull.branch.startsWith('bothub/'))) return false;
  return (
    into === main || !kinds.includes('merge-request') || (await pulls.list({ branch: into, into: main })).length > 0
  );
};

/** The branch a job locks while it runs: its own, or the `into` it merges into. */
const lockOf = (target: Target, returns: Return[]) =>
  target.branch ?? (returnKinds(returns).includes('merge') ? target.into : undefined);

/** Takes the lock on `name` for `run`, waiting while another live run holds it, at most `minutes`. */
const waitForLock = async (name: string, run: string, minutes: number, p: Pipeline) => {
  const deadline = Date.now() + minutes * 60_000;
  for (let pause = 100; ; pause = Math.min(pause * 2, 5000)) {
    const held = await p.store.lock(name, run);
    if ('release' in held || Date.now() + pause > deadline) return held;
    await sleep(pause);
  }
};

/**
 * Runs `use` in a fresh worktree for `created`, at the job's branch when it exists, otherwise at `startOf`, an `into`
 * that does not exist yet created from the default branch first, holding the lock on `lock`. With `fresh`, it starts
 * from `startOf` even when the job's branch exists, to replace it. With `merge`, that branch is merged in for the job
 * to resolve. With `from`, it starts at that branch when it exists. The commit the worktree starts from is stored as the run's `base`; the worktree is always removed. A branch another
 * live run holds is waited for, at most `wait` minutes, then defers the job.
 */
const withWorktree = (
  created: Run,
  use: (worktree: Worktree) => Effect.Effect<JobResult>,
  handoff: Handoff,
  p: Pipeline,
  {
    target,
    lock,
    merge,
    wait,
    fresh,
    from,
  }: { target: Target; lock: string | undefined; merge?: string; wait: number; fresh?: boolean; from?: string }
): Effect.Effect<JobResult> => {
  const planned: PlannedJob = {
    workflow: created.workflow,
    job: created.job,
    ...(created.bot && { bot: created.bot }),
  };
  const fail = (error: string) =>
    Effect.promise(async (): Promise<JobResult> => {
      const run = await p.store.update(created.id, {
        status: 'failed',
        error,
        ...closed('blocked', error),
        endedAt: new Date().toISOString(),
      });
      return { ...planned, run };
    });
  return Effect.acquireUseRelease(
    Effect.promise(() =>
      lock ? waitForLock(`${p.event.repo}:${lock}`, created.id, wait, p) : Promise.resolve({ release: async () => {} })
    ),
    held =>
      'holder' in held
        ? Effect.promise(async (): Promise<JobResult> => {
            const reason = `branch "${lock}" is in use by run ${held.holder}`;
            const run = await p.store.update(created.id, { status: 'skipped', ...closed('deferred', reason) });
            return { ...planned, run };
          })
        : Effect.acquireUseRelease(
            Effect.tryPromise(async (): Promise<Worktree> => {
              const ref = await startOf(target, handoff, p);
              if (ref && ref === target.into) await pullsOf(p)?.ensureBranch(ref);
              const start = {
                repo: p.event.repo,
                ...(ref && { ref }),
                ...(target.branch && { branch: target.branch }),
                ...(merge && { merge }),
                ...(fresh && { fresh }),
                ...(from && { from }),
              };
              const worktree = await p.workspaces.create(start, created.id);
              await p.store.update(created.id, { base: worktree.base });
              const { path: cwd, base, conflicts, branch, replace } = worktree;
              const merging = merge !== undefined;
              return {
                id: created.id,
                cwd,
                base,
                conflicts,
                merging,
                ...(branch && { branch }),
                ...(replace && { replace }),
              };
            }),
            use,
            () => Effect.promise(() => p.workspaces.remove(p.event.repo, created.id))
          ).pipe(Effect.catchAll(e => fail(e.error instanceof Error ? e.error.message : String(e.error)))),
    held => Effect.promise(() => ('release' in held ? held.release() : Promise.resolve()))
  );
};

/**
 * The latest earlier run of this job on the event's issue, with its outcome, when it stopped unfinished: closed
 * blocked, or with its work parked, and not closed done or handed off. `parked` is the latest work a run parked since
 * the job last settled, which the next run starts from.
 */
const unfinished = async (planned: PlannedJob, created: Run, p: Pipeline) => {
  const { repo, number } = p.event;
  if (number === undefined) return;
  const { workflow, job } = planned;
  const runs = (await p.store.runs({ repo, number, workflow, job, check: false })).filter(r => r.id !== created.id);
  const last = runs.find(r => r.status !== 'skipped' || r.parked);
  if (!last || proceeds(last.closure) || (last.closure !== 'blocked' && !last.parked)) return;
  const kept = runs.find(r => r.parked || proceeds(r.closure));
  const parked = kept && !proceeds(kept.closure) ? kept.parked : undefined;
  return { run: last, outcome: await p.store.outcome(last.id), ...(parked && { parked }) };
};

type Unfinished = NonNullable<Awaited<ReturnType<typeof unfinished>>>;

const refunded: Stopped[] = ['turns', 'stalled', 'provider', 'sandbox', 'infra', 'human'];

/**
 * The attempts the step already used on the event's issue, which `tries` goes on counting: none when it starts over
 * or fans out, after work that closed done or handed off, or for a human's new command after a run that used them all.
 * An attempt that ended outside its bot's work (out of turns, a stall, a provider or sandbox fault, a fault that
 * outlasted its restarts, or a human's stop) does not count.
 */
const usedAttempts = async (planned: PlannedJob, step: Step, p: Pipeline) => {
  const { repo, number, id, actor } = p.event;
  if (!step.checks || number === undefined || planned.rerun === 'fresh' || step.over !== 'event') return 0;
  const { workflow } = planned;
  const runs = await p.store.runs({ repo, number, workflow, job: planned.job, check: false });
  const last = runs.find(r => r.attempt !== undefined);
  if (!last?.attempt || proceeds(last.closure)) return 0;
  const human = last.event.id !== id && !actor.login.endsWith('[bot]');
  const used = last.stopped && refunded.includes(last.stopped) ? last.attempt - 1 : last.attempt;
  return human && last.attempt >= triesOf(step) ? 0 : used;
};

/**
 * What a human said after `run` ended: the text that started this run, other human comments on the event's issue and
 * its merge request, and comments on the issues it asked in.
 */
const answers = async (run: Run, questions: string[], planned: PlannedJob, p: Pipeline) => {
  const said = (planned.args ?? p.event.body)?.trim();
  const issues = issuesOf(p);
  const { number } = p.event;
  if (!issues || number === undefined) return said ? [said] : [];
  const ended = run.endedAt ?? '';
  const asked = questions.length
    ? (await issues.list({ label: roles.unsure, state: 'all', parent: number })).filter(issue =>
        questions.some(question => issue.body.startsWith(question.trim()))
      )
    : [];
  const comments = await Promise.all(
    asked.map(async ({ number }) =>
      ((await issues.get(number))?.comments ?? [])
        .filter(comment => comment.ts > ended)
        .map(comment => `In #${number}: ${comment.body.trim()}`)
    )
  );
  return [...(said ? [said] : []), ...(await saidSince(ended, p.event.pull, p)), ...comments.flat()];
};

/** The failing checks of the last attempt up to `run` that ran its checks. */
const lastFailing = async (run: Run | undefined, p: Pipeline): Promise<string> => {
  if (!run) return '';
  const checks = (await p.store.outcome(run.id))?.checks;
  if (checks) return findingsFor(failingChecks(checks));
  return lastFailing(run.parent ? await p.store.read(run.parent) : undefined, p);
};

/**
 * The prompt section for a job that resumes its unfinished run: what it asked, or why it stopped and what its checks
 * last found, and the answer.
 */
const resumption = async ({ run, outcome, parked }: Unfinished, planned: PlannedJob, p: Pipeline) => {
  const questions = (outcome?.accepted ?? []).flatMap(proposal => (proposal.kind === 'ask' ? [proposal.question] : []));
  const said = await answers(run, questions, planned, p);
  const failing = questions.length ? '' : await lastFailing(run, p);
  return [
    '## Resuming',
    parked
      ? `Your earlier run ${run.id} stopped before finishing. Its work is parked on \`${parked}\` and already in this worktree: continue from it, do not start over.`
      : `Your earlier run ${run.id} stopped before finishing.`,
    questions.length
      ? `It asked:\n\n${questions.map(fenced).join('\n\n')}`
      : run.reason && `Why it stopped: ${run.reason}.`,
    failing && `Its checks last found:\n\n${failing}`,
    said.length
      ? `The human answered:\n\n${said.map(fenced).join('\n\n')}\n\nAn answer settles only what you asked. The issue's Done-when is still the scope: do not widen the change past it because of an answer.`
      : 'No answer was found; read the issue.',
  ]
    .filter(Boolean)
    .join('\n\n');
};

/** The reply `run` held back only because some of its checks could not run, with its work parked. */
const heldReply = async ({ run, outcome }: Unfinished, p: Pipeline) => {
  const failing = failingChecks(outcome?.checks ?? []);
  if (!run.parked || !failing.some(v => v.blocked) || failing.some(v => !v.blocked && holds(v, p))) return;
  let reply = '';
  for (const { event } of await p.store.events(run.id))
    if (event.type === 'text' || event.type === 'end')
      reply = (event.type === 'text' ? event.text : event.result) ?? reply;
  return reply;
};

/**
 * The worktree with the job's earlier work on the issue picked up, unless it starts over or resolves a merge: resumed
 * when its last run stopped unfinished (see `unfinished`), otherwise continued when the worktree started at the job's
 * branch, in a fresh session seeded with what the last run did (see `seeded`). Picked-up work is measured from where
 * the branch forked, so the checks see the whole change.
 * A run held only by checks that could not run hands its reply on as `recheck`.
 */
const picked = async (
  worktree: Worktree,
  planned: PlannedJob,
  created: Run,
  last: Unfinished | undefined,
  handoff: Handoff,
  target: Target,
  p: Pipeline
) => {
  if (planned.rerun === 'fresh' || worktree.merging) return worktree;
  const resume = last && (await resumption(last, planned, p));
  const bot = planned.bot === undefined ? undefined : p.config.bots[planned.bot];
  const continued = resume || !worktree.branch ? undefined : await continuing(planned, created, worktree.branch, p);
  const section = resume ?? continued?.section;
  if (!section) return worktree;
  const from = await startOf(target, handoff, p);
  const base = await p.workspaces.forkPoint(p.event.repo, worktree.id, from).catch(() => worktree.base);
  await p.store.update(created.id, { base });
  const seed = await seeded(
    bot && effectiveRun(p.config.hub, bot).context,
    last?.run ?? continued?.last,
    worktree.id,
    base,
    p
  );
  const recheck = last && (await heldReply(last, p));
  const sections = [section, seed && `What your last run did:\n\n${seed}`].filter(Boolean).join('\n\n');
  return { ...worktree, base, resume: sections, ...(recheck && { recheck }) };
};

/**
 * Parks the final state of a job's worktree, whatever it closed as, on a branch of its own beside the job's branch
 * (see `parkedBranch`), so no run's work is lost and the next run of the job on the issue resumes from it. Records
 * the parked branch on the run, or why it could not park in its reason.
 */
const park = async (result: JobResult, worktree: Worktree, target: Target, returns: Return[], p: Pipeline) => {
  const { branch } = target;
  if (!branch || !returnKinds(returns).includes('push')) return result;
  try {
    const { files } = await p.workspaces.changes(worktree.id, worktree.base);
    if (!files.length) return result;
    const parked = parkedBranch(branch, worktree.id);
    await p.workspaces.park(p.event.repo, worktree.id, parked, `bothub: ${result.job} (parked)`);
    return { ...result, run: await p.store.update(result.run.id, { parked }) };
  } catch (e) {
    const { reason, closure, status } = result.run;
    const why = `${reason ?? closure ?? status}; not parked: ${(e as Error).message}`;
    return { ...result, run: await p.store.update(result.run.id, { reason: why }) };
  }
};

/** Tells the event's issue that a job was deferred: why, where its work waits and how it goes on. */
const tellDeferred = async (result: JobResult, p: Pipeline) => {
  const issues = issuesOf(p);
  const { number } = p.event;
  if (result.run.closure !== 'deferred' || !issues || number === undefined) return;
  const { reason, parked } = result.run;
  const command = p.config.workflows[result.workflow]?.on.issue_comment?.command;
  const body = [
    `${result.workflow}/${result.job} was deferred${reason ? `: ${reason}` : ''}.`,
    parked && `Its work so far is parked on \`${parked}\`.`,
    command ? `Comment \`${command}\` to continue.` : 'It continues when it runs again.',
  ]
    .filter(Boolean)
    .join(' ');
  await issues.comment(number, body).catch(() => undefined);
};

/**
 * Runs one planned step in a fresh worktree: a script, or a bot running its skill until the step's checks pass.
 * Proposals are validated and applied only once the checks pass and a GitHub client or local tracker allows it. Every
 * attempt is stored as its own run, linked to the one before by `parent`; the worktree is always removed. A step
 * after another starts from the branch handed to it, which scripts and harnesses also get as `handoffEnv`. With
 * `merge`, the step runs again on its branch with that branch merged in, to resolve the conflicts. A `branch` or
 * `into` naming a value the event does not have blocks the step, a merging script step with nothing to do (see
 * `nothingToMerge`) is skipped, and a wait step closes blocked on a human.
 */
export const runPlanned = (
  planned: PlannedJob,
  p: Pipeline,
  handoff: Handoff = {},
  merge?: string
): Effect.Effect<JobResult> =>
  Effect.gen(function* () {
    const workflow = p.config.workflows[planned.workflow];
    const step = workflow?.steps[planned.job];
    if (!workflow || !step) return yield* Effect.promise(() => skip(planned, 'the step is not in the config', p));
    if (step.wait) return yield* Effect.promise(() => skip(planned, 'waits for a human', p, 'blocked'));
    const target = targetOf(
      step,
      { event: p.event, args: planned.args, step: planned.job, workflow: workflow.name },
      handoff
    );
    const unfilled = [target.branch, target.into].find(name => name?.includes('{'));
    if (unfilled)
      return yield* Effect.promise(() =>
        skip(planned, `"${unfilled}" names a value this event does not have`, p, 'blocked')
      );
    const { run } = step;
    if (run !== undefined && (yield* Effect.promise(() => nothingToMerge(returnKinds(step.returns ?? []), target, p))))
      return yield* Effect.promise(() => skip(planned, 'nothing to merge or propose', p, 'no-op'));
    const issue = yield* Effect.promise(() => issueDigest(p));
    if (run !== undefined) return yield* scriptStep(planned, { ...step, run }, handoff, target, p, issue);
    const bot = step.bot === undefined ? undefined : p.config.bots[step.bot];
    if (!bot) return yield* Effect.promise(() => skip(planned, 'the step has no bot', p));
    const used = yield* Effect.promise(() => usedAttempts(planned, step, p));
    const created = yield* Effect.promise(() =>
      p.store.create({
        workflow: planned.workflow,
        job: planned.job,
        bot: bot.name,
        harness: bot.harness,
        event: p.event,
        ...(step.checks && { attempt: 1 + used }),
        ...(issue && { issue }),
      })
    );
    const returns = effectiveReturns(bot, step);
    const last =
      planned.rerun === 'fresh' || merge ? undefined : yield* Effect.promise(() => unfinished(planned, created, p));
    if (last?.outcome?.accepted.some(proposal => proposal.kind === 'ask') && !p.event.actor.login.endsWith('[bot]'))
      yield* Effect.promise(() =>
        p.store.add(created.id, {
          type: 'human',
          on: 'answer',
          by: p.event.actor.login,
          at: p.event.ts,
          asked: last.run.id,
        })
      );
    return yield* withWorktree(
      created,
      started =>
        Effect.gen(function* () {
          const worktree = yield* Effect.promise(() => picked(started, planned, created, last, handoff, target, p));
          const result = yield* fanned(planned, workflow, step, created, worktree, handoff, p);
          const parked = yield* Effect.promise(() => park(result, worktree, target, returns, p));
          yield* Effect.promise(() => tellDeferred(parked, p));
          return parked;
        }),
      handoff,
      p,
      {
        target,
        lock: lockOf(target, returns),
        fresh: planned.rerun === 'fresh',
        ...(merge && { merge }),
        ...(last?.parked && { from: last.parked }),
        wait: step.minutes ?? p.config.hub.limits.minutes,
      }
    );
  });

/** A digest of the event's issue title and body, to tell later whether the issue changed. */
const issueDigest = async (p: Pipeline) => {
  const { number } = p.event;
  const issue =
    number === undefined
      ? undefined
      : await issuesOf(p)
          ?.get(number)
          .catch(() => undefined);
  return issue && digest(issue.title, issue.body);
};

export const proceeds = (closure: Closure | undefined) => closure === 'done' || closure === 'handed-off';

const reused = async (planned: PlannedJob, run: Run, p: Pipeline): Promise<JobResult> => {
  const outcome = await p.store.outcome(run.id);
  return { ...planned, run, ...(outcome && { outcome }) };
};

/**
 * The latest run of this event's step that already closed done or handed off, or that waits for a human, so a retry
 * does not redo it.
 */
const reuse = async (planned: PlannedJob, p: Pipeline): Promise<JobResult | undefined> => {
  const { workflow, job } = planned;
  const waits = p.config.workflows[workflow]?.steps[job]?.wait !== undefined;
  const earlier = await p.store.runs({ event: p.event.id, workflow, job, check: false });
  const run = earlier.find(r => (waits ? r.closure === 'blocked' : r.status === 'succeeded' && proceeds(r.closure)));
  return run && reused(planned, run, p);
};

/**
 * The step's latest run on the event's issue when it closed done or handed off, the step after it ran after it, and
 * the issue still reads as it did when that run started. A later command on the issue then picks up the step after it
 * without redoing this one, unless the issue changed, the command asks to rerun everything, or a wait step goes back
 * to this step.
 */
const answered = async (planned: PlannedJob, p: Pipeline): Promise<JobResult | undefined> => {
  const { repo, number } = p.event;
  const workflow = p.config.workflows[planned.workflow];
  if (number === undefined || !workflow || planned.rerun) return;
  const ids = Object.keys(workflow.steps);
  if (ids.some(id => workflow.steps[id]?.wait && backOf(workflow, id) === planned.job)) return;
  const next = nextOf(workflow, planned.job);
  const runs = await p.store.runs({ repo, number, workflow: planned.workflow, check: false });
  const at = runs.findIndex(r => r.job === planned.job && r.status !== 'skipped');
  const run = runs[at];
  if (run?.status !== 'succeeded' || !proceeds(run.closure)) return;
  if (!runs.slice(0, at).some(r => r.job === next)) return;
  return run.issue === (await issueDigest(p)) ? reused(planned, run, p) : undefined;
};

/** The pipeline with the event's parent issue filled in, when a planned step's `branch` or `into` names it. */
const withParent = async (planned: PlannedJob[], p: Pipeline): Promise<Pipeline> => {
  const { event } = p;
  const named = planned.some(({ workflow, job }) => {
    const step = p.config.workflows[workflow]?.steps[job];
    return [step?.branch, step?.into].some(name => name?.includes('{parent}'));
  });
  if (!named || event.parent !== undefined || event.number === undefined) return p;
  const parent = (await issuesOf(p)?.get(event.number))?.parent;
  return parent === undefined ? p : { ...p, event: { ...event, parent } };
};

/**
 * Runs planned steps workflow by workflow, in the order of the walk along `next` (see `stepOrder`). A step starts only
 * when the step before it closed `done` or `handed-off`, and starts from the branch and pull request it handed off. A
 * step of this event that already closed that way is reused rather than run again, as is one on the same issue whose
 * next step ran after it (see `answered`).
 */
export const runPlan = (planned: PlannedJob[], pipeline: Pipeline): Effect.Effect<JobResult[]> =>
  Effect.flatMap(
    Effect.promise(() => withParent(planned, pipeline)),
    p => runWorkflows(planned, p)
  );

const runWorkflows = (planned: PlannedJob[], p: Pipeline): Effect.Effect<JobResult[]> =>
  Effect.forEach(
    [...new Set(planned.map(j => j.workflow))],
    name =>
      Effect.gen(function* () {
        const workflow = p.config.workflows[name];
        const results: JobResult[] = [];
        const closures = new Map<string, Closure | undefined>();
        const handoffs = new Map<string, Handoff>();
        for (const id of workflow ? stepOrder(workflow).order : []) {
          const job = planned.find(j => j.workflow === name && j.job === id);
          if (!job || !workflow) continue;
          const before = stepsBefore(workflow, id);
          const blocked = before.filter(step => !proceeds(closures.get(step)));
          const handoff: Handoff = Object.assign({}, ...before.map(step => handoffs.get(step)));
          const reason = `waits for ${blocked.map(step => `"${step}" (${closures.get(step) ?? 'not run'})`).join(', ')} to be done`;
          const result = blocked.length
            ? yield* Effect.promise(() => skip(job, reason, p))
            : ((yield* Effect.promise(() => reuse(job, p))) ??
              (yield* Effect.promise(() => answered(job, p))) ??
              (yield* runPlanned(job, p, handoff)));

          closures.set(id, result.run.closure);
          const own: Handoff = ('outcome' in result && result.outcome) || {};
          handoffs.set(id, {
            ...handoff,
            ...(own.branch && { branch: own.branch }),
            ...(own.pr !== undefined && { pr: own.pr }),
          });
          results.push(result);
          p.onJob?.(result);
        }
        return results;
      }),
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(results => results.flat()));
