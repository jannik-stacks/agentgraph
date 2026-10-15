import type { RunRow } from '../../../src/live.ts';
import type { EventRecord, RunStatus } from '../../../src/store.ts';
import type { AgentEvent, BotEvent } from '../../../src/types.ts';
import { estimate, type Price, type Tally } from '../../../src/usage.ts';

export type Prices = Record<string, Price & { model: string }>;

const live: RunStatus[] = ['queued', 'running'];
const failed: RunStatus[] = ['failed', 'timed-out', 'interrupted'];

export const isLive = (status: RunStatus) => live.includes(status);
export const isFailed = (status: RunStatus) => failed.includes(status);

/**
 * Where a run stands for a reader: `running`, `queued` or `waiting` on a human (it blocked, deferred or asked), `failed`,
 * or `done`. Everything but `done` takes the accent color, and the word tells them apart.
 */
export type Phase = 'running' | 'queued' | 'waiting' | 'failed' | 'done';

const order: Phase[] = ['running', 'queued', 'waiting', 'failed', 'done'];

/** The phase that needs attention first. */
const firstPhase = (phases: Phase[]) => order.find(p => phases.includes(p)) ?? 'done';

export const phaseOf = (run: Pick<RunRow, 'status' | 'closure' | 'brief'>): Phase => {
  if (run.status === 'running') return 'running';
  if (run.status === 'queued') return 'queued';
  if (run.closure === 'blocked' || run.closure === 'deferred' || run.brief?.kinds.includes('ask')) return 'waiting';
  if (isFailed(run.status)) return 'failed';
  return 'done';
};

/** The word for a phase; a failure names how it failed. */
export const phaseWord = (phase: Phase, status?: RunStatus) =>
  phase === 'waiting'
    ? 'waiting for a human'
    : phase === 'failed' && status && status !== 'failed'
      ? status.replace('-', ' ')
      : phase;

/** Billed cost as the harness reported it, and the list-price estimate when the model has a price. */
export const costOf = (tally: Tally, model: string | undefined, prices: Prices) => ({
  billed: tally.usd,
  estimated: estimate(tally, model ? prices[model] : undefined),
});

/** One job of a triggering event: its attempts in order, and the check runs that judged each attempt. */
export type JobNode = {
  key: string;
  workflow: string;
  job: string;
  attempts: RunRow[];
  checks: Map<string, RunRow[]>;
  phase: Phase;
};

/** Everything one event started, like a workflow run on GitHub Actions. */
export type Group = { event: BotEvent; runs: RunRow[]; jobs: JobNode[]; phase: Phase; startedAt: string };

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

const jobsOf = (runs: RunRow[], byId: Map<string, RunRow>) =>
  runs
    .filter(run => rootOf(run, byId) === run)
    .map((root): JobNode => {
      const attempts = attemptsOf(root, runs);
      const checks = new Map<string, RunRow[]>();
      for (const attempt of attempts)
        for (const [name, list] of checksOf(attempt, runs)) checks.set(name, [...(checks.get(name) ?? []), ...list]);
      const last = attempts.at(-1)!;
      const lastChecks = [...checks.values()].map(list => list.at(-1)!);
      const checkFailed = last.brief?.checks?.some(v => v.gating && !v.pass && !v.skipped);
      const phase = firstPhase([
        phaseOf(last),
        ...lastChecks.map(r => (isLive(r.status) ? phaseOf(r) : ('done' as const))),
      ]);
      return {
        key: root.id,
        workflow: root.workflow,
        job: root.job,
        attempts,
        checks,
        phase: phase === 'done' && checkFailed ? 'failed' : phase,
      };
    });

/** Runs grouped by the event that started them, newest first. */
export const groupRuns = (rows: RunRow[]): Group[] => {
  const byEvent = new Map<string, RunRow[]>();
  for (const row of rows) byEvent.set(row.event.id, [...(byEvent.get(row.event.id) ?? []), row]);
  const byId = new Map(rows.map(r => [r.id, r]));
  return [...byEvent.values()]
    .map((list): Group => {
      const runs = list.toSorted((a, b) => (a.id < b.id ? -1 : 1));
      const jobs = jobsOf(runs, byId);
      return {
        event: runs[0]!.event,
        runs,
        jobs,
        phase: firstPhase(jobs.map(j => j.phase)),
        startedAt: runs[0]!.startedAt ?? runs[0]!.event.ts,
      };
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
};

/** A title for an event: local issue events carry their slug in the url. */
export const eventTitle = (event: BotEvent) => {
  const slug = /(?:^|\/)\d+-([^/#]+)\.md/.exec(event.url ?? '')?.[1];
  if (slug) return slug.replace(/-/g, ' ');
  return event.body?.split('\n')[0]?.slice(0, 80) ?? event.trigger;
};

type ToolCall = Extract<AgentEvent, { type: 'tool_call' }>;
type ToolResult = Extract<AgentEvent, { type: 'tool_result' }>;
type Usage = Extract<AgentEvent, { type: 'usage' }>;

/** A tool call with its result. */
export type ToolStep = { seq: number; call: ToolCall; result?: ToolResult };

/** Everything between two model calls: what the model said, the tools it called, and the call's usage. */
export type Turn = {
  index: number;
  seq: number;
  texts: { seq: number; text: string }[];
  tools: ToolStep[];
  usage?: Usage;
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
        const step: ToolStep = { seq, call: event };
        pending.set(event.id, step);
        turn(seq).tools.push(step);
        break;
      }
      case 'tool_result': {
        const step = pending.get(event.id);
        if (step) step.result = event;
        break;
      }
      case 'usage':
        if (event.source && event.source !== 'harness') break;
        turn(seq).usage = event;
        current = undefined;
        break;
      case 'end':
        end = event;
        break;
      case 'error':
        errors.push(event.message);
        break;
    }
  }
  return { turns, start, end, errors };
};
