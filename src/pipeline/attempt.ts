import { stripVTControlCharacters } from 'node:util';
import { Effect } from 'effect';
import { effectivePreload, returnKinds, type Defined } from '../config.ts';
import type { PlannedJob } from '../dispatch.ts';
import { harnesses } from '../harnesses/index.ts';
import { readJsonl } from '../jsonl.ts';
import { fanOut, type Item } from '../over.ts';
import { proposalsFile } from '../mcp.ts';
import { extractProposals, matchGlob, Proposal, validate, type Validated } from '../outputs.ts';
import { issueContext } from '../preload.ts';
import type { Job, ProposalKind, Workflow } from '../schema.ts';
import type { Pulls } from '../pulls.ts';
import type { Run, Store } from '../store.ts';
import type { RunSpec } from '../types.ts';
import { unresolved } from '../workspace.ts';
import { type JobResult, type Pipeline, agent, issuesOf, pullsOf } from './context.ts';
import { type Handoff, type Target, buildSpec, defaultMinutes, fenced, handoffEnv } from './prompt.ts';
import {
  type Attempt,
  type Scope,
  conflictSection,
  couldNotRun,
  failingChecks,
  findingsFor,
  followUp,
  gather,
  holds,
  issueEnv,
  itemSection,
  runChecks,
} from './checks.ts';
import { carried, onRequest, openerOf, seeded, sessionOf } from './continue.ts';
import { closed, finish, postSummary, settle } from './landing.ts';
import { proceeds } from './jobs.ts';
import { authFailure } from '../preflight.ts';

/** The issue context a planned job preloads, read from `issues`, or GitHub's issues when only `gh` is given. */
const preloadFor = async (planned: PlannedJob, workflow: Defined<Workflow>, p: Pipeline) => {
  const job = workflow.jobs[planned.job];
  const bot = job?.type === 'bot' ? p.config.bots[job.bot] : undefined;
  if (job?.type !== 'bot' || !bot) return;
  return issueContext(issuesOf(p), p.event, effectivePreload(bot, job));
};

/**
 * Why a finished run's reply cannot be acted on, for a job that may propose something: its proposal block did not
 * parse, every proposal was rejected, or it proposed nothing at all.
 */
export const proposalProblems = (
  extracted: ReturnType<typeof extractProposals>,
  validated: Validated,
  kinds: ProposalKind[]
): string[] => {
  if (!kinds.length) return [];
  if (extracted.errors.length) return extracted.errors;
  if (validated.rejected.length && !validated.accepted.length)
    return validated.rejected.map(({ proposal, reason }) => `\`${proposal.kind}\` was rejected: ${reason}`);
  if (!extracted.proposals.length)
    return [
      'the reply has no bothub block; end with your proposals, or a `close` proposal when there is nothing to do',
    ];
  return [];
};

/** Whether a finished reply has text but no readable proposals block, which a format-only follow-up can fix. */
const unformatted = (extracted: ReturnType<typeof extractProposals>, final: string) =>
  Boolean(final.trim()) && (extracted.errors.length > 0 || !extracted.proposals.length);

/**
 * The follow-up that asks only for the proposals block of the last reply, with why the block could not be read and,
 * when the session is not continued, the reply itself.
 */
const formatOnly = (errors: string[], last?: string) =>
  [
    errors.length
      ? `The \`\`\`bothub block in your last message could not be read:\n\n${errors.map(error => `- ${error}`).join('\n')}\n\nReply with only the corrected block for what you wrote, nothing else.`
      : 'Your last message has no ```bothub block. Reply with only the block for what you wrote, nothing else.',
    last && `Your last message:\n\n${fenced(last)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

/** The notes a run proposed with `notes_add`, ahead of those in its final message. */
const withTools = async (extracted: ReturnType<typeof extractProposals>, run: Run, p: Pipeline) => {
  const recorded = (await readJsonl(proposalsFile(p.store.home(run.id)))).flatMap(line => {
    const parsed = Proposal.safeParse(line);
    return parsed.success ? [parsed.data] : [];
  });
  return recorded.length ? { ...extracted, proposals: [...recorded, ...extracted.proposals] } : extracted;
};

/** Whether a run failed before its bot did anything, for no reason outside its work. */
const diedEarly = async (run: Run, p: Pipeline) =>
  run.status === 'failed' &&
  !run.stopped &&
  (await p.store.events(run.id)).every(({ event }) => event.type === 'start' || event.type === 'error');

const infraWait = 10_000;

/**
 * Runs `ran` on `current`, and when it died before its bot did anything, once more on a new run after `infraWait`. A
 * second such death stops that run as `infra`, which defers the job. An authentication error is not retried.
 */
const retried = (ran: (run: Run) => ReturnType<typeof agent>, current: Run, p: Pipeline) =>
  Effect.gen(function* () {
    const first = yield* ran(current);
    if (!(yield* Effect.promise(() => diedEarly(first.run, p)))) return first;
    let again = first;
    if (!authFailure(first.run.error)) {
      yield* Effect.sleep(infraWait);
      const {
        id,
        status: _status,
        error: _error,
        owner: _owner,
        startedAt: _start,
        endedAt: _end,
        ...same
      } = first.run;
      again = yield* ran(yield* Effect.promise(() => p.store.create({ ...same, parent: id })));
      if (!(yield* Effect.promise(() => diedEarly(again.run, p)))) return again;
    }
    const why = stripVTControlCharacters(again.run.error ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const error = `the bot's run died ${again === first ? 'on an authentication error' : 'twice'} before it did anything${why ? ` (${why.slice(0, 200)})` : ''}`;
    return { ...again, run: yield* Effect.promise(() => p.store.update(again.run.id, { stopped: 'infra', error })) };
  });

/** How many model calls the harness itself made in `run`. */
const turnsOf = async (run: Run, p: Pipeline) =>
  (await p.store.events(run.id)).filter(({ event }) => event.type === 'usage' && !event.source).length;

const costOf = async (ids: string[], store: Store) =>
  (await Promise.all(ids.map(id => store.read(id)))).reduce((sum, run) => sum + (run?.costUsd ?? 0), 0);

/**
 * A run's worktree: the run that owns it, its path, the commit its change is measured from, while it resolves a
 * merge (`merging`) the files that merge left conflicting, the job's `branch` when it started there or the branch tip
 * it replaces (`replace`) when it started over, and when it picks up an earlier run's work, the prompt section that
 * says so.
 */
export type Worktree = {
  id: string;
  cwd: string;
  base: string;
  conflicts: string[];
  merging: boolean;
  branch?: string;
  replace?: string;
  resume?: string;
  recheck?: string;
};

/** The default branch, when the job may open merge requests and there is a backend to ask. */
export const defaultBranchFor = async (kinds: ProposalKind[], p: Pipeline) =>
  kinds.includes('merge-request')
    ? pullsOf(p)
        ?.defaultBranch()
        .catch(() => undefined)
    : undefined;

/**
 * Runs the job's bot, then its `until` checks. While a check that holds the change fails, its findings go back as a
 * new attempt in the same worktree but a fresh session (see `seeded`), with the findings of failing `warn` checks
 * alongside; once none fails, the attempt settles with whatever the `warn` checks found. While it resolves a merge, conflict markers left in the conflicting
 * files count as a failing check. Attempts number on from `first`'s, and the loop stops past `until.max` follow-ups
 * in that count, or once the attempts and checks have spent the bot's `usd-per-run`. An `item` of a fan-out adds its
 * section to the prompt. A reply with text but no readable proposals block first gets one format-only follow-up
 * attempt, in the same session when the harness can continue it, which `until.max` does not count. An agent that
 * died before doing anything runs once more (see `retried`). An attempt that uses all of the bot's `max-turns` goes on
 * once under the same attempt number and in its session; running out again defers the job. With a `recheck` reply, the first attempt
 * takes that reply instead of running the bot, so only the checks run again.
 */
const attempts = (
  planned: PlannedJob,
  workflow: Defined<Workflow>,
  first: Run,
  worktree: Worktree,
  handoff: Handoff,
  p: Pipeline,
  item?: { index: number; section: string | undefined; fold?: Attempt['fold'] }
) =>
  Effect.gen(function* () {
    const { cwd, base, merging } = worktree;
    const preloaded = yield* Effect.promise(() => preloadFor(planned, workflow, p));
    const built = buildSpec({
      ...planned,
      config: p.config,
      workflow,
      event: p.event,
      cwd,
      preloaded,
      handoff,
      ...(p.mcp && { mcp: p.mcp }),
      ...(p.hub && { hub: p.hub }),
      ...(p.data && { data: p.data }),
    });
    const { bot, job, returns, branch, into, timeoutMinutes } = built;
    const target: Target = { ...(branch && { branch }), ...(into && { into }) };
    const kinds = returnKinds(returns);
    const defaultBranch = yield* Effect.promise(() => defaultBranchFor(kinds, p));
    const env = handoffEnv(handoff);
    const max = job.until?.max ?? 1;
    const cap = bot.budget?.['usd-per-run'];
    let spent = 0;
    const broke = () => cap !== undefined && spent >= cap;
    const overBudget = (what: string, attempt: number) =>
      `spent $${spent.toFixed(2)} of the $${cap} budget in ${attempt} attempts with ${what}`;
    let parent = first;
    const task = [
      built.spec.prompt,
      worktree.resume,
      item?.section,
      merging ? conflictSection(worktree.conflicts) : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');
    let prompt = task;
    let session: RunSpec['session'];
    let reformats = 0;
    let reformatting = false;
    let resumed = false;
    let reuse = true;
    const start = first.attempt ?? 1;
    for (let attempt = start; ; attempt++) {
      const current = reuse
        ? first
        : yield* Effect.promise(() =>
            p.store.create({
              ...planned,
              bot: bot.name,
              harness: bot.harness,
              event: p.event,
              parent: parent.id,
              attempt,
            })
          );
      const spec = { ...built.spec, prompt, ...(session && { session }) };
      const recheck = reuse && !item ? worktree.recheck : undefined;
      reuse = false;
      const now = new Date().toISOString();
      const { run, final } =
        recheck === undefined
          ? yield* retried(on => agent(bot, spec, timeoutMinutes, on, p, env), current, p)
          : {
              run: yield* Effect.promise(() =>
                p.store.update(current.id, { status: 'succeeded', startedAt: now, endedAt: now })
              ),
              final: recheck,
            };
      spent += run.costUsd ?? 0;
      const extracted = yield* Effect.promise(() => withTools(extractProposals(final), run, p));
      const allowance = { returns, paths: job.paths, ...target, ...(defaultBranch && { defaultBranch }) };
      const validated = validate(extracted.proposals, allowance, job.mode);
      const replies = extracted.proposals.flatMap(proposal =>
        proposal.kind === 'reply' || proposal.kind === 'merge-request' ? [proposal.body] : []
      );
      const a: Attempt = {
        planned,
        job,
        worktree: worktree.id,
        cwd,
        base,
        parent: run,
        handoff,
        target,
        ...(worktree.replace && { replace: worktree.replace }),
        ...(item && { item: item.index }),
        ...(item?.fold && { fold: item.fold }),
        ...(merging && { merging }),
        ...(replies.length && { reply: replies.join('\n\n') }),
      };
      const turns = spec.maxTurns;
      if (turns && !run.stopped && (yield* Effect.promise(() => turnsOf(run, p))) >= turns) {
        const error = `used all ${turns} turns${resumed ? ' twice' : ''}`;
        const capped = yield* Effect.promise(() =>
          p.store.update(run.id, { status: 'failed', stopped: 'turns', error })
        );
        const outcome = yield* Effect.promise(() => settle(capped, extracted, validated, undefined, a, p));
        if (resumed) return yield* finish(planned, capped, outcome, kinds, p, merging);
        const next = yield* Effect.promise(() => carried(bot.resume, run, p));
        session = next.session;
        prompt = `${followUp(task, [], [], attempt, max + 1, [], next.summary)}\n\n## Out of turns\n\nYour last attempt used all ${turns} turns before it finished. Its changes are still in this worktree. Finish the work, then end with your proposals.`;
        parent = capped;
        resumed = true;
        attempt--;
        continue;
      }
      const succeeded = run.status === 'succeeded';
      const problems = succeeded ? proposalProblems(extracted, validated, kinds) : [];
      const reformat = !reformatting && succeeded && problems.length > 0 && unformatted(extracted, final);
      reformatting = false;
      if (problems.length) {
        const error = problems.join('; ');
        const tries = attempt - reformats;
        if ((!reformat && tries > max) || broke()) {
          const failed = yield* Effect.promise(() =>
            p.store.update(run.id, {
              status: 'failed',
              error: broke()
                ? `${overBudget('no usable proposals', attempt)}: ${error}`
                : `no usable proposals after ${attempt} attempts: ${error}`,
            })
          );
          const outcome = yield* Effect.promise(() => settle(failed, extracted, validated, undefined, a, p));
          return yield* finish(planned, failed, outcome, kinds, p, merging);
        }
        const failed = yield* Effect.promise(() => p.store.update(run.id, { status: 'failed', error }));
        yield* Effect.promise(() => settle(failed, extracted, validated, undefined, a, p));
        parent = failed;
        if (reformat) {
          const resumes = (p.adapters ?? harnesses)[bot.harness].sessions !== undefined;
          const resumed = resumes ? yield* Effect.promise(() => sessionOf(run, p)) : undefined;
          session = resumed;
          prompt = formatOnly(extracted.errors, resumed ? undefined : final);
          reformats++;
          reformatting = true;
          continue;
        }
        const earlier = yield* Effect.promise(() => seeded(bot.resume, run, worktree.id, base, p));
        session = undefined;
        prompt = followUp(task, [], [], tries + 1, max + 1, problems, earlier);
        continue;
      }
      const left = succeeded && merging ? yield* Effect.promise(() => unresolved(cwd, worktree.conflicts)) : [];
      if (!succeeded || (!job.until && !left.length)) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, succeeded ? validated.accepted : undefined, a, p)
        );
        return yield* finish(planned, run, outcome, kinds, p, merging);
      }

      const stopped = validated.accepted.find(proposal => proposal.kind === 'close');
      if (stopped) {
        const stays = (proposal: Proposal) => proposal.kind === 'ask' || proposal.kind === 'close';
        const kept = validated.accepted.filter(stays);
        const held = validated.accepted
          .filter(proposal => !stays(proposal))
          .map(proposal => ({ proposal, reason: `the bot stopped: ${stopped.reason}` }));
        const outcome = yield* Effect.promise(() =>
          settle(
            run,
            extracted,
            { ...validated, accepted: kept, rejected: [...validated.rejected, ...held] },
            kept,
            a,
            p
          )
        );
        return yield* finish(planned, run, outcome, kinds, p, merging);
      }

      const checks = yield* runChecks(job.until?.checks ?? [], a, p);
      spent += yield* Effect.promise(() =>
        costOf(
          checks.flatMap(v => v.runs ?? []),
          p.store
        )
      );
      const failing = failingChecks(checks);
      const holding = failing.filter(v => holds(v, p));
      const fixable = failing.filter(v => !v.blocked);
      const blocked = failing.filter(v => v.blocked);
      const exhausted = attempt - reformats > max || broke();
      const verdicts = job.until ? checks : undefined;
      if (!holding.length && !blocked.length && !left.length) {
        const outcome = yield* Effect.promise(() =>
          settle(run, extracted, validated, validated.accepted, a, p, verdicts)
        );
        const done = yield* finish(planned, run, outcome, kinds, p, merging);
        const dead = checks.filter(v => !v.pass && !v.gating && holds(v, p) && v.findings?.startsWith('red on base'));
        if (done.run.closure !== 'done' || !dead.length) return done;
        const reason = `checks still failing, red on base: ${dead.map(v => v.check).join(', ')}`;
        const blocked = yield* Effect.promise(() => p.store.update(done.run.id, closed('blocked', reason)));
        return { ...done, run: blocked };
      }

      /** Holds every proposal but the asks and asks a human `question`; a `failed` reason also fails the run. */
      const askHuman = (reason: string, question: string, failed?: string) =>
        Effect.gen(function* () {
          const ask: Proposal = { kind: 'ask', question };
          const asks = [...validated.accepted.filter(proposal => proposal.kind === 'ask'), ask];
          const held = validated.accepted
            .filter(proposal => proposal.kind !== 'ask')
            .map(proposal => ({ proposal, reason }));
          const ended = failed
            ? yield* Effect.promise(() => p.store.update(run.id, { status: 'failed', error: failed }))
            : run;
          const outcome = yield* Effect.promise(() =>
            settle(
              ended,
              { ...extracted, proposals: [...extracted.proposals, ask] },
              { ...validated, accepted: asks, rejected: [...validated.rejected, ...held] },
              asks,
              a,
              p,
              verdicts
            )
          );
          return yield* finish(planned, ended, outcome, kinds, p, merging);
        });

      if (blocked.length) {
        const reason = `checks could not run: ${blocked.map(v => `${v.check} (${v.findings?.split('\n')[0] ?? 'no output'})`).join(', ')}`;
        return yield* askHuman(reason, couldNotRun(blocked));
      }

      if (exhausted) {
        const what = [holding.length && 'checks still failing', left.length && 'merge conflicts left'].filter(Boolean);
        const reason = broke()
          ? overBudget(what.join(' and '), attempt)
          : `${what.join(' and ')} after ${attempt} attempts`;
        const names = [...holding.map(v => v.check), ...left].join(', ');
        const question = `${reason}: ${names}. The findings are in run ${run.id}.\n\n${findingsFor(holding)}`;
        return yield* askHuman(reason, question.trim(), reason);
      }

      yield* Effect.promise(() => settle(run, extracted, validated, undefined, a, p, verdicts));
      const ran = recheck === undefined ? run : undefined;
      const earlier = yield* Effect.promise(() => seeded(bot.resume, ran, worktree.id, base, p));
      session = undefined;
      prompt = followUp(task, fixable, validated.rejected, attempt - reformats + 1, max + 1, [], earlier, left);
      parent = run;
    }
  });

/**
 * Where a job's change starts: for a handed-off branch, where it forked from the event's ref or the default branch;
 * for a pull request, where it forked from its base branch; otherwise the commit the worktree started from.
 */
const changeStart = (worktree: Worktree, handoff: Handoff, p: Pipeline) => {
  const { ref, branch, repo } = p.event;
  const from = handoff.branch ? (ref ?? '') : branch && ref !== `refs/heads/${branch}` ? branch : undefined;
  if (from === undefined) return Promise.resolve(worktree.base);
  return p.workspaces.forkPoint(repo, worktree.id, from || undefined).catch(() => worktree.base);
};

/** The items a job's `over` names, from its change limited to its `paths`, and the scope to run scripts on them in. */
export const jobItems = async (job: Job, worktree: Worktree, handoff: Handoff, p: Pipeline) => {
  const since = await changeStart(worktree, handoff, p);
  const { paths } = job;
  const changed = paths ? (await p.workspaces.changes(worktree.id, since)).files : [];
  const scope: Scope = {
    worktree: worktree.id,
    cwd: worktree.cwd,
    since,
    files: changed.filter(file => paths?.some(glob => matchGlob(glob, file))),
    timeout: job['timeout-minutes'] ?? defaultMinutes,
    env: { ...handoffEnv(handoff), ...issueEnv(p), BOTHUB_BASE: worktree.base },
  };
  if (paths && !scope.files.length) return { items: [], scope };
  return { ...(await gather(job.over, scope, p)), scope };
};

/**
 * Runs a bot job once, or once per item its `over` names, each item as its own chain of attempts in the same
 * worktree. Stops at the first item that does not close done or handed off.
 */
export const fanned = (
  planned: PlannedJob,
  workflow: Defined<Workflow>,
  job: Extract<Job, { type: 'bot' }>,
  first: Run,
  worktree: Worktree,
  handoff: Handoff,
  p: Pipeline
) =>
  Effect.gen(function* () {
    if (job.over === 'event') return yield* attempts(planned, workflow, first, worktree, handoff, p);
    const { items, error } = yield* Effect.promise(() => jobItems(job, worktree, handoff, p));
    if (error || !items.length) {
      const patch: Partial<Run> = error
        ? { status: 'failed', error, ...closed('blocked', error) }
        : { status: 'skipped', ...closed('no-op', 'nothing to look at') };
      const run = yield* Effect.promise(() => p.store.update(first.id, patch));
      return { ...planned, run } satisfies JobResult;
    }
    let result: JobResult | undefined;
    const replies: Item[] = [];
    const noun = fanOut(job.over);
    for (const [index, item] of items.entries()) {
      const run =
        index === 0
          ? first
          : yield* Effect.promise(() =>
              p.store.create({
                workflow: planned.workflow,
                job: planned.job,
                bot: job.bot,
                ...(first.harness && { harness: first.harness }),
                event: p.event,
                parent: first.id,
                ...(job.until && { attempt: 1 }),
              })
            );
      const section = itemSection(job.over, item);
      const fold = noun && { label: item.label, replies };
      result = yield* attempts(planned, workflow, run, worktree, handoff, p, { index, section, ...(fold && { fold }) });
      if (!proceeds(result.run.closure)) break;
    }
    const failed = noun ? yield* Effect.promise(() => postSummary(first, noun, replies, p)) : undefined;
    if (failed && result) {
      const run = yield* Effect.promise(() => p.store.update(result.run.id, closed('blocked', failed)));
      return { ...result, run };
    }
    return result as JobResult;
  });

/**
 * The steps whose work lands on `into`: every sub-issue of the plans behind the requests into it, each with its plan,
 * whether a request it opened was merged there and whether a job on it is queued or running.
 */
export const stepsInto = async (into: string, pulls: Pulls, p: Pipeline) => {
  const issues = issuesOf(p);
  if (!issues) return [];
  const requests = await pulls.list({ into, state: 'all' });
  const openers = await Promise.all(requests.map(async pull => ({ pull, run: await openerOf(pull, p.store) })));
  const plans = new Set(openers.flatMap(({ run }) => run?.event.parent ?? []));
  const merged = new Set(openers.flatMap(({ pull, run }) => (pull.state === 'merged' && run?.event.number) || []));
  const steps = (await Promise.all([...plans].map(parent => issues.list({ parent, state: 'all' })))).flat();
  return Promise.all(
    steps.map(async ({ number, title, state, parent }) => {
      const runs = await p.store.runs({ repo: p.event.repo, number, check: false });
      const running = runs.some(r => !onRequest(r.event) && (r.status === 'queued' || r.status === 'running'));
      return { number, title, state, parent, merged: merged.has(number), running };
    })
  );
};

/**
 * The open requests from `bothub/` branches into a merging job's `into`, and the steps that land there (see
 * `stepsInto`), as `BOTHUB_INTO`, `BOTHUB_REQUESTS`, `BOTHUB_STEPS` and `BOTHUB_DEFAULT_BRANCH`.
 */
export const requestsEnv = async (
  kinds: ProposalKind[],
  target: Target,
  p: Pipeline
): Promise<Record<string, string>> => {
  const pulls = pullsOf(p);
  if (!kinds.includes('merge') || !pulls) return {};
  const defaultBranch = await pulls.defaultBranch();
  const into = target.into ?? defaultBranch;
  const open = (await pulls.list({ into })).filter(pull => pull.branch.startsWith('bothub/'));
  const requests = open.map(({ number, branch, title, url }) => ({ number, branch, into, title, url }));
  return {
    BOTHUB_INTO: into,
    BOTHUB_REQUESTS: JSON.stringify(requests),
    BOTHUB_STEPS: JSON.stringify(await stepsInto(into, pulls, p)),
    BOTHUB_DEFAULT_BRANCH: defaultBranch,
  };
};
