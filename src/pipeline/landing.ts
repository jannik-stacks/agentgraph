import { Effect } from 'effect';
import { apply, type ApplyResult } from '../apply.ts';
import type { PlannedJob } from '../dispatch.ts';
import type { Item } from '../over.ts';
import { hubProposal } from '../hub-write.ts';
import { extractProposals, Proposal, type Validated } from '../outputs.ts';
import type { Pull, Pulls } from '../pulls.ts';
import type { Closure, ProposalKind } from '../schema.ts';
import type { Outcome, Run, Verdict } from '../store.ts';
import { summarizeOutcome } from '../summaries.ts';
import { type JobResult, type Pipeline, issuesOf, pullsOf } from './context.ts';
import type { Handoff } from './prompt.ts';
import { stepsInto } from './attempt.ts';
import { type Attempt, failingChecks, runChecks, withGaps } from './checks.ts';
import { openerOf } from './continue.ts';
import { runPlanned } from './jobs.ts';

const kindsOf = (outcome: Outcome) =>
  outcome.applied
    ? outcome.results.filter(result => result.status === 'applied').map(result => result.kind)
    : outcome.accepted.map(proposal => proposal.kind);

export const closed = (closure: Closure, reason?: string): Pick<Run, 'closure' | 'reason'> => ({
  closure,
  ...(reason && { reason }),
});

/**
 * What happened to a job's work, from its run and outcome. A closure the bot stated wins once the run succeeded. A
 * question is `blocked`, a merge request `handed-off`, any other write (a merge too) `done`. A push without a merge
 * request is `handed-off` when a later job needs this one, it resolves a merge or its branch already has an open
 * request, otherwise `blocked`. A job that may push but
 * changed nothing, or one that wrote nothing at all, is `no-op`. A skipped run, a provider limit, a sandbox that
 * never started or a run that died before its bot did anything is `deferred`;
 * any other failure, or an effect that failed to apply, is `blocked`.
 */
export const closureOf = (run: Run, outcome: Outcome | undefined, returns: ProposalKind[], taken = false) => {
  if (run.status === 'skipped') return closed('deferred', run.reason);
  const asked = outcome && kindsOf(outcome).includes('ask');
  if (run.status !== 'succeeded') {
    if (run.stopped === 'provider') return closed('deferred', `the provider refused the run: ${run.error}`);
    if (run.stopped === 'sandbox' || run.stopped === 'infra') return closed('deferred', run.error);
    if (run.stopped === 'withdrawn') return closed('no-op', run.error);
    return closed('blocked', asked ? 'asked a human' : (run.error ?? `the run ${run.status}`));
  }
  const stated = outcome?.accepted.find(proposal => proposal.kind === 'close');
  if (stated) return closed(stated.as, stated.reason);
  if (!outcome) return closed('no-op', 'proposed nothing');
  const failed = outcome.results.find(result => result.status === 'failed');
  if (failed) return closed('blocked', `${failed.kind} failed: ${failed.reason ?? 'unknown error'}`);
  const kinds = kindsOf(outcome).filter(kind => kind !== 'close');
  if (asked) return closed('blocked', 'asked a human');
  if (kinds.includes('merge-request')) return closed('handed-off');
  if (kinds.includes('push'))
    return taken || outcome.pr !== undefined
      ? closed('handed-off')
      : closed('blocked', 'pushed a branch without opening a merge request');
  if (returns.includes('push')) return closed('no-op', 'proposed no change');
  return kinds.length ? closed('done') : closed('no-op', 'proposed nothing');
};

const pullNumber = (url: string | undefined) => Number(url?.match(/\/(\d+)$/)?.[1]) || undefined;

/** The branch that landed and the merge request that is open after applying. */
const handoffOf = (applied: Proposal[], results: ApplyResult[]): Handoff => {
  const landed = (kind: Proposal['kind']) => results.find(r => r.kind === kind && r.status === 'applied');
  const push = applied.find((proposal): proposal is Extract<Proposal, { kind: 'push' }> => proposal.kind === 'push');
  const request = applied.find(
    (proposal): proposal is Extract<Proposal, { kind: 'merge-request' }> => proposal.kind === 'merge-request'
  );
  const opened = landed('merge-request');
  const branch = push && landed('push') ? push.branch : request && opened ? request.branch : undefined;
  const number = pullNumber(opened?.url);
  return { ...(branch && { branch }), ...(number && { pr: number }) };
};

/** Effects recorded by earlier runs of the same event and job, applied ones first. */
const priorEffects = async (run: Run, p: Pipeline) => {
  const same = { event: p.event.id, workflow: run.workflow, job: run.job, check: false };
  const earlier = (await p.store.runs(same)).filter(r => r.id !== run.id);
  const results = (await Promise.all(earlier.map(r => p.store.outcome(r.id)))).flatMap(o => o?.results ?? []);
  return results.sort((x, y) => Number(y.status === 'applied') - Number(x.status === 'applied'));
};

/**
 * Stores and returns an attempt's outcome, applying `toApply` when the mode and a GitHub client allow it. The planned
 * effects are journalled in the outcome before the first one is applied. A run that lands a merge reads `running`
 * until the merge has landed; `finish` stores its status and end then.
 */
export const settle = async (
  run: Run,
  { proposals, errors }: ReturnType<typeof extractProposals>,
  { accepted, rejected, apply: allowed }: Validated,
  toApply: Proposal[] | undefined,
  a: Attempt,
  p: Pipeline,
  checks?: Verdict[]
): Promise<Outcome> => {
  const { gh, issues, event, workspaces, hubPr } = p;
  const pulls = pullsOf(p);
  const applied = toApply !== undefined && allowed && (gh !== undefined || issues !== undefined || pulls !== undefined);
  const { paths } = a.job;
  const base: Outcome = { proposals, errors, accepted, rejected, results: [], applied, ...(checks && { checks }) };
  if (!applied) return p.store.saveOutcome(run.id, base);
  const folds = (proposal: Proposal) => a.fold !== undefined && proposal.kind === 'reply';
  const writes = toApply
    .filter(proposal => proposal.kind !== 'close' && !folds(proposal))
    .map(proposal =>
      proposal.kind === 'merge-request' && checks ? { ...proposal, body: withGaps(proposal.body, checks, p) } : proposal
    );
  if (run.status === 'succeeded' && writes.some(proposal => proposal.kind === 'merge'))
    await p.store.update(run.id, { status: 'running' });
  const push: Parameters<typeof apply>[1]['push'] = ({ kind: _, ...proposal }, journal) =>
    workspaces.publish(event.repo, a.worktree, {
      ...proposal,
      ...(paths && { paths }),
      message: `bothub: ${run.job}`,
      base: a.base,
      ...(a.replace && { replace: a.replace }),
      ...journal,
    });
  const results = await apply(writes, {
    event,
    push,
    prefix: `${event.id}/${run.workflow}/${run.job}${a.item ? `/item-${a.item + 1}` : ''}${a.merging ? `/merge-${a.base.slice(0, 12)}` : ''}`,
    prior: await priorEffects(run, p),
    record: results => p.store.saveOutcome(run.id, { ...base, results }),
    ...(gh && { gh }),
    ...(issues && { issues }),
    ...(pulls && { pulls }),
    origin: { job: `${run.workflow}/${run.job}`, event: event.id },
    ...(a.target.into && { into: a.target.into }),
    merge: request => landMerge(request, a, p),
    ...((hubPr ?? p.hub) && { hubPr: hubPr ?? hubProposal(p.hub!) }),
  });
  const folded = toApply.flatMap(proposal => {
    if (proposal.kind !== 'reply' || !a.fold) return [];
    a.fold.replies.push({ label: a.fold.label, text: proposal.body });
    return [{ kind: 'reply', status: 'applied', reason: 'folded into the summary reply' } satisfies ApplyResult];
  });
  const handoff = handoffOf(writes, results);
  const open =
    handoff.branch && handoff.pr === undefined
      ? (await pulls?.list({ branch: handoff.branch }).catch(() => []))?.[0]
      : undefined;
  return p.store.saveOutcome(run.id, {
    ...base,
    results: [...results, ...folded],
    ...handoff,
    ...(open && { pr: open.number }),
  });
};

/**
 * Posts a fan-out's collected replies as one reply: the items with findings first, each under its label, then how many
 * passed. A reply whose first word is `pass`, bold or not, counts as a pass. Recorded on the fan-out's first run;
 * resolves to why it failed, if it did.
 */
export const postSummary = async (first: Run, noun: string, replies: Item[], p: Pipeline) => {
  if (!replies.length) return;
  const passed = replies.filter(reply => /^[*_]*pass\b/i.test(reply.text.trim()));
  const found = replies.filter(reply => !passed.includes(reply));
  const total = `${replies.length} ${noun}${replies.length === 1 ? '' : 's'}`;
  const head = found.length
    ? `${total}: ${found.length} with findings, ${passed.length} passed.`
    : `${total}, all passed.`;
  const body = [head, ...found.map(reply => `### ${reply.label}\n\n${reply.text.trim()}`)].join('\n\n');
  const outcome = await p.store.outcome(first.id);
  if (!outcome) return;
  const issues = issuesOf(p);
  const results = await apply([{ kind: 'reply', body }], {
    event: p.event,
    prefix: `${p.event.id}/${first.workflow}/${first.job}/summary`,
    record: results => p.store.saveOutcome(first.id, { ...outcome, results: [...outcome.results, ...results] }),
    ...(issues && { issues }),
    ...(p.gh && { gh: p.gh }),
  });
  const failed = results.find(result => result.status === 'failed');
  return failed && `the summary reply failed: ${failed.reason ?? 'unknown error'}`;
};

type Landed = { conflicts: string[] } | { sha: string };

/**
 * Merges `pull` into a fresh worktree of its branch. When it merges cleanly, runs the job's `requires` checks on the
 * merged tree and lands the merge while both branches are still where the checks saw them.
 */
const tryMerge = async (pull: Pull, round: number, a: Attempt, pulls: Pulls, p: Pipeline): Promise<Landed> => {
  const id = `${a.parent.id}-merge-${pull.number}-${round}`;
  const tree = await p.workspaces.create({ repo: p.event.repo, ref: pull.branch, merge: pull.into }, id);
  try {
    if (tree.conflicts.length) return { conflicts: tree.conflicts };
    const at: Attempt = { ...a, worktree: id, cwd: tree.path, base: tree.base };
    const verdicts = await Effect.runPromise(runChecks(a.job.requires ?? [], at, p));
    const failing = failingChecks(verdicts);
    if (failing.length)
      throw new Error(
        `required checks failed on the merged tree: ${failing.map(v => `${v.check}${v.findings ? ` (${v.findings.split('\n')[0]})` : ''}`).join(', ')}`
      );
    return await pulls.merge(pull.number, { head: tree.head, into: tree.base });
  } finally {
    await p.workspaces.remove(p.event.repo, id);
  }
};

/** Runs the job that opened `pull` again, on its branch with `into` merged in, so its bot resolves the conflicts. */
const resolveConflicts = async (pull: Pull, p: Pipeline) => {
  const [workflow = '', job = ''] = pull.origin?.job.split('/') ?? [];
  const definition = p.config.workflows[workflow]?.jobs[job];
  const event = (await openerOf(pull, p.store))?.event;
  if (!definition || !event) return;
  const planned: PlannedJob = { workflow, job, ...(definition.type === 'bot' && { bot: definition.bot }) };
  await Effect.runPromise(runPlanned(planned, { ...p, event }, {}, pull.into));
};

/**
 * Merges `into` forward into the other open requests from `bothub/` branches into it that merge cleanly, so their
 * checks and merges see what landed. A branch a live run holds is left alone, and so is one that conflicts.
 */
const refreshSiblings = async (landed: Pull, pulls: Pulls, p: Pipeline) => {
  const open = await pulls.list({ into: landed.into });
  const siblings = open.filter(pull => pull.number !== landed.number && pull.branch.startsWith('bothub/'));
  for (const pull of siblings) {
    const held = await p.store.lock(`${p.event.repo}:${pull.branch}`, `refresh-${landed.number}`);
    if (!('release' in held)) continue;
    try {
      await pulls.refresh(pull.number).catch(() => false);
    } finally {
      await held.release();
    }
  }
};

/**
 * Lands merge request `number` for an attempt's job: only an open request from a `bothub/` branch into the job's
 * `into`, and into the default branch only when `hub.yaml` lets bots merge there. A conflicting request goes back to
 * the job that opened it once; the job's `requires` checks then run on the merged tree before the merge lands. Once
 * it lands, the other open requests into `into` are brought up to date (see `refreshSiblings`).
 */
const landMerge = async (number: number, a: Attempt, p: Pipeline): Promise<Omit<ApplyResult, 'kind' | 'key'>> => {
  const pulls = pullsOf(p);
  if (!pulls) return { status: 'skipped', reason: 'no merge requests to merge' };
  const pull = await pulls.get(number);
  if (pull?.state !== 'open') throw new Error(`merge request #${number} is not open`);
  if (!pull.branch.startsWith('bothub/')) throw new Error(`merge request #${number} is not from a bothub/ branch`);
  const main = await pulls.defaultBranch();
  const into = a.target.into ?? main;
  if (pull.into !== into) throw new Error(`merge request #${number} goes into "${pull.into}", not "${into}"`);
  if (into === main && p.config.hub.merge['default-branch'] === 'human')
    throw new Error(`only a human merges into the default branch "${main}"`);
  let landed = await tryMerge(pull, 1, a, pulls, p);
  if ('conflicts' in landed) {
    await resolveConflicts(pull, p);
    landed = await tryMerge(pull, 2, a, pulls, p);
  }
  if ('conflicts' in landed) throw new Error(`merge request #${number} conflicts in ${landed.conflicts.join(', ')}`);
  await refreshSiblings(pull, pulls, p);
  await stepLanded(pull, pulls, p).catch(() => undefined);
  return { status: 'applied', url: pull.url, sha: landed.sha };
};

/** Closes the step issue whose request landed and tells its plan how many of its steps have landed. */
const stepLanded = async (pull: Pull, pulls: Pulls, p: Pipeline) => {
  const issues = issuesOf(p);
  const number = (await openerOf(pull, p.store))?.event.number;
  if (!issues || number === undefined) return;
  const issue = await issues.get(number);
  if (issue?.state === 'open') await issues.close(number);
  if (issue?.parent === undefined) return;
  const steps = (await stepsInto(pull.into, pulls, p)).filter(step => step.parent === issue.parent);
  const landed = steps.filter(step => step.merged).length;
  await issues.comment(issue.parent, `#${number} landed on ${pull.into}, ${landed} of ${steps.length} steps.`);
};

/** Adds how a job's final run ended to its summaries; a summary that cannot be written never fails the job. */
export const remember = async (run: Run, outcome: Outcome | undefined, p: Pipeline) => {
  if (p.data) await summarizeOutcome(p.data, run, outcome).catch(() => {});
};

export const finish = (
  planned: PlannedJob,
  run: Run,
  outcome: Outcome | undefined,
  kinds: ProposalKind[],
  p: Pipeline,
  merging = false
) =>
  Effect.promise(async (): Promise<JobResult> => {
    const jobs = Object.values(p.config.workflows[planned.workflow]?.jobs ?? {});
    const taken = merging || jobs.some(job => job.needs.includes(planned.job));
    const landed = outcome?.results.some(result => result.kind === 'merge');
    const ended = landed && { status: run.status, endedAt: new Date().toISOString() };
    const final = await p.store.update(run.id, { ...ended, ...closureOf(run, outcome, kinds, taken) });
    await remember(final, outcome, p);
    return { ...planned, run: final, ...(outcome && { outcome }) };
  });
