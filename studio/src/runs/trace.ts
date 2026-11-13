import { Struct } from 'effect';
import { listedRunFields, type OpenedRun, type RunLineCount, type ServedRun } from '../../../src/actions.ts';
import type { Located } from '../../../src/store.ts';
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

export const mergeLines = (...lists: Line[][]): Line[] => lists.flat().toSorted((a, b) => a.at.localeCompare(b.at));

export const getRunLineCount = (lines: Line[]): typeof RunLineCount.Type => {
  const checks = lines.filter(line => 'check' in line).length;
  return { trace: lines.length - checks, checks };
};

export const formatCheckValue = ({ value, share }: Pick<CheckResult, 'value' | 'share'>) =>
  [
    ...Object.entries(value ?? {}).map(
      ([k, v]) => `${k} ${typeof v === 'number' ? formatNumber(v) : JSON.stringify(v)}`
    ),
    ...(share === undefined ? [] : [`${Math.round(share * 100)}% of items passed`]),
  ].join(', ');

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

export const findTraceLinks = (trace: Trace[]): { pull?: string; branch?: string } => {
  let pull: string | undefined;
  let branch: string | undefined;
  for (const line of trace) {
    if (!('applied' in line) || !line.applied.ok || line.applied.skip) continue;
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

export const pickListedRun = (run: RunRecord, body: boolean) =>
  Struct.pick(
    run,
    listedRunFields.filter(k => body || k !== 'body')
  );

export type { OpenedRun, ServedRun };

export type TraceLineWithKey<K extends string> = Extract<Line, Record<K, unknown>>;

export type SessionTraceLines = {
  prompt?: TraceLineWithKey<'prompt'>;
  events: TraceLineWithKey<'event'>[];
  end?: TraceLineWithKey<'session'>;
};

export const splitTraceIntoVisitedSteps = (trace: Line[]) => {
  const visits: { step: string; parts: (SessionTraceLines | Line)[]; lines: Line[] }[] = [];
  const keyed = new Map<string, SessionTraceLines>();
  let open: SessionTraceLines | undefined;
  for (const line of trace) {
    if (visits.at(-1)?.step !== line.step) {
      visits.push({ step: line.step, parts: [], lines: [] });
      open = undefined;
    }
    visits.at(-1)!.lines.push(line);
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

export const atLink = (run: string, at?: string, data?: string | null) =>
  makeDataHref(`/runs/${encodeURIComponent(run)}${at ? `?at=${at}` : ''}`, data);

export const graphLink = (r: ServedRun, step: string) =>
  `/graph?run=${encodeURIComponent(`${r.fixture}:${r.run.id}`)}&step=${encodeURIComponent(`${r.run.workflow}/${step}`)}`;

export const locatedLink = (found: Located) =>
  'run' in found ? atLink(found.run, found.at) : `/runs?issue=${found.issue}`;

export const isGitHubRef = (text: string) =>
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+\S*$/.test(text) || /^\d{7,}$/.test(text);
