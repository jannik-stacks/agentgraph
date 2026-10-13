import type { PullRow, RunRow } from '../../../src/live.ts';
import type { EventRecord, RunStatus } from '../../../src/store.ts';
import type { AgentEvent, BotEvent } from '../../../src/types.ts';
import { chars, estimate, type Price, sum, type Tally, tokensOf } from '../../../src/usage.ts';
import type { Tone } from '../graph-model.ts';
import type { Glyph } from '../studio/icons.tsx';

export type Prices = Record<string, Price & { model: string }>;

const live: RunStatus[] = ['queued', 'running'];
const failed: RunStatus[] = ['failed', 'timed-out', 'interrupted'];

export const isLive = (status: RunStatus) => live.includes(status);
export const isFailed = (status: RunStatus) => failed.includes(status);

/** The icon and tone of a status: a spinner while running. */
export const statusLook = (status: RunStatus): { glyph: Glyph; tone: Tone } =>
  status === 'running'
    ? { glyph: 'live', tone: 'info' }
    : status === 'queued'
      ? { glyph: 'queued', tone: 'neutral' }
      : status === 'succeeded'
        ? { glyph: 'ok', tone: 'ok' }
        : isFailed(status)
          ? { glyph: 'fail', tone: 'danger' }
          : { glyph: 'skipped', tone: 'neutral' };

/** Billed cost as the harness reported it, and the list-price estimate when the model has a price. */
export const costOf = (tally: Tally, model: string | undefined, prices: Prices) => ({
  billed: tally.usd,
  estimated: estimate(tally, model ? prices[model] : undefined),
});

/** Estimated cost summed over runs, each at its own model's price; billed cost where no price is known. */
export const costOfRuns = (runs: RunRow[], prices: Prices) => {
  let billed = 0;
  let estimated = 0;
  let priced = false;
  for (const run of runs) {
    const cost = costOf(run.tally, run.model, prices);
    billed += cost.billed;
    if (cost.estimated !== undefined) priced = true;
    estimated += Math.max(cost.estimated ?? 0, cost.billed);
  }
  return { billed, estimated: priced ? estimated : undefined };
};

export const durationMs = (run: Pick<RunRow, 'startedAt' | 'endedAt'>, now = Date.now()) =>
  run.startedAt ? new Date(run.endedAt ?? now).getTime() - new Date(run.startedAt).getTime() : undefined;

/** One job of a triggering event: its attempts in order, and the check runs that judged each attempt. */
export type JobNode = {
  key: string;
  workflow: string;
  job: string;
  attempts: RunRow[];
  checks: Map<string, RunRow[]>;
  status: RunStatus;
};

/** A causal link between two triggering events: which job's work started the other event. */
export type Link = { event: string; job: string; run: string; label: string; likely?: boolean };

/** Everything one event started, like a workflow run on GitHub Actions. */
export type Group = {
  event: BotEvent;
  runs: RunRow[];
  jobs: JobNode[];
  status: RunStatus;
  tally: Tally;
  startedAt: string;
  causedBy?: Link;
  caused: Link[];
};

/** The run an attempt or check belongs to: checks name their attempt, attempts the one before. */
export const rootOf = (run: RunRow, byId: Map<string, RunRow>) => {
  let current = run;
  for (;;) {
    const parent = current.parent ? byId.get(current.parent) : undefined;
    if (!parent || !(current.check || (current.attempt ?? 1) > 1)) return current;
    current = parent;
  }
};

/** The attempts of the job execution starting at `root`, in order. */
export const attemptsOf = (root: RunRow, runs: RunRow[]) => {
  const attempts = [root];
  for (;;) {
    const last = attempts.at(-1)!;
    const next = runs.find(r => r.parent === last.id && !r.check && (r.attempt ?? 1) > (last.attempt ?? 1));
    if (!next) return attempts;
    attempts.push(next);
  }
};

export const checksOf = (attempt: RunRow, runs: RunRow[]) => {
  const checks = new Map<string, RunRow[]>();
  for (const run of runs)
    if (run.check && run.parent === attempt.id) checks.set(run.check, [...(checks.get(run.check) ?? []), run]);
  for (const list of checks.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return checks;
};

const groupStatus = (statuses: RunStatus[]): RunStatus =>
  statuses.find(s => s === 'running') ??
  statuses.find(s => s === 'queued') ??
  statuses.find(isFailed) ??
  (statuses.every(s => s === 'skipped' || s === 'cancelled') ? (statuses[0] ?? 'skipped') : 'succeeded');

const jobsOf = (runs: RunRow[], byId: Map<string, RunRow>) => {
  const roots = runs.filter(run => rootOf(run, byId) === run);
  return roots.map((root): JobNode => {
    const attempts = attemptsOf(root, runs);
    const checks = new Map<string, RunRow[]>();
    for (const attempt of attempts)
      for (const [name, list] of checksOf(attempt, runs)) checks.set(name, [...(checks.get(name) ?? []), ...list]);
    const last = attempts.at(-1)!;
    const statuses = [last.status, ...[...checks.values()].map(list => list.at(-1)!.status)];
    const checkFailed = last.brief?.checks?.some(v => v.gating && !v.pass && !v.skipped);
    return {
      key: root.id,
      workflow: root.workflow,
      job: root.job,
      attempts,
      checks,
      status: checkFailed && !isLive(last.status) ? 'failed' : groupStatus(statuses),
    };
  });
};

const isBot = (event: BotEvent) => event.actor.login.endsWith('[bot]');

const findCause = (group: Group, groups: Group[], pulls: PullRow[]): Link | undefined => {
  const { event } = group;
  const before = (run: RunRow) => (run.endedAt ?? run.startedAt ?? run.event.ts) <= event.ts;
  if (event.trigger === 'pull_request' && event.number !== undefined) {
    const pull = pulls.find(p => p.number === event.number);
    const source = pull?.origin && groups.find(g => g.event.id === pull.origin?.event);
    const opener =
      source?.runs.find(r => r.job === pull?.origin?.job && r.brief?.pr === event.number) ??
      source?.runs.find(r => r.job === pull?.origin?.job) ??
      groups.flatMap(g => g.runs).find(r => r.brief?.pr === event.number);
    if (opener)
      return {
        event: opener.event.id,
        job: opener.job,
        run: opener.id,
        label: `${opener.job}${opener.event.number === undefined ? '' : ` on #${opener.event.number}`}`,
      };
  }
  if (!isBot(event) || event.number === undefined) return;
  const kind = event.trigger === 'issue_comment' ? 'reply' : event.action === 'labeled' ? 'label' : undefined;
  if (!kind) return;
  const run = groups
    .flatMap(g => (g === group ? [] : g.runs))
    .filter(
      r =>
        r.event.number === event.number &&
        before(r) &&
        r.brief?.results.some(x => x.kind === kind && x.status === 'applied')
    )
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  return (
    run && {
      event: run.event.id,
      job: run.job,
      run: run.id,
      label: `${run.job} on #${event.number}`,
      likely: true,
    }
  );
};

/** Runs grouped by the event that started them, newest first, with the links between events. */
export const groupRuns = (rows: RunRow[], pulls: PullRow[]): Group[] => {
  const byEvent = new Map<string, RunRow[]>();
  for (const row of rows) byEvent.set(row.event.id, [...(byEvent.get(row.event.id) ?? []), row]);
  const byId = new Map(rows.map(r => [r.id, r]));
  const groups = [...byEvent.values()].map((list): Group => {
    const runs = list.toSorted((a, b) => (a.id < b.id ? -1 : 1));
    return {
      event: runs[0]!.event,
      runs,
      jobs: jobsOf(runs, byId),
      status: groupStatus(runs.map(r => r.status)),
      tally: sum(runs.map(r => r.tally)),
      startedAt: runs[0]!.startedAt ?? runs[0]!.event.ts,
      caused: [],
    };
  });
  for (const group of groups) {
    const cause = findCause(group, groups, pulls);
    if (!cause) continue;
    group.causedBy = cause;
    groups
      .find(g => g.event.id === cause.event)
      ?.caused.push({
        event: group.event.id,
        job: cause.job,
        run: cause.run,
        label: `${group.event.trigger}${group.event.number === undefined ? '' : ` #${group.event.number}`}`,
        ...(cause.likely && { likely: true }),
      });
  }
  return groups.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
};

/** A title for an event: local issue events carry their slug in the url. */
export const eventTitle = (event: BotEvent) => {
  const slug = /(?:^|\/)\d+-([^/#]+)\.md/.exec(event.url ?? '')?.[1];
  if (slug) return slug.replace(/-/g, ' ');
  return event.body?.split('\n')[0]?.slice(0, 80) ?? event.trigger;
};

export const triggerGlyph = (event: BotEvent): Glyph =>
  event.trigger === 'issue_comment' || event.trigger === 'pull_request_review_comment'
    ? 'comment'
    : event.trigger === 'pull_request'
      ? 'pull'
      : event.trigger === 'issues'
        ? event.action === 'labeled' || event.action === 'unlabeled'
          ? 'label'
          : 'question'
        : event.trigger === 'schedule'
          ? 'schedule'
          : event.trigger === 'push'
            ? 'push'
            : 'manual';

type ToolCall = Extract<AgentEvent, { type: 'tool_call' }>;
type ToolResult = Extract<AgentEvent, { type: 'tool_result' }>;
type Usage = Extract<AgentEvent, { type: 'usage' }>;

/** A tool call with its result. `carried` counts the model calls after it, which each read its result again. */
export type ToolStep = {
  seq: number;
  call: ToolCall;
  result?: ToolResult;
  argChars: number;
  resultChars: number;
  carried: number;
};

/** Everything between two model calls: what the model said, the tools it called, and the call's usage. */
export type Turn = {
  index: number;
  seq: number;
  texts: { seq: number; text: string }[];
  tools: ToolStep[];
  usage?: Usage;
  /** Input tokens added since the previous call: new tool results and messages. */
  grew?: number;
};

/** A run's records as turns, plus what started and ended it. */
export const turnsOf = (records: EventRecord[]) => {
  const turns: Turn[] = [];
  const pending = new Map<string, ToolStep>();
  let start: Extract<AgentEvent, { type: 'start' }> | undefined;
  let end: Extract<AgentEvent, { type: 'end' }> | undefined;
  const errors: string[] = [];
  let current: Turn | undefined;
  const turn = (seq: number) => {
    if (!current) turns.push((current = { index: turns.length, seq, texts: [], tools: [] }));
    return current;
  };
  for (const { seq, event } of records) {
    switch (event.type) {
      case 'start':
        start = { ...start, ...event };
        break;
      case 'text':
        turn(seq).texts.push({ seq, text: event.text });
        break;
      case 'tool_call': {
        const step: ToolStep = { seq, call: event, argChars: chars(event.input), resultChars: 0, carried: 0 };
        pending.set(event.id, step);
        turn(seq).tools.push(step);
        break;
      }
      case 'tool_result': {
        const step = pending.get(event.id);
        if (step) {
          step.result = event;
          step.resultChars = chars(event.output);
        }
        break;
      }
      case 'usage': {
        turn(seq).usage = event;
        current = undefined;
        break;
      }
      case 'end':
        end = event;
        break;
      case 'error':
        errors.push(event.message);
        break;
    }
  }
  const calls = turns.filter(t => t.usage);
  let previous: number | undefined;
  for (const t of turns) {
    if (t.usage) {
      if (previous !== undefined) t.grew = Math.max(0, t.usage.inputTokens - previous);
      previous = t.usage.inputTokens;
    }
    const after = calls.filter(c => c.index > t.index).length;
    for (const tool of t.tools) tool.carried = after;
  }
  return { turns, start, end, errors };
};

/** Estimated cost of a tool call: its arguments as output once, its result as input on every later call. */
export const toolCost = (tool: ToolStep, price: Price | undefined) => {
  const args = tokensOf(tool.argChars);
  const result = tokensOf(tool.resultChars);
  const carried = result * tool.carried;
  return {
    args,
    result,
    carried,
    estimated:
      price &&
      (args * price.output +
        (tool.carried ? result * price.input + result * (tool.carried - 1) * (price.cached ?? price.input) : 0)) /
        1e6,
  };
};

/**
 * Where a run's input tokens went, roughly: the setup every call re-reads (system prompt, preload, task and tool
 * definitions, measured as the first call's input), tool results carried into later calls, the rest of the
 * conversation, and output.
 */
export const tokensByKind = (turns: Turn[]) => {
  const calls = turns.filter(t => t.usage);
  const input = calls.reduce((n, t) => n + t.usage!.inputTokens, 0);
  const setup = (calls[0]?.usage?.inputTokens ?? 0) * calls.length;
  const tools = turns.flatMap(t => t.tools).reduce((n, tool) => n + tokensOf(tool.resultChars) * tool.carried, 0);
  const output = calls.reduce((n, t) => n + t.usage!.outputTokens + (t.usage!.reasoningTokens ?? 0), 0);
  return {
    setup: Math.min(setup, input),
    tools: Math.min(tools, Math.max(0, input - setup)),
    conversation: Math.max(0, input - setup - tools),
    output,
  };
};

export const topTools = (turns: Turn[], n = 5) =>
  turns
    .flatMap(t => t.tools)
    .toSorted((a, b) => b.resultChars * b.carried - a.resultChars * a.carried)
    .slice(0, n);
