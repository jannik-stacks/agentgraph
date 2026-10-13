import { Effect } from 'effect';
import { effectivePreload, effectiveTools, type Defined } from '../config.ts';
import type { PlannedJob } from '../dispatch.ts';
import { decideCheck } from '../decide.ts';
import { digest } from '../fingerprint.ts';
import { fanOut, hunkOptions, itemsOf, positionless, type Item } from '../over.ts';
import { extractProposals, matchGlob, type Rejection } from '../outputs.ts';
import { issueContext } from '../preload.ts';
import { providerLimit, resetOf, runScript, type ScriptResult } from '../runner.ts';
import type { Check, Job, Over } from '../schema.ts';
import type { Run, Verdict } from '../store.ts';
import { type Pipeline, agent, issuesOf, launcher } from './context.ts';
import { type Handoff, type Target, defaultMinutes, eventContext, fenced, handoffEnv, session } from './prompt.ts';

/** Whether a check run crashed: it failed without a reason outside its work. */
const crashed = (run: Run) => run.status === 'failed' && run.stopped === undefined;

/** The longest wait for a provider limit to reset, and the wait when the error names no reset. */
const resetCap = 5 * 60_000;
const providerBackoff = 30_000;

/** How long to wait before running a check again that the provider refused; undefined when not worth one retry. */
export const providerWait = (run: Pick<Run, 'stopped' | 'error'>, now = Date.now()) => {
  if (run.stopped !== 'provider') return;
  const reset = resetOf(run.error);
  const wait = reset ? reset.getTime() - now + 1000 : providerBackoff;
  return wait <= resetCap ? Math.max(wait, 0) : undefined;
};

/**
 * Reads a check bot's verdict: its reply's first line is `PASS` or `FAIL`, bold or not, the rest are findings. A final
 * message without any `bothub` block is read as the reply. A check that cannot decide (there is no reply, or the first
 * line is neither word) fails with the reason; a run that did not succeed is `blocked`, unless it was stopped in a loop.
 */
export const verdictOf = (run: Run, final: string): Pick<Verdict, 'pass' | 'findings' | 'blocked'> => {
  if (run.status !== 'succeeded') {
    const why = run.error ?? run.reason;
    const findings = `run ${run.id} ${run.status}${why ? `: ${why}` : ''}`;
    return { pass: false, findings, ...(run.stopped !== 'stuck' && { blocked: true }) };
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
  /** What the attempt replied and the bodies of its merge requests, for check scripts as `BOTHUB_REPLY`. */
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

type Judged = Pick<Verdict, 'pass' | 'findings' | 'blocked' | 'runs'>;

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

/**
 * How a check judges one item. A bot check passes an item without a run when an earlier check run of the same job on
 * the same issue passed it for the same check, bot and skill, with the item unchanged but for where it sits (see
 * `positionless`): a later attempt or a conflict resolution judges only the items that changed.
 */
const judgeWith = (check: Defined<Check>, a: Attempt, scope: Scope, p: Pipeline) => {
  if (check.type === 'script')
    return (item: Item) =>
      Effect.promise(async (): Promise<Judged> => scriptVerdict(await runOnItem(check.run, item, scope, p, true)));
  if (check.type === 'decide')
    return (item: Item) =>
      Effect.promise(async (): Promise<Judged> => {
        const recorded: Promise<void>[] = [];
        const verdict = await decideCheck(check.body.trim(), item.text, p.env, check.threshold, usage =>
          recorded.push(p.store.add(a.parent.id, { ...usage, source: 'decide-check' }))
        );
        await Promise.all(recorded).catch(() => {});
        return verdict;
      });
  const bot = p.config.bots[check.bot];
  const skill = check.skill ? p.config.skills[check.skill] : undefined;
  const preload = bot ? effectivePreload(bot, {}) : [];
  let preloaded: Promise<string | undefined> | undefined;
  let earlier: Promise<Run[]> | undefined;
  const { repo, number, id } = p.event;
  const judged = () =>
    (earlier ??= p.store.runs({
      repo,
      ...(number === undefined ? { event: id } : { number }),
      workflow: a.planned.workflow,
      job: a.planned.job,
      check: true,
    }));
  return (item: Item): Effect.Effect<Judged> =>
    Effect.gen(function* () {
      if (!bot) return { pass: false, findings: `unknown bot "${check.bot}"` };
      const key = digest(check.name, bot.name, check.body, skill?.body ?? '', positionless(item.text));
      const same = (yield* Effect.promise(judged)).find(run => run.passed === key);
      if (same) return { pass: true, findings: `unchanged since run ${same.id}, which passed it` };
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
      const create = () =>
        p.store.create({
          workflow: a.planned.workflow,
          job: a.planned.job,
          bot: bot.name,
          harness: bot.harness,
          event: p.event,
          parent: a.parent.id,
          check: check.name,
        });
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
      const judge = Effect.gen(function* () {
        const created = yield* Effect.promise(create);
        return yield* agent(bot, spec, bot.budget?.minutes ?? defaultMinutes, created, p, {}, true);
      });
      const first = yield* judge;
      const wait = providerWait(first.run);
      const again = crashed(first.run) || wait !== undefined;
      const { run, final } = again ? yield* Effect.andThen(Effect.sleep(wait ?? 0), judge) : first;
      const verdict = verdictOf(run, final);
      if (verdict.pass) yield* Effect.promise(() => p.store.update(run.id, { passed: key }));
      return { ...verdict, runs: [...new Set([first.run.id, run.id])] };
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
 * check judges the items `over` names, `concurrency` at a time, and passes only when every item passes, with the
 * failing items' findings first. A check with any `blocked` item is blocked.
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
    const runs = judged.flatMap(verdict => verdict.runs ?? []);
    const findings = judged
      .flatMap(({ findings, pass }, i) =>
        findings ? [{ pass, text: items.length > 1 ? `${items[i]?.label}:\n${findings}` : findings }] : []
      )
      .sort((x, y) => Number(x.pass) - Number(y.pass))
      .map(({ text }) => text);
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

const findingsCap = 1500;

/** The findings of failing verdicts for a human, each check's cut at `findingsCap` characters. */
export const findingsFor = (failing: Verdict[]) =>
  failing
    .map(({ check, findings = 'failed without output' }) => {
      const cut = findings.length > findingsCap ? `${findings.slice(0, findingsCap)}\n…` : findings;
      return `### ${check}\n\n${fenced(cut)}`;
    })
    .join('\n\n');

/** What a human reads when checks could not run: why, until when, and what to comment, without run ids or keys. */
export const couldNotRun = (blocked: Verdict[]) => {
  const why = ({ check, findings = '' }: Verdict) => {
    const line = findings.split('\n')[0]!;
    const count = /^(\d+ of \d+) items could not run, the first: /.exec(line);
    const what = count ? `${count[1]} ${check} items` : check;
    const reset = resetOf(line);
    if (providerLimit.test(line))
      return `${what} hit the model provider's rate limit${reset ? ` until ${reset.toISOString().slice(11, 16)} UTC` : ''}`;
    const cause = line
      .slice(count?.[0].length ?? 0)
      .replace(/^run \S+ \w+(: |$)/, '')
      .replace(/\b[0-9a-f]{24,}\b/gi, '…');
    return `${what} could not run${cause ? ` (${cause})` : ''}`;
  };
  const checks = blocked.map(why).join('; ');
  return `Checks could not run, so the change is held: ${checks}. Nothing went back to the bot. Comment \`/bothub\` to run them again.`;
};

/** Whether a failing verdict holds the change: every gating check does, except one in `warn` mode. */
export const holds = (verdict: Verdict, p: Pick<Pipeline, 'config'>) => p.config.checks[verdict.check]?.mode !== 'warn';

const gapLength = 200;

/** A merge request body with a "Known gaps" section: each failing `warn` or `log` check and its first finding. */
export const withGaps = (body: string, checks: Verdict[], p: Pick<Pipeline, 'config'>) => {
  const gaps = checks.filter(v => !v.pass && !v.skipped && !v.blocked && (!v.gating || !holds(v, p)));
  if (!gaps.length) return body;
  const line = ({ check, findings = '' }: Verdict) => {
    const [first = 'failed without output', next] = findings.split('\n').filter(l => l.trim());
    const finding = first.endsWith(':') && next ? `${first} ${next.replace(/^\s*[-*]\s*/, '')}` : first;
    return `- ${check}: ${finding.replace(/^\s*[-*]\s*/, '').slice(0, gapLength)}`;
  };
  return `${body.trimEnd()}\n\n## Known gaps\n\n${gaps.map(line).join('\n')}`;
};

/**
 * Runs the named checks in stages, each all at once: the gating script checks first, then, only when none that holds
 * the change failed, the gating bot and decide checks, so the cheap gates spare the costly ones. Checks in `log` mode
 * run last and only when nothing that holds the change failed, so they judge only an attempt that settles. A check
 * left out that way is skipped. Verdicts keep the order of `names`.
 */
export const runChecks = (names: string[], a: Attempt, p: Pipeline) =>
  Effect.gen(function* () {
    const verdicts: Verdict[] = [];
    const listed = names.map((name, i) => ({ name, i, check: p.config.checks[name] }));
    const scripts = listed.filter(({ check }) => !check || (check.mode !== 'log' && check.type === 'script'));
    const costly = listed.filter(({ check }) => check && check.mode !== 'log' && check.type !== 'script');
    const logged = listed.filter(({ check }) => check?.mode === 'log');
    const run = (stage: typeof listed) =>
      Effect.forEach(
        stage,
        ({ name, i, check }) =>
          Effect.map(
            check
              ? runCheck(check, a, p)
              : Effect.succeed<Verdict>({ check: name, gating: true, pass: false, findings: 'unknown check' }),
            verdict => (verdicts[i] = verdict)
          ),
        { concurrency: 'unbounded' }
      );
    const skip = (stage: typeof listed, findings: string) =>
      stage.forEach(({ name, i, check }) => {
        verdicts[i] = { check: name, gating: check?.mode !== 'log', pass: false, skipped: true, findings };
      });
    const held = (ran: Verdict[]) => ran.some(v => v.gating && !v.skipped && !v.pass && holds(v, p));
    if (held(yield* run(scripts))) {
      skip(costly, 'not run: a script check failed');
      skip(logged, 'not run: a check that holds the change failed');
    } else if (held(yield* run(costly))) skip(logged, 'not run: a check that holds the change failed');
    else yield* run(logged);
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
