import { Struct } from 'effect';
import type { Located } from '../../../src/store.ts';
import type { readRunLabels } from '../../../src/labels.ts';
import { isOnIssue } from '../../../src/graph.ts';
import { getRunSpend } from '../../../src/trace.ts';
import { makeRunTrail } from '../graph/visits.ts';
import { type CheckEntry, type CheckResult, type Outcome, type RunRecord, type Trace } from '../../../src/types.ts';

export const formatNumber = (n: number) =>
  Math.abs(n) >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : Math.abs(n) >= 1e4
      ? `${(n / 1e3).toFixed(1)}k`
      : String(Number.isInteger(n) ? n : Number(n.toPrecision(3)));

export type Line = Trace | CheckEntry;

export const mergeCheckEntries = (trace: Trace[], checks: CheckEntry[]): Line[] =>
  [...trace, ...checks].toSorted((a, b) => a.at.localeCompare(b.at));

export const formatCheckValue = ({ value, share }: Pick<CheckResult, 'value' | 'share'>) =>
  [
    ...Object.entries(value ?? {}).map(
      ([k, v]) => `${k} ${typeof v === 'number' ? formatNumber(v) : JSON.stringify(v)}`
    ),
    ...(share === undefined ? [] : [`${Math.round(share * 100)}% of items passed`]),
  ].join(', ');

/** What an outcome says beyond its kind. */
export const detail = (o: Outcome) =>
  o.kind === 'failed'
    ? [
        ...o.checks.map(c => `${c.check} failed`),
        ...o.proposals.map(a => `${a.proposal.kind} failed`),
        ...o.problems,
      ].join('; ')
    : 'why' in o
      ? o.why
      : 'question' in o
        ? o.question
        : 'text' in o
          ? o.text
          : '';

/**
 * The pull request a run opened, else the one an update names, and the branch it last wrote; read from the
 * whole trace, since the run list cuts long texts short.
 */
export const findTraceLinks = (trace: Trace[]): { pull?: string; branch?: string } => {
  let pull: string | undefined;
  let branch: string | undefined;
  for (const line of trace) {
    if (!('applied' in line) || !line.applied.ok) continue;
    const p = line.applied.proposal;
    if ('branch' in p) branch = p.branch;
    if (p.kind === 'pull_request') pull = line.applied.url ?? pull;
    else if (p.kind === 'comment') pull = /^Pull request: (\S+)$/m.exec(p.body)?.[1] ?? pull;
  }
  return { ...(pull && { pull }), ...(branch && { branch }) };
};

export const makeRunSummary = (run: RunRecord, lines: Line[]) => ({
  ...getRunSpend(lines),
  ...(lines.length > 0 && { lastAt: lines.at(-1)!.at }),
  trail: isOnIssue(run) ? makeRunTrail(lines) : [],
  urls: lines.flatMap(line =>
    'applied' in line && line.applied.url && ['issue', 'merge'].includes(line.applied.proposal.kind)
      ? [line.applied.url]
      : []
  ),
});

const listedFields = [
  'id',
  'workflow',
  'issue',
  'title',
  'body',
  'step',
  'status',
  'tries',
  'rounds',
  'reason',
  'waiting',
  'said',
  'by',
  'started',
  'ended',
] as const;

export const pickListedRun = (run: RunRecord, body: boolean) =>
  Struct.pick(
    run,
    listedFields.filter(k => body || k !== 'body')
  );

/** A run as the dev server answers it: the run, its summary, where it lives, its pull request and branch, and its trace when opened alone. */
export type ServedRun = {
  fixture: string;
  repo: string;
  run: ReturnType<typeof pickListedRun>;
  labels: ReturnType<typeof readRunLabels>;
  trace?: Line[];
  data?: string;
  instance?: string;
} & ReturnType<typeof findTraceLinks> &
  Omit<ReturnType<typeof makeRunSummary>, 'trail'>;

export type TraceLineWithKey<K extends string> = Extract<Line, Record<K, unknown>>;

/** One harness session: its prompt when the trace has one, its events, and how it ended. */
export type SessionTraceLines = {
  prompt?: TraceLineWithKey<'prompt'>;
  events: TraceLineWithKey<'event'>[];
  end?: TraceLineWithKey<'session'>;
};

/**
 * A run's trace as the steps it visited in order, each a list of sessions and the other lines. Lines with a `key` join
 * the session that key opened. Older lines without one join the session opened last, and an end joins the session
 * that started with its id.
 */
export const splitTraceIntoVisitedSteps = (trace: Line[]) => {
  const visits: { step: string; parts: (SessionTraceLines | Line)[] }[] = [];
  const keyed = new Map<string, SessionTraceLines>();
  let open: SessionTraceLines | undefined;
  for (const line of trace) {
    if (visits.at(-1)?.step !== line.step) {
      visits.push({ step: line.step, parts: [] });
      open = undefined;
    }
    const parts = visits.at(-1)!.parts;
    const fresh = (): SessionTraceLines => {
      const made: SessionTraceLines = { events: [] };
      parts.push(made);
      return made;
    };
    if (!('prompt' in line || 'event' in line || 'session' in line)) {
      parts.push(line);
      continue;
    }
    if (line.key !== undefined) {
      const session = keyed.get(line.key) ?? fresh();
      keyed.set(line.key, session);
      if ('prompt' in line) session.prompt = line;
      else if ('event' in line) session.events.push(line);
      else session.end = line;
      continue;
    }
    if ('prompt' in line) (open = fresh()).prompt = line;
    else if ('event' in line) {
      const started = open?.events.some(e => e.event.type === 'start');
      if (!open || (line.event.type === 'start' && started)) open = fresh();
      open.events.push(line);
    } else {
      const id = line.session.id;
      const same = parts.findLast(
        (p): p is SessionTraceLines =>
          'events' in p && !p.end && p.events.some(e => e.event.type === 'start' && e.event.session === id)
      );
      (same ?? open ?? fresh()).end = line;
      if (!same || same === open) open = undefined;
    }
  }
  return visits;
};

/** The trace line `?at=` opens: the write stamped then, else the line stamped then, else the first write at or after it, else any line. */
export const lineAt = (trace: Line[], at: string | null) =>
  at === null
    ? undefined
    : (trace.find(l => 'applied' in l && l.applied.at === at) ??
      trace.find(l => l.at === at) ??
      trace.find(l => 'applied' in l && l.at >= at) ??
      trace.find(l => l.at >= at));

export const makeDataHref = (href: string, data: string | null | undefined) =>
  data ? `${href}${href.includes('?') ? '&' : '?'}data=${encodeURIComponent(data)}` : href;

export const makeRunKey = (instance: string | undefined, id: string) => JSON.stringify([instance ?? '', id]);

/** The studio page of a run, at one trace line when `at` is given. */
export const atLink = (run: string, at?: string, data?: string | null) =>
  makeDataHref(`/runs/${encodeURIComponent(run)}${at ? `?at=${at}` : ''}`, data);

/** The graph page with the run and `step` selected. */
export const graphLink = (r: ServedRun, step: string) =>
  `/graph?run=${encodeURIComponent(`${r.fixture}:${r.run.id}`)}&step=${encodeURIComponent(`${r.run.workflow}/${step}`)}`;

/** Where a `locate` answer opens: the run at that write, or the runs of an issue. */
export const locatedLink = (found: Located) =>
  'run' in found ? atLink(found.run, found.at) : `/runs?issue=${found.issue}`;

/** Whether pasted text is a GitHub issue, pull request or comment link, or a comment id, for `/runs?gh=`. */
export const isGitHubRef = (text: string) =>
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+\S*$/.test(text) || /^\d{7,}$/.test(text);
