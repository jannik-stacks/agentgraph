import { Effect } from 'effect';
import { effectivePreload, effectiveTools, type Defined } from '../config.ts';
import type { PlannedJob } from '../dispatch.ts';
import { decideCheck } from '../decide.ts';
import { fanOut, hunkOptions, itemsOf, type Item } from '../over.ts';
import { extractProposals, matchGlob, type Rejection } from '../outputs.ts';
import { issueContext } from '../preload.ts';
import { runScript, type ScriptResult } from '../runner.ts';
import type { Check, Job, Over } from '../schema.ts';
import type { Run, Verdict } from '../store.ts';
import { type Pipeline, agent, issuesOf, launcher } from './context.ts';
import { type Handoff, type Target, defaultMinutes, eventContext, fenced, handoffEnv, session } from './prompt.ts';

/** Whether a run ended for a reason outside the bot's work: skipped, or stopped for anything but a loop. */
const outsideWork = (run: Run) => run.status === 'skipped' || (run.stopped !== undefined && run.stopped !== 'stuck');

/**
 * Reads a check bot's verdict: its reply's first line is `PASS` or `FAIL`, bold or not, the rest are findings. A final
 * message without any `bothub` block is read as the reply. A check that cannot decide (the run failed, there is no
 * reply, or the first line is neither word) fails with the reason; a run that ended for a reason outside its work (see
 * `outsideWork`) is `blocked` as well.
 */
export const verdictOf = (run: Run, final: string): Pick<Verdict, 'pass' | 'findings' | 'blocked'> => {
  if (run.status !== 'succeeded') {
    const why = run.error ?? run.reason;
    const findings = `run ${run.id} ${run.status}${why ? `: ${why}` : ''}`;
    return { pass: false, findings, ...(outsideWork(run) && { blocked: true }) };
  }
  const { proposals } = extractProposals(final);
  const reply = proposals.find(proposal => proposal.kind === 'reply');
  const [first = '', ...rest] = (reply?.body ?? (proposals.length ? '' : final)).trim().split('\n');
  const verdict = /^[\s*_]*(pass|fail)\b[\s*_]*[:.\-–—]?\s*(.*)$/i.exec(first);
  if (!verdict)
    return {
      pass: false,
      findings: `run ${run.id} gave no verdict${reply ? ': its first line does not start with PASS or FAIL' : ''}`,
    };
  const findings = [verdict[2], ...rest].join('\n').trim();
  return { pass: verdict[1]!.toUpperCase() === 'PASS', ...(findings && { findings }) };
};

const verdictContract = [
  '## Verdict',
  'End with a `bothub` block holding one reply. Its first line is `PASS` or `FAIL`; the lines after it are your',
  'findings, most severe first, each naming the file and line.',
].join('\n');

/** One attempt of a job in its worktree. `merging` is set while it resolves a merge of `base` into its branch. */
export type Attempt = {
  planned: PlannedJob;
  job: Job;
  worktree: string;
  cwd: string;
  base: string;
  parent: Run;
  handoff: Handoff;
  target: Target;
  item?: number;
  /** The branch tip a push replaces, when the job started over. */
  replace?: string;
  /** What the attempt replied, for check scripts as `BOTHUB_REPLY`. */
  reply?: string;
  /** A fan-out item's replies are collected here under its label instead of posted one by one. */
  fold?: { label: string; replies: Item[] };
  merging?: boolean;
};

/** Where `over` reads from: the worktree, the commit the change starts at, the files in scope and the script env. */
export type Scope = {
  worktree: string;
  cwd: string;
  since: string;
  files: string[];
  timeout: number;
  env: Record<string, string>;
};

/**
 * The items `over` names. A script `over` runs in the read-only worktree with `BOTHUB_BASE` set to where the change
 * starts; a script that fails, or prints more items than `max`, gives an error instead, and so does a change with
 * more hunks than an `each-hunk` takes.
 */
export const gather = async (over: Over, scope: Scope, p: Pipeline): Promise<{ items: Item[]; error?: string }> => {
  const hunked = hunkOptions(over);
  if (typeof over === 'object' && !('each-hunk' in over)) {
    const script = 'each' in over ? over.each : over.run;
    const env = { ...scope.env, BOTHUB_BASE: scope.since };
    const access = { hub: p.hub, readonly: true };
    const { ok, output, stdout } = await runScript(script, scope.cwd, scope.timeout, env, launcher(p), access);
    if (!ok) return { items: [], error: `the "over" script failed: ${output || 'exited non-zero'}` };
    const items = itemsOf(over, { diff: '', output: stdout });
    if ('each' in over && items.length > over.max)
      return {
        items: [],
        error: `the "over" script printed ${items.length} items, more than "max" allows (${over.max})`,
      };
    return { items };
  }
  if (over === 'event') return { items: itemsOf(over, { diff: '', event: p.event.body }) };
  const { diff } = await p.workspaces.changes(scope.worktree, scope.since, scope.files, hunked?.context);
  const items = itemsOf(over, { diff });
  if (hunked && items.length > hunked.max)
    return {
      items: [],
      error: `the change has ${items.length} hunks, more than the ${hunked.max} "each-hunk" takes; make a smaller change or split it`,
    };
  return { items };
};

/** An item as a prompt section. The event is already in every prompt, so it gets none. */
export const itemSection = (over: Over, item: Item) => {
  if (over === 'event') return;
  const titles: Record<Exclude<Over, object>, string> = {
    diff: 'Changes',
    added: 'Added lines',
    event: 'Event',
    'each-file': `Changes to ${item.label}`,
    'each-hunk': `Hunk in ${item.label}`,
  };
  const title =
    typeof over === 'string'
      ? titles[over]
      : 'run' in over
        ? 'Command output'
        : 'each-hunk' in over
          ? titles['each-hunk']
          : `Item: ${item.label}`;
  return `## ${title}\n\n${fenced(item.text)}`;
};

/** The item as a script sees it: in `BOTHUB_ITEM` and on stdin, with the worktree read-only when `readonly`. */
export const runOnItem = (script: string, item: Item, scope: Scope, p: Pipeline, readonly = false) =>
  runScript(script, scope.cwd, scope.timeout, { ...scope.env, BOTHUB_ITEM: item.text }, launcher(p), {
    hub: p.hub,
    input: item.text,
    readonly,
  });

type Judged = Pick<Verdict, 'pass' | 'findings' | 'blocked'> & { run?: string };

const passTail = 10;

/**
 * A script check's verdict: its output on a failure, and the last lines of it on a pass, so warnings stay visible. A
 * script that never started or ran out of time is `blocked`.
 */
const scriptVerdict = ({ ok, output, stopped }: ScriptResult): Judged => {
  if (!ok) return { pass: false, findings: output || 'exited non-zero', ...(stopped && { blocked: true }) };
  const tail = output.trim().split('\n').slice(-passTail).join('\n');
  return { pass: true, ...(tail && { findings: tail }) };
};

const judgeWith = (check: Defined<Check>, a: Attempt, scope: Scope, p: Pipeline) => {
  if (check.type === 'script')
    return (item: Item) =>
      Effect.promise(async (): Promise<Judged> => scriptVerdict(await runOnItem(check.run, item, scope, p, true)));
  if (check.type === 'decide')
    return (item: Item) =>
      Effect.promise(() => decideCheck(check.body.trim(), item.text, p.env, check.threshold) as Promise<Judged>);
  const bot = p.config.bots[check.bot];
  const skill = check.skill ? p.config.skills[check.skill] : undefined;
  const preload = bot ? effectivePreload(bot, {}) : [];
  let preloaded: Promise<string | undefined> | undefined;
  return (item: Item): Effect.Effect<Judged> =>
    Effect.gen(function* () {
      if (!bot) return { pass: false, findings: `unknown bot "${check.bot}"` };
      const context = yield* Effect.promise(() => (preloaded ??= issueContext(issuesOf(p), p.event, preload)));
      const prompt = [
        skill?.body,
        check.body,
        context,
        eventContext(p.event, a.planned.args, undefined),
        verdictContract,
        itemSection(check.over, item),
      ]
        .filter(Boolean)
        .join('\n\n');
      const created = yield* Effect.promise(() =>
        p.store.create({
          workflow: a.planned.workflow,
          job: a.planned.job,
          bot: bot.name,
          harness: bot.harness,
          event: p.event,
          parent: a.parent.id,
          check: check.name,
        })
      );
      const spec = session({
        config: p.config,
        bot,
        returns: ['reply'],
        prompt,
        cwd: a.cwd,
        preload,
        tools: effectiveTools(bot, {}),
        access: p,
      });
      const { run, final } = yield* agent(bot, spec, bot.budget?.minutes ?? defaultMinutes, created, p, {}, true);
      return { ...verdictOf(run, final), run: run.id };
    });
};

/** The event's issue or pull request number as `BOTHUB_ISSUE`, for scripts. */
export const issueEnv = ({ event }: Pipeline) =>
  event.number === undefined ? {} : { BOTHUB_ISSUE: String(event.number) };

/** The longest attempt reply a check script sees in `BOTHUB_REPLY`. */
const replyLimit = 64_000;

/** How many items of one check are judged at once, unless the check sets its own `concurrency`. */
const itemConcurrency = 8;

/**
 * Runs one check over an attempt's changes, read-only. A check whose `paths` match no changed file, or that has
 * nothing to look at, is skipped. A script that does not fan out runs once and reads the worktree itself; every other
 * check judges the items `over` names, `concurrency` at a time, and passes only when every item passes. A check with
 * any `blocked` item is blocked.
 */
const judgeCheck = (check: Defined<Check>, a: Attempt, p: Pipeline) =>
  Effect.gen(function* () {
    const done = (result: Pick<Verdict, 'pass' | 'findings' | 'runs' | 'skipped' | 'blocked'>): Verdict => ({
      check: check.name,
      gating: check.mode !== 'log',
      ...result,
    });
    const skipped = (findings: string) => done({ pass: false, skipped: true, findings });
    const { paths, over } = check;
    const changed = paths ? (yield* Effect.promise(() => p.workspaces.changes(a.worktree, a.base))).files : [];
    const files = changed.filter(file => paths?.some(glob => matchGlob(glob, file)));
    if (paths && !files.length) return skipped('no changed file matches its paths');
    const scope: Scope = {
      worktree: a.worktree,
      cwd: a.cwd,
      since: a.base,
      files,
      timeout: a.job['timeout-minutes'] ?? defaultMinutes,
      env: {
        ...handoffEnv(a.handoff),
        ...issueEnv(p),
        ...(a.reply !== undefined && { BOTHUB_REPLY: a.reply.slice(0, replyLimit) }),
        BOTHUB_BASE: a.base,
      },
    };

    if (check.type === 'script' && !fanOut(over)) {
      const access = { hub: p.hub, readonly: true };
      const result = yield* Effect.promise(() =>
        runScript(check.run, a.cwd, scope.timeout, scope.env, launcher(p), access)
      );
      return done(scriptVerdict(result));
    }

    const { items, error } = yield* Effect.promise(() => gather(over, scope, p));
    if (error) return done({ pass: false, findings: error });
    if (!items.length) return skipped('nothing to look at');
    const judged = yield* Effect.forEach(items, judgeWith(check, a, scope, p), {
      concurrency: check.concurrency ?? itemConcurrency,
    });
    const runs = judged.flatMap(verdict => (verdict.run ? [verdict.run] : []));
    const findings = judged.flatMap(({ findings }, i) =>
      findings ? [items.length > 1 ? `${items[i]?.label}:\n${findings}` : findings] : []
    );
    const blocked = judged.filter(verdict => verdict.blocked);
    if (blocked.length && items.length > 1) {
      const why = blocked[0]?.findings?.split('\n')[0] ?? 'no output';
      findings.unshift(`${blocked.length} of ${items.length} items could not run, the first: ${why}`);
    }
    return done({
      pass: judged.every(verdict => verdict.pass),
      ...(blocked.length && { blocked: true }),
      ...(runs.length && { runs }),
      ...(findings.length && { findings: findings.join('\n\n') }),
    });
  });

/** Runs one check (see `judgeCheck`), timed, telling `onCheck` when it starts and ends. */
const runCheck = (check: Defined<Check>, a: Attempt, p: Pipeline) =>
  Effect.gen(function* () {
    const start = Date.now();
    p.onCheck?.(a.parent, check.name);
    const verdict = yield* judgeCheck(check, a, p);
    const end = Date.now();
    const timed: Verdict = {
      ...verdict,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      durationMs: end - start,
    };
    p.onCheck?.(a.parent, check.name, timed);
    return timed;
  });

/** Whether a failing verdict holds the change: every gating check does, except one in `warn` mode. */
export const holds = (verdict: Verdict, p: Pipeline) => p.config.checks[verdict.check]?.mode !== 'warn';

/**
 * Runs the named checks in two stages, each all at once: every script check first, then, only when no script that
 * holds the change failed, the bot and decide checks, so the cheap gates spare the costly ones. A check left out that
 * way is skipped. Verdicts keep the order of `names`.
 */
export const runChecks = (names: string[], a: Attempt, p: Pipeline) =>
  Effect.gen(function* () {
    const verdicts: Verdict[] = [];
    const stage = (cheap: boolean) =>
      Effect.forEach(
        names.flatMap((name, i) => {
          const check = p.config.checks[name];
          return (!check || check.type === 'script') === cheap ? [{ name, i, check }] : [];
        }),
        ({ name, i, check }) =>
          Effect.map(
            check
              ? runCheck(check, a, p)
              : Effect.succeed<Verdict>({ check: name, gating: true, pass: false, findings: 'unknown check' }),
            verdict => {
              verdicts[i] = verdict;
              return verdict;
            }
          ),
        { concurrency: 'unbounded' }
      );
    const scripts = yield* stage(true);
    if (scripts.some(v => v.gating && !v.skipped && !v.pass && holds(v, p)))
      names.forEach((name, i) => {
        const check = p.config.checks[name];
        if (check && check.type !== 'script')
          verdicts[i] = {
            check: name,
            gating: check.mode !== 'log',
            pass: false,
            skipped: true,
            findings: 'not run: a script check failed',
          };
      });
    else yield* stage(false);
    return verdicts;
  });

/**
 * The gating checks that fail an attempt. A check skipped because the change touches nothing it covers does not gate,
 * unless no gating check ran at all: then every skipped one fails, so a change is never passed unchecked.
 */
export const failingChecks = (verdicts: Verdict[]) => {
  const gating = verdicts.filter(v => v.gating);
  const ran = gating.filter(v => !v.skipped);
  return ran.length ? ran.filter(v => !v.pass) : gating.filter(v => v.skipped);
};

/** The files a merge left conflicting, as a prompt section; `attempt` marks a follow-up. */
export const conflictSection = (files: string[], attempt?: string) =>
  [
    '## Merge conflicts',
    `${attempt ? `${attempt} These files still hold conflict markers.` : 'The branch your work goes into was merged into this worktree and conflicts with your change.'} Resolve each conflict keeping what both sides meant, remove every marker, then push your branch again; the merge is committed for you.`,
    files.map(file => `- ${file}`).join('\n'),
  ].join('\n\n');

export const followUp = (
  prompt: string,
  failing: Verdict[],
  rejected: Rejection[],
  attempt: number,
  total: number,
  problems: string[] = [],
  earlier?: string,
  conflicts: string[] = []
) =>
  [
    prompt,
    ...(earlier ? ['## Your earlier attempt', earlier] : []),
    ...(conflicts.length ? [conflictSection(conflicts, `Attempt ${attempt} of ${total}.`)] : []),
    ...(problems.length
      ? [
          '## Proposal errors',
          `Attempt ${attempt} of ${total}. Your earlier changes are still in this worktree, but your last reply ended without usable proposals. Fix these, then end with your proposals again.`,
          problems.map(problem => `- ${problem}`).join('\n'),
        ]
      : []),
    ...(failing.length
      ? [
          '## Check findings',
          `Attempt ${attempt} of ${total}. Your earlier changes are still in this worktree, but these checks failed. Fix what they found, then end with your proposals again.`,
        ]
      : []),
    ...failing.map(v => `### ${v.check}\n\n${fenced(v.findings ?? 'failed without output')}`),
    ...(rejected.length
      ? [
          '## Rejected proposals',
          rejected.map(({ proposal, reason }) => `- \`${proposal.kind}\`: ${reason}`).join('\n'),
        ]
      : []),
  ].join('\n\n');
