import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import { effectiveReturns, jobOrder, returnKinds } from '../config.ts';
import { isTrusted, type PlannedJob } from '../dispatch.ts';
import { digest } from '../fingerprint.ts';
import { parkedBranch } from '../workspace.ts';
import { fanOut } from '../over.ts';
import { roles, type Issues } from '../issues.ts';
import { approved, extractProposals, validate } from '../outputs.ts';
import { runScript, type ScriptResult } from '../runner.ts';
import type { Closure, Job, ProposalKind, Return } from '../schema.ts';
import type { Run, Store } from '../store.ts';
import type { BotEvent } from '../types.ts';
import { type JobResult, type Pipeline, issuesOf, launcher, pullsOf, skip } from './context.ts';
import { type Handoff, type Target, defaultMinutes, fenced, handoffEnv, targetOf } from './prompt.ts';
import { type Attempt, failingChecks, findingsFor, holds, issueEnv, runOnItem } from './checks.ts';
import { continuing, saidSince, sessionOf } from './continue.ts';
import { closed, finish, remember, settle } from './landing.ts';
import { type Worktree, defaultBranchFor, fanned, jobItems, proposalProblems, requestsEnv } from './attempt.ts';

/**
 * Runs a script job: once, or once per item its `over` names with the item in `BOTHUB_ITEM` and on stdin. It fails
 * when any run fails; the output of every run is stored on the job's run. A script that may return proposals ends
 * its output with a `bothub` block, validated and applied like a bot's; a script that may merge also gets the open
 * requests into its `into` from `requestsEnv`.
 */
const scriptJob = (
  planned: PlannedJob,
  job: Extract<Job, { type: 'script' }>,
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
    const timeout = job['timeout-minutes'] ?? defaultMinutes;
    const returns = job.returns ?? [];
    const kinds = returnKinds(returns);
    const once = (cwd: string, env: Record<string, string>) =>
      runScript(job.run, cwd, timeout, env, launcher(p), { hub: p.hub });
    const each = async (worktree: Worktree) => {
      const { items, error, scope } = await jobItems(job, worktree, handoff, p);
      if (error) return { ok: false, output: error, stdout: '' };
      const outputs: string[] = [];
      let stdout = '';
      let ok = true;
      let stopped: ScriptResult['stopped'];
      for (const item of items) {
        const result = await runOnItem(job.run, item, scope, p);
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
          fanOut(job.over) ? each(worktree) : once(worktree.cwd, env)
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
        const allowance = { returns, paths: job.paths, ...target, ...(defaultBranch && { defaultBranch }) };
        const validated = validate(extracted.proposals, allowance, job.mode);
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
          job,
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
 * whose branch goes into one, so every job into it forks from the same place, or the event's ref.
 */
const startOf = (target: Target, handoff: Handoff, p: Pipeline) =>
  handoff.branch ?? (target.branch && target.into && pullsOf(p) ? target.into : p.event.ref);

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
  const ref = startOf(target, handoff, p);
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
  const start = {
    repo: p.event.repo,
    ...(ref && { ref }),
    ...(target.branch && { branch: target.branch }),
    ...(merge && { merge }),
    ...(fresh && { fresh }),
    ...(from && { from }),
  };
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
              if (ref && ref === target.into) await pullsOf(p)?.ensureBranch(ref);
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
 * blocked, or deferred with its work parked.
 */
const unfinished = async (planned: PlannedJob, created: Run, p: Pipeline) => {
  const { repo, number } = p.event;
  if (number === undefined) return;
  const { workflow, job } = planned;
  const last = (await p.store.runs({ repo, number, workflow, job, check: false })).find(
    r => r.id !== created.id && (r.status !== 'skipped' || r.parked)
  );
  if (!last || (last.closure !== 'blocked' && !last.parked)) return;
  return { run: last, outcome: await p.store.outcome(last.id) };
};

type Unfinished = NonNullable<Awaited<ReturnType<typeof unfinished>>>;

/**
 * The attempts the job already used on the event's issue, which `until.max` goes on counting: none when it starts over
 * or fans out, after work that closed done or handed off, or for a human's new command after a run that used them all.
 */
const usedAttempts = async (planned: PlannedJob, job: Extract<Job, { type: 'bot' }>, p: Pipeline) => {
  const { repo, number, id, actor } = p.event;
  if (!job.until || number === undefined || planned.rerun === 'fresh' || job.over !== 'event') return 0;
  const { workflow } = planned;
  const runs = await p.store.runs({ repo, number, workflow, job: planned.job, check: false });
  const last = runs.find(r => r.attempt !== undefined);
  if (!last?.attempt || proceeds(last.closure)) return 0;
  const human = last.event.id !== id && !actor.login.endsWith('[bot]');
  return human && last.attempt > job.until.max ? 0 : last.attempt;
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
const resumption = async ({ run, outcome }: Unfinished, planned: PlannedJob, p: Pipeline) => {
  const questions = (outcome?.accepted ?? []).flatMap(proposal => (proposal.kind === 'ask' ? [proposal.question] : []));
  const said = await answers(run, questions, planned, p);
  const failing = questions.length ? '' : await lastFailing(run, p);
  return [
    '## Resuming',
    run.parked
      ? `Your earlier run ${run.id} stopped before finishing. Its work is parked on \`${run.parked}\` and already in this worktree: continue from it, do not start over.`
      : `Your earlier run ${run.id} stopped before finishing.`,
    questions.length
      ? `It asked:\n\n${questions.map(fenced).join('\n\n')}`
      : run.reason && `It stopped because ${run.reason}.`,
    failing && `Its checks last found:\n\n${failing}`,
    said.length ? `The human answered:\n\n${said.map(fenced).join('\n\n')}` : 'No answer was found; read the issue.',
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
 * when its last run stopped unfinished (see `unfinished`), in that run's session with `resume: session`, otherwise
 * continued when the worktree started at the job's branch. Picked-up work is measured from where the branch forked, so the checks see the whole change.
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
  const continued =
    resume || !worktree.branch ? undefined : await continuing(planned, created, worktree.branch, bot?.resume, p);
  const section = resume ?? continued?.section;
  if (!section) return worktree;
  const session = last && bot?.resume === 'session' ? await sessionOf(last.run, p) : continued?.session;
  const from = startOf(target, handoff, p);
  const base = await p.workspaces.forkPoint(p.event.repo, worktree.id, from).catch(() => worktree.base);
  await p.store.update(created.id, { base });
  const recheck = last && (await heldReply(last, p));
  return { ...worktree, base, resume: section, ...(session && { session }), ...(recheck && { recheck }) };
};

/**
 * Parks the work of a job that stopped unfinished, blocked or deferred, beside its branch (see `parkedBranch`), so the
 * branch and its merge request only get work that settled, and the next run of the job on the issue resumes from it.
 * Records the parked branch on the run; work the job may not push stays unparked, with the reason.
 */
const park = async (
  result: JobResult,
  worktree: Worktree,
  job: Job,
  target: Target,
  returns: Return[],
  p: Pipeline
) => {
  const { closure } = result.run;
  if ((closure !== 'blocked' && closure !== 'deferred') || worktree.merging) return result;
  const { branch } = target;
  if (!branch || !returnKinds(returns).includes('push')) return result;
  try {
    const { files } = await p.workspaces.changes(worktree.id, worktree.base);
    if (!files.length) return result;
    const parked = parkedBranch(branch);
    await p.workspaces.publish(p.event.repo, worktree.id, {
      branch: parked,
      files,
      ...(job.paths && { paths: job.paths }),
      message: `bothub: ${result.job} (parked)`,
      base: worktree.base,
    });
    return { ...result, run: await p.store.update(result.run.id, { parked }) };
  } catch (e) {
    const reason = `${result.run.reason ?? closure}; not parked: ${(e as Error).message}`;
    return { ...result, run: await p.store.update(result.run.id, { reason }) };
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
 * Runs one planned job in a fresh worktree: a script, or a bot running its skill until the job's checks pass.
 * Proposals are validated and applied only once the checks pass and the mode and a GitHub client allow it. Every
 * attempt is stored as its own run, linked to the one before by `parent`; the worktree is always removed. A job
 * that needs another starts from the branch handed to it, which scripts and harnesses also get as `handoffEnv`. With
 * `merge`, the job runs again on its branch with that branch merged in, to resolve the conflicts. A `branch` or
 * `into` naming a value the event does not have blocks the job, and a merging script job with nothing to do (see
 * `nothingToMerge`) is skipped.
 */
export const runPlanned = (
  planned: PlannedJob,
  p: Pipeline,
  handoff: Handoff = {},
  merge?: string
): Effect.Effect<JobResult> =>
  Effect.gen(function* () {
    const workflow = p.config.workflows[planned.workflow];
    const job = workflow?.jobs[planned.job];
    if (!workflow || !job) return yield* Effect.promise(() => skip(planned, 'the job is not in the config', p));
    const target = targetOf(
      job,
      { event: p.event, args: planned.args, job: planned.job, workflow: workflow.name },
      handoff
    );
    const unfilled = [target.branch, target.into].find(name => name?.includes('{'));
    if (unfilled)
      return yield* Effect.promise(() =>
        skip(planned, `"${unfilled}" names a value this event does not have`, p, 'blocked')
      );
    if (
      job.type === 'script' &&
      (yield* Effect.promise(() => nothingToMerge(returnKinds(job.returns ?? []), target, p)))
    )
      return yield* Effect.promise(() => skip(planned, 'nothing to merge or propose', p, 'no-op'));
    const issue = yield* Effect.promise(() => issueDigest(p));
    if (job.type === 'script') return yield* scriptJob(planned, job, handoff, target, p, issue);
    const bot = p.config.bots[job.bot];
    if (!bot) return yield* Effect.promise(() => skip(planned, 'the job has no bot', p));
    const used = yield* Effect.promise(() => usedAttempts(planned, job, p));
    const created = yield* Effect.promise(() =>
      p.store.create({
        workflow: planned.workflow,
        job: planned.job,
        bot: bot.name,
        harness: bot.harness,
        event: p.event,
        ...(job.until && { attempt: 1 + used }),
        ...(issue && { issue }),
      })
    );
    const returns = effectiveReturns(bot, job);
    const last =
      planned.rerun === 'fresh' || merge ? undefined : yield* Effect.promise(() => unfinished(planned, created, p));
    return yield* withWorktree(
      created,
      started =>
        Effect.gen(function* () {
          const worktree = yield* Effect.promise(() => picked(started, planned, created, last, handoff, target, p));
          const result = yield* fanned(planned, workflow, job, created, worktree, handoff, p);
          const parked = yield* Effect.promise(() => park(result, worktree, job, target, returns, p));
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
        ...(last?.run.parked && { from: last.run.parked }),
        wait: job['timeout-minutes'] ?? defaultMinutes,
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

/** The latest run of this event's job that already closed done or handed off, so a retry does not redo it. */
const reuse = async (planned: PlannedJob, p: Pipeline): Promise<JobResult | undefined> => {
  const { workflow, job } = planned;
  const earlier = await p.store.runs({ event: p.event.id, workflow, job, check: false });
  const run = earlier.find(r => r.status === 'succeeded' && proceeds(r.closure));
  return run && reused(planned, run, p);
};

/**
 * The job's latest run on the event's issue when it closed done or handed off, a job that needs it ran after it, and
 * the issue still reads as it did when that run started. A later command on the issue then picks up the job that
 * needs it without redoing this one, unless the issue changed or the command asks to rerun everything.
 */
const answered = async (planned: PlannedJob, p: Pipeline): Promise<JobResult | undefined> => {
  const { repo, number } = p.event;
  const jobs = p.config.workflows[planned.workflow]?.jobs;
  if (number === undefined || !jobs || planned.rerun) return;
  const runs = await p.store.runs({ repo, number, workflow: planned.workflow, check: false });
  const at = runs.findIndex(r => r.job === planned.job && r.status !== 'skipped');
  const run = runs[at];
  if (run?.status !== 'succeeded' || !proceeds(run.closure)) return;
  if (!runs.slice(0, at).some(r => jobs[r.job]?.needs.includes(planned.job))) return;
  return run.issue === (await issueDigest(p)) ? reused(planned, run, p) : undefined;
};

/**
 * Holds a job with an `environment` until a human approves it: an `unsure` issue under the event's issue asks for the
 * `approved` label. Resolves to the blocked result, or to nothing once approved.
 */
const gate = async (planned: PlannedJob, job: Job, p: Pipeline): Promise<JobResult | undefined> => {
  const { environment } = job;
  if (!environment) return;
  const issues = issuesOf(p);
  if (!issues)
    return skip(planned, `environment "${environment}" needs an issue tracker to ask for approval`, p, 'blocked');
  const { number: parent, actor, repo, url } = p.event;
  const title = `Approve ${planned.workflow}/${planned.job}${parent !== undefined ? ` for #${parent}` : ''} in ${environment}`;
  const scope = { label: roles.unsure, state: 'all', ...(parent !== undefined && { parent }) } as const;
  const asked = (await issues.list(scope)).find(issue => issue.title === title);
  if (asked?.labels.includes(approved)) {
    const waiting = (await p.store.runs({ event: p.event.id, job: planned.job })).filter(
      r => r.closure === 'blocked' && r.approval === asked.number
    );
    for (const run of waiting) await p.store.update(run.id, closed('done', `approved in #${asked.number}`));
    return;
  }
  const issue =
    asked ??
    (await issues.create({
      title,
      body: `Add the label \`${approved}\` to let ${planned.workflow}/${planned.job} run in \`${environment}\` for ${url ?? repo}.`,
      labels: [roles.unsure],
      ...(parent !== undefined && { parent }),
    }));
  if (!asked && parent !== undefined) await issues.comment(parent, `@${actor.login} needs a human: #${issue.number}`);
  return skip(planned, `waiting for approval in #${issue.number}`, p, 'blocked', { approval: issue.number });
};

/**
 * The events to run again because a trusted human approved a job they hold: `issues` `labeled` on an approval issue
 * that now carries the `approved` label, with a blocked job waiting on it. Planning and running such an event again reuses the jobs that already closed.
 */
export const approvals = async (event: BotEvent, store: Store, issues: Issues): Promise<BotEvent[]> => {
  if (event.trigger !== 'issues' || event.action !== 'labeled' || event.number === undefined) return [];
  if (!isTrusted(event.actor.association)) return [];
  if (!(await issues.get(event.number))?.labels.includes(approved)) return [];
  const waiting = (await store.runs({ repo: event.repo })).filter(
    run => run.status === 'skipped' && run.closure === 'blocked' && run.approval === event.number
  );
  return [...new Map(waiting.map(run => [run.event.id, run.event])).values()];
};

/**
 * Runs planned jobs workflow by workflow, each in dependency order. A job starts only when every job it needs closed
 * `done` or `handed-off`, and starts from the branch and pull request they handed off. A job of this event that
 * already closed that way is reused rather than run again, as is one on the same issue whose dependent blocked after
 * it, and a job with an `environment` waits for approval.
 */
/** The pipeline with the event's parent issue filled in, when a planned job's `branch` or `into` names it. */
const withParent = async (planned: PlannedJob[], p: Pipeline): Promise<Pipeline> => {
  const { event } = p;
  const named = planned.some(({ workflow, job }) => {
    const definition = p.config.workflows[workflow]?.jobs[job];
    return [definition?.branch, definition?.into].some(name => name?.includes('{parent}'));
  });
  if (!named || event.parent !== undefined || event.number === undefined) return p;
  const parent = (await issuesOf(p)?.get(event.number))?.parent;
  return parent === undefined ? p : { ...p, event: { ...event, parent } };
};

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
        for (const id of workflow ? jobOrder(workflow) : []) {
          const job = planned.find(j => j.workflow === name && j.job === id);
          const definition = workflow?.jobs[id];
          if (!job || !definition) continue;
          const blocked = definition.needs.filter(need => !proceeds(closures.get(need)));
          const handoff: Handoff = Object.assign({}, ...definition.needs.map(need => handoffs.get(need)));
          const reason = `needs ${blocked.map(need => `"${need}" (${closures.get(need) ?? 'not run'})`).join(', ')} to be done`;
          const result = blocked.length
            ? yield* Effect.promise(() => skip(job, reason, p))
            : ((yield* Effect.promise(() => reuse(job, p))) ??
              (yield* Effect.promise(() => answered(job, p))) ??
              (yield* Effect.promise(() => gate(job, definition, p))) ??
              (yield* runPlanned(job, p, handoff)));
          closures.set(id, result.run.closure);
          const own: Handoff = ('outcome' in result && result.outcome) || {};
          handoffs.set(id, {
            ...handoff,
            ...(own.branch && { branch: own.branch }),
            ...(own.pr !== undefined && { pr: own.pr }),
          });
          results.push(result);
        }
        return results;
      }),
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(results => results.flat()));
