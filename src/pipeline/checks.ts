import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Effect, Fiber } from 'effect';
import { effectivePreload, effectiveTools, type Defined } from '../config.ts';
import type { PlannedJob } from '../dispatch.ts';
import { decideCheck } from '../decide.ts';
import { digest } from '../fingerprint.ts';
import { fanOut, hunkOptions, itemsOf, positionless, type Item } from '../over.ts';
import { extractProposals, matchGlob, type Rejection } from '../outputs.ts';
import { answersAfterBrief, issueContext } from '../preload.ts';
import { repoFor } from '../repo-guidance.ts';
import { providerLimit, resetOf, runScript, type ScriptAccess, type ScriptResult } from '../runner.ts';
import type { Check, Job, MergeSection, Over } from '../schema.ts';
import type { Run, Verdict } from '../store.ts';
import { type Pipeline, agent, issuesOf, launcher } from './context.ts';
import { type Handoff, type Target, defaultMinutes, eventContext, fenced, handoffEnv, session } from './prompt.ts';

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
  if (/maximum steps reached/i.test(final)) return { pass: false, findings: `run ${run.id} ended on its step cap before it judged` };
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

const verdictContract = (check: Check) =>
  [
    '## Verdict',
    'End with a `bothub` block holding one reply. Its first line is `PASS` or `FAIL`; the lines after it are your',
    'findings, most severe first, each naming the file and line.',
    ...(check.mode === 'block' ? [] : ['This check does not hold the change, so call no finding blocking.']),
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

/** `runScript` for a check: stalls stop it, and one that timed out or stalled runs once more. */
const checkScript = async (
  script: string,
  cwd: string,
  timeout: number,
  env: Record<string, string>,
  p: Pipeline,
  access: ScriptAccess & { input?: string }
) => {
  const once = () => runScript(script, cwd, timeout, env, launcher(p), { ...access, stallMinutes: p.stallMinutes ?? 10 });
  const result = await once();
  return result.stopped === 'timeout' || result.stopped === 'stalled' ? once() : result;
};

/** The item as a script sees it: in `BOTHUB_ITEM` and on stdin, with the worktree read-only when `readonly`. */
export const runOnItem = (script: string, item: Item, scope: Scope, p: Pipeline, readonly = false) =>
  checkScript(script, scope.cwd, scope.timeout, { ...scope.env, BOTHUB_ITEM: item.text }, p, {
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

/** What humans answered after the brief the attempt's job started from, which overrides the brief where they differ. */
const answerSection = async (a: Attempt, p: Pipeline) => {
  const said = await answersAfterBrief(issuesOf(p), p.event, a.planned.workflow, a.job.needs);
  if (!said.length) return;
  return ['## Answers after the brief', 'Where these differ from the brief, they win.', ...said.map(fenced)].join(
    '\n\n'
  );
};

/**
 * How a check judges one item. A bot check passes an item without a run when an earlier check run of the same job on
 * the same issue passed it for the same check, bot and skill, with the item unchanged but for where it sits (see
 * `positionless`): a later attempt or a conflict resolution judges only the items that changed. From the second
 * attempt on, a bot check sees what it failed earlier attempts of the job with, so an unfixed finding stays a finding.
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
  let loaded: ReturnType<typeof repoFor> | undefined;
  let answered: Promise<string | undefined> | undefined;
  let earlier: Promise<Run[]> | undefined;
  let raised: Promise<string> | undefined;
  const { repo, number, id } = p.event;
  const ofJob = (check: boolean) =>
    p.store.runs({
      repo,
      ...(number === undefined ? { event: id } : { number }),
      workflow: a.planned.workflow,
      job: a.planned.job,
      check,
    });
  const judged = () => (earlier ??= ofJob(true));
  const attempt = a.parent.attempt ?? 1;
  const raisedBefore = async () => {
    const outcomes = await Promise.all((await ofJob(false)).map(run => p.store.outcome(run.id)));
    const failed = outcomes.flatMap(o => o?.checks?.filter(v => v.check === check.name && !v.pass && !v.skipped) ?? []);
    return failed.length ? `\n\nEarlier attempts failed this check with:\n\n${findingsFor(failed.slice(0, 3))}` : '';
  };
  return (item: Item): Effect.Effect<Judged> =>
    Effect.gen(function* () {
      if (!bot) return { pass: false, findings: `unknown bot "${check.bot}"` };
      const answers = yield* Effect.promise(() => (answered ??= answerSection(a, p)));
      const key = digest(
        check.name,
        bot.name,
        check.body,
        skill?.body ?? '',
        positionless(item.text),
        ...(answers ? [answers] : [])
      );
      const same = (yield* Effect.promise(judged)).find(run => run.passed === key);
      if (same) return { pass: true, findings: `unchanged since run ${same.id}, which passed it` };
      const context = yield* Effect.promise(() => (preloaded ??= issueContext(issuesOf(p), p.event, preload)));
      const files = yield* Effect.promise(() => (loaded ??= repoFor(p.config, bot, a.cwd)));
      const before = attempt > 1 ? yield* Effect.promise(() => (raised ??= raisedBefore())) : '';
      const prompt = [
        skill?.body,
        check.body,
        context,
        answers,
        eventContext(p.event, a.planned.args, undefined),
        attempt > 1 ? `## Attempt\n\nThis is attempt ${attempt}.${before}` : undefined,
        verdictContract(check),
        itemSection(check.over, item),
      ]
        .filter(Boolean)
        .join('\n\n');
      const spec = session({
        config: p.config,
        bot: check['max-turns'] ? { ...bot, 'max-turns': check['max-turns'] } : bot,
        returns: ['reply'],
        prompt,
        cwd: a.cwd,
        preload,
        tools: effectiveTools(bot, {}),
        access: p,
        ...(files && { repo: files }),
      });
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
      const { run, final } = yield* agent(bot, spec, bot.budget?.minutes ?? defaultMinutes, created, p, {}, true);
      const verdict = verdictOf(run, final);
      if (verdict.pass) yield* Effect.promise(() => p.store.update(run.id, { passed: key }));
      return { ...verdict, runs: [run.id] };
    });
};

/** The event's issue or pull request number as `BOTHUB_ISSUE`, for scripts. */
export const issueEnv = ({ event }: Pipeline) =>
  event.number === undefined ? {} : { BOTHUB_ISSUE: String(event.number) };

/** The longest attempt reply a check script sees in `BOTHUB_REPLY`. */
const replyLimit = 64_000;

/** How many items of one check are judged at once, unless the check sets its own `concurrency`. */
const itemConcurrency = 8;

/** What a check script finds in its env: the handoff, the issue, the attempt's reply and where the change starts. */
const scriptEnv = (a: Attempt, p: Pipeline) => ({
  ...handoffEnv(a.handoff),
  ...issueEnv(p),
  ...(a.reply !== undefined && { BOTHUB_REPLY: a.reply.slice(0, replyLimit) }),
  BOTHUB_BASE: a.base,
});

/** Where a check reads from, or `undefined` when its `paths` match no changed file. */
const scopeOf = async (check: Defined<Check>, a: Attempt, p: Pipeline): Promise<Scope | undefined> => {
  const { paths } = check;
  const changed = paths ? (await p.workspaces.changes(a.worktree, a.base)).files : [];
  const files = changed.filter(file => paths?.some(glob => matchGlob(glob, file)));
  if (paths && !files.length) return;
  return {
    worktree: a.worktree,
    cwd: a.cwd,
    since: a.base,
    files,
    timeout: a.job['timeout-minutes'] ?? defaultMinutes,
    env: scriptEnv(a, p),
  };
};

type Prepared = { scope: Scope; items: Item[]; error?: string } | undefined;

/** A check's scope and the items it judges, none for a script that does not fan out. */
const prepare = async (check: Defined<Check>, a: Attempt, p: Pipeline): Promise<Prepared> => {
  const scope = await scopeOf(check, a, p);
  if (!scope) return;
  if (check.type === 'script' && !fanOut(check.over)) return { scope, items: [] };
  return { scope, ...(await gather(check.over, scope, p)) };
};

/**
 * Runs one check over an attempt's changes, read-only, from what `prepare` found. A check whose `paths` match no
 * changed file, or that has nothing to look at, is skipped. A script that does not fan out runs once and reads the
 * worktree itself; every other check judges the items `over` names, `concurrency` at a time, and passes only when
 * every item passes, with the failing items' findings first. A check with any `blocked` item is blocked.
 */
const judgeCheck = (check: Defined<Check>, a: Attempt, p: Pipeline, prepared?: Promise<Prepared>) =>
  Effect.gen(function* () {
    const done = (result: Pick<Verdict, 'pass' | 'findings' | 'failed' | 'runs' | 'skipped' | 'blocked'>): Verdict => ({
      check: check.name,
      gating: check.mode !== 'log',
      ...result,
    });
    const skipped = (findings: string) => done({ pass: false, skipped: true, findings });
    const ready = yield* Effect.promise(() => prepared ?? prepare(check, a, p));
    if (!ready) return skipped('no changed file matches its paths');
    const { scope, items, error } = ready;

    if (check.type === 'script' && !fanOut(check.over)) {
      const access = { hub: p.hub, readonly: true };
      const result = yield* Effect.promise(() =>
        checkScript(check.run, a.cwd, scope.timeout, scope.env, p, access)
      );
      return done(scriptVerdict(result));
    }

    if (error) return done({ pass: false, findings: error });
    if (!items.length) return skipped('nothing to look at');
    const judged = yield* Effect.forEach(items, judgeWith(check, a, scope, p), {
      concurrency: check.concurrency ?? itemConcurrency,
    });
    const runs = judged.flatMap(verdict => verdict.runs ?? []);
    const labeled = judged.flatMap(({ findings, pass }, i) =>
      findings ? [{ pass, text: items.length > 1 ? `${items[i]?.label}:\n${findings}` : findings }] : []
    );
    const failed = labeled.filter(({ pass }) => !pass).map(({ text }) => text);
    const passed = labeled.filter(({ pass }) => pass).map(({ text }) => text);
    const findings = [...failed, ...passed];
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
      ...(failed.length && passed.length && { failed: failed.join('\n\n') }),
    });
  });

/** Runs one check (see `judgeCheck`), timed, telling `onCheck` when it starts and ends, or is stopped. */
const runCheck = (check: Defined<Check>, a: Attempt, p: Pipeline, prepared?: Promise<Prepared>) =>
  Effect.gen(function* () {
    const start = Date.now();
    p.onCheck?.(a.parent, check.name);
    const stopped: Verdict = {
      check: check.name,
      gating: check.mode !== 'log',
      pass: false,
      skipped: true,
      findings: 'stopped',
    };
    const verdict = yield* Effect.onInterrupt(judgeCheck(check, a, p, prepared), () =>
      Effect.sync(() => p.onCheck?.(a.parent, check.name, stopped))
    );
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

/** Text within `cap` characters that keeps its first and last lines, with a marker for the lines between. */
const squeeze = (text: string, cap: number) => {
  if (text.length <= cap) return text;
  const lines = text.split('\n');
  const take = (from: string[], max: number, budget: number) => {
    const kept: string[] = [];
    let size = 0;
    for (const line of from) {
      size += line.length + 1;
      if (kept.length >= max || size > budget) break;
      kept.push(line);
    }
    return kept;
  };
  const head = take(lines, 20, cap / 3);
  const tail = take(lines.slice(head.length).reverse(), 40, (cap * 2) / 3).reverse();
  if (!head.length && !tail.length) return `${text.slice(0, cap)}\n…`;
  return [...head, `… ${lines.length - head.length - tail.length} lines …`, ...tail].join('\n');
};

/** The failing items' findings of failing verdicts for a human, each check's squeezed to `cap` characters. */
export const findingsFor = (failing: Verdict[], cap = findingsCap) =>
  failing
    .map(
      ({ check, failed, findings = 'failed without output' }) =>
        `### ${check}\n\n${fenced(squeeze(failed ?? findings, cap))}`
    )
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

/** A `blocking` label on a finding, which a check that does not hold the change never earns. */
const blockingLabel =
  /(?<![\w-])(?:\*\*|\[|\()?blocking(?:\*\*|\]|\))?\s*[:\u2013\u2014](?:\*\*)?\s*|(?:\*\*|\[|\()blocking(?:\*\*|\]|\))\s*/gi;

/** Shortens a gap to a sentence or word end within `gapLength`, marking the cut. */
const clip = (text: string) => {
  if (text.length <= gapLength) return text;
  const head = text.slice(0, gapLength);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  return end > gapLength / 2 ? head.slice(0, end + 1) : `${head.slice(0, head.lastIndexOf(' '))} …`;
};

/** The gaps a passing check named: findings lines that start with `Known gap:`. */
const namedGaps = ({ check, pass, findings = '' }: Verdict) =>
  pass
    ? [...findings.matchAll(/^\s*[-*]?\s*Known gap:\s*(.+)$/gm)].map(
        ([, gap = '']) => `- ${check}: ${clip(gap.replace(blockingLabel, ''))}`
      )
    : [];

const gapsSection = ({ checks, config }: SectionContext) => {
  const gaps = checks.filter(v => !v.pass && !v.skipped && !v.blocked && (!v.gating || !holds(v, { config })));
  const named = checks.flatMap(namedGaps);
  if (!gaps.length && !named.length) return;
  const line = ({ check, findings = '' }: Verdict) => {
    const [first = 'failed without output', next] = findings
      .replace(blockingLabel, '')
      .split('\n')
      .filter(l => l.trim());
    const finding = first.endsWith(':') && next ? `${first} ${next.replace(/^\s*[-*]\s*/, '')}` : first;
    return `- ${check}: ${clip(finding.replace(/^\s*[-*]\s*/, ''))}`;
  };
  return `## Known gaps\n\n${[...gaps.map(line), ...named].join('\n')}`;
};

const criterionLine = /^\s*(\d+)\.\s+(.+?)\s+Test:\s*`?it\((['"`])(.+?)\3\)`?/;

const criteriaSection = ({ brief = '' }: SectionContext) => {
  const rows = brief.split('\n').flatMap(line => {
    const [, , text = '', , title = ''] = criterionLine.exec(line) ?? [];
    return title ? [`| ${text.replace(/\|/g, '\\|')} | \`${title}\` |`] : [];
  });
  if (rows.length) return ['| Criterion | Test |', '| --- | --- |', ...rows].join('\n');
};

const checksSection = ({ checks, config }: SectionContext) => {
  const ran = checks.filter(v => !v.skipped);
  if (!ran.length) return;
  const open = ran.filter(v => !v.pass && (!v.gating || !holds(v, { config })));
  const names = open.map(v => `${v.check} (${config.checks[v.check]?.mode ?? 'log'})`);
  return `Checks: ${ran.filter(v => v.pass).length} of ${ran.length} passed${names.length ? `, not passed: ${names.join(', ')}` : ''}.`;
};

const closesSection = ({ brief = '', issue }: SectionContext, body: string) => {
  if (issue === undefined || new RegExp(`\\b(closes|part of)\\s+#${issue}\\b`, 'i').test(body)) return;
  return `${/^\s*[-*]?\s*Follow-up:/m.test(brief) ? 'Part of' : 'Closes'} #${issue}`;
};

type SectionContext = {
  checks: Verdict[];
  config: Pipeline['config'];
  brief?: string | undefined;
  issue?: number | undefined;
};

/** A merge request body with the engine's `sections` after the bot's text, `closes` first. */
export const withSections = (body: string, ctx: SectionContext, sections: MergeSection[]) => {
  if (!sections.length) return body;
  const closes = sections.includes('closes') ? closesSection(ctx, body) : undefined;
  const parts = {
    criteria: criteriaSection,
    checks: checksSection,
    gaps: gapsSection,
  };
  const rest = sections.flatMap(name => (name === 'closes' ? [] : [parts[name](ctx)]));
  return [closes, body.trim(), ...rest].filter(Boolean).join('\n\n');
};

const baseRuns = new WeakMap<Pipeline['store'], { runs: Map<string, Promise<Judged>>; filed: Set<string> }>();

/** A finding that talks about the change itself says nothing when the check runs on base, where there is none. */
const aboutChange = /\bthe change\b/i;

const pathsIn = (text = '') => text.match(/[\w.@-]+(?:\/[\w.@-]+)+/g) ?? [];

/** Files an issue that `check` fails on the base commit `base`, unless one about that check is still open. */
const fileRedBase = async (check: string, base: string, judged: Judged, p: Pipeline) => {
  const issues = issuesOf(p);
  if (!issues) return;
  const title = `Check ${check} fails on the base branch`;
  if ((await issues.list()).some(issue => issue.title === title)) return;
  const body = `\`${check}\` fails on ${base}, before any change, so every change on top of it fails it too.`;
  await issues.create({ title, body: `${body}\n\n${findingsFor([{ check, gating: true, ...judged }])}` });
};

/**
 * Marks a failing gating script check "red on base" when it fails on the change's base too and names files, none the
 * change touches. A change without files is never red on base. Such a check does not gate, so it costs no attempt and
 * never reaches the bot. Each check runs once per base commit and hub version, in a worktree at that commit, and the
 * result is kept in the data directory. A check marked red on base is filed as an issue once per base commit (see
 * `fileRedBase`).
 */
const redOnBase = async (verdicts: Verdict[], a: Attempt, p: Pipeline): Promise<Verdict[]> => {
  const scriptOf = (v: Verdict) => {
    const check = p.config.checks[v.check];
    const red = check?.type === 'script' && !fanOut(check.over) && !v.pass && !v.skipped && !v.blocked;
    return red && v.gating && holds(v, p) && pathsIn(v.findings).length ? check : undefined;
  };
  if (!verdicts.some(scriptOf)) return verdicts;
  const cache = baseRuns.get(p.store) ?? { runs: new Map<string, Promise<Judged>>(), filed: new Set<string>() };
  baseRuns.set(p.store, cache);
  const { runs, filed } = cache;
  const id = `${a.worktree}-base`;
  let tree: Promise<string> | undefined;
  const onBase = ({ name, run }: Extract<Defined<Check>, { type: 'script' }>) => {
    const key = `${a.base} ${name}`;
    if (!runs.has(key)) {
      const file = p.data && join(p.data, 'base-checks', `${digest(a.base, a.parent.hub ?? '', name)}.json`);
      const timeout = a.job['timeout-minutes'] ?? defaultMinutes;
      const access = { hub: p.hub, readonly: true };
      const fresh = async () => {
        tree ??= p.workspaces.create({ repo: p.event.repo, ref: a.base }, id).then(({ path }) => path);
        const v = scriptVerdict(await checkScript(run, await tree, timeout, scriptEnv(a, p), p, access));
        if (file && !v.blocked) {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, JSON.stringify(v)).catch(() => {});
        }
        return v;
      };
      const judged = (file ? readFile(file, 'utf8').then(text => JSON.parse(text) as Judged) : Promise.reject())
        .catch(fresh)
        .then(v => {
          if (v.blocked) runs.delete(key);
          return v;
        });
      runs.set(key, judged);
      judged.catch(() => runs.delete(key));
    }
    return runs.get(key)!;
  };
  try {
    const { files } = await p.workspaces.changes(a.worktree, a.base);
    if (!files.length) return verdicts;
    return await Promise.all(
      verdicts.map(async v => {
        const check = scriptOf(v);
        if (!check) return v;
        const base = await onBase(check);
        const touched = (path: string) => files.some(file => path.endsWith(file));
        if (base.pass || base.blocked || aboutChange.test(base.findings ?? '') || pathsIn(v.findings).some(touched))
          return v;
        const key = `${a.base} ${check.name}`;
        if (!filed.has(key)) {
          filed.add(key);
          await fileRedBase(check.name, a.base, base, p).catch(() => filed.delete(key));
        }
        const why = `red on base: it fails on ${a.base.slice(0, 7)} too, only in files the change did not touch`;
        return { ...v, gating: false, findings: `${why}\n\n${v.findings}` };
      })
    );
  } catch {
    return verdicts;
  } finally {
    if (tree) await tree.then(() => p.workspaces.remove(p.event.repo, id)).catch(() => {});
  }
};

/** Whether `over` refuses a change with more items than its `max`. */
const capped = (over: Over) => !!hunkOptions(over) || (typeof over === 'object' && 'each' in over);

/** How long the gating script checks run before the later stages start beside the ones still running. */
const headStart = 30_000;

/**
 * Runs the named checks in stages: the gating script checks first, then, only when none that holds the change failed,
 * the gating bot and decide checks, so the cheap gates spare the costly ones. Checks in `warn` and `log` mode never
 * hold a change, so they run last and only when nothing that holds the change failed: they judge only an attempt that
 * settles. A check left out that way is skipped. A failing script check that is red on base (see `redOnBase`) does not
 * hold the change. A later check whose `over` takes at most `max` items counts them beside the script checks, and one
 * that refuses the change for having more fails right away, holding the change before any costly check runs.
 *
 * The later stages do not wait for slow script checks: once every script check has passed or run for `headStart`,
 * they start beside the ones still running. Should a script check then hold the change, they are
 * stopped and those not finished are skipped; a finished verdict is kept. Verdicts keep the order
 * of `names`.
 */
export const runChecks = (names: string[], a: Attempt, p: Pipeline) =>
  Effect.gen(function* () {
    const verdicts: Verdict[] = [];
    const listed = names.map((name, i) => ({ name, i, check: p.config.checks[name] }));
    const late = (mode?: string) => mode === 'log' || mode === 'warn';
    const scripts = listed.filter(({ check }) => !check || (!late(check.mode) && check.type === 'script'));
    const costly = listed.filter(({ check }) => check && !late(check.mode) && check.type !== 'script');
    const logged = listed.filter(({ check }) => late(check?.mode));
    const run = (stage: typeof listed) =>
      Effect.forEach(
        stage,
        ({ name, i, check }) =>
          Effect.map(
            check
              ? runCheck(check, a, p, prepared.get(i))
              : Effect.succeed<Verdict>({ check: name, gating: true, pass: false, findings: 'unknown check' }),
            verdict => (verdicts[i] = verdict)
          ),
        { concurrency: 'unbounded' }
      );
    const skip = (stage: typeof listed, findings: string) =>
      stage.forEach(({ name, i, check }) => {
        verdicts[i] ??= { check: name, gating: check?.mode !== 'log', pass: false, skipped: true, findings };
      });
    const held = (ran: Verdict[]) => ran.some(v => v.gating && !v.skipped && !v.pass && holds(v, p));
    const prepared = new Map(
      [...costly, ...logged].flatMap(({ i, check }) =>
        check && capped(check.over) ? [[i, prepare(check, a, p)] as const] : []
      )
    );
    const scripting = yield* Effect.fork(run(scripts));
    const refused = yield* Effect.promise(async () => {
      const errors = await Promise.all(
        [...prepared.values()].map(ready =>
          ready.then(
            r => r?.error,
            () => undefined
          )
        )
      );
      return [...prepared.keys()].flatMap((i, k) => (errors[k] ? [listed[i]!] : []));
    });
    const refusals = yield* run(refused);
    const left = (stage: typeof listed) => stage.filter(entry => !refused.includes(entry));
    const rest = Effect.gen(function* () {
      if (held(yield* run(left(costly)))) skip(logged, 'not run: a check that holds the change failed');
      else yield* run(left(logged));
    });
    yield* Effect.ignore(Effect.timeout(Fiber.await(scripting), headStart));
    const early = [...refusals, ...scripts.flatMap(({ i }) => verdicts[i] ?? [])];
    const ahead = held(early) ? undefined : yield* Effect.fork(rest);
    const ran = yield* Fiber.join(scripting);
    const scripted = yield* Effect.promise(() => redOnBase(ran, a, p));
    scripts.forEach(({ i }, k) => (verdicts[i] = scripted[k]!));
    if (held(scripted) || held(refusals)) {
      if (ahead) yield* Fiber.interrupt(ahead);
      skip(costly, held(scripted) ? 'not run: a script check failed' : 'not run: a check that holds the change failed');
      skip(logged, 'not run: a check that holds the change failed');
    } else yield* ahead ? Fiber.join(ahead) : rest;
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
