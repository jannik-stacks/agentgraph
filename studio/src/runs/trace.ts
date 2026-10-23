import type { Located, Trace } from '../../../src/store.ts';
import type { Outcome, Run } from '../../../src/workflow.ts';

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
 * The pull request a run opened, else the one its status comment names, and the branch it last wrote; read from the
 * whole trace, since the run list cuts long texts short.
 */
export const linksOf = (trace: Trace[]): { pull?: string; branch?: string } => {
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

/** A run as the dev server answers it: the run, its trace, where it lives, and its pull request and branch. */
export type ServedRun = { fixture: string; repo: string; run: Run; trace: Trace[] } & ReturnType<typeof linksOf>;

export type Line<K extends string> = Extract<Trace, Record<K, unknown>>;

/** One harness session: its prompt when the trace has one, its events, and how it ended. */
export type Session = { prompt?: Line<'prompt'>; events: Line<'event'>[]; end?: Line<'session'> };

/**
 * A run's trace as the steps it visited in order, each a list of sessions and the other lines. Lines with a `key` join
 * the session that key opened. Older lines without one join the session opened last, and an end joins the session
 * that started with its id.
 */
export const visitsOf = (trace: Trace[]) => {
  const visits: { step: string; parts: (Session | Trace)[] }[] = [];
  const keyed = new Map<string, Session>();
  let open: Session | undefined;
  for (const line of trace) {
    if (visits.at(-1)?.step !== line.step) {
      visits.push({ step: line.step, parts: [] });
      open = undefined;
    }
    const parts = visits.at(-1)!.parts;
    const fresh = (): Session => {
      const made: Session = { events: [] };
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
        (p): p is Session =>
          'events' in p && !p.end && p.events.some(e => e.event.type === 'start' && e.event.session === id)
      );
      (same ?? open ?? fresh()).end = line;
      if (!same || same === open) open = undefined;
    }
  }
  return visits;
};

/** The trace line `?at=` opens: the write stamped then, else the first write at or after it, else any line. */
export const lineAt = (trace: Trace[], at: string | null) =>
  at === null
    ? undefined
    : (trace.find(l => 'applied' in l && l.applied.at === at) ??
      trace.find(l => 'applied' in l && l.at >= at) ??
      trace.find(l => l.at >= at));

/** The studio page of a run at one trace line. */
export const atLink = (run: string, at: string) => `/runs/${encodeURIComponent(run)}?at=${at}`;

/** The graph page with the run picked and `step` selected. */
export const graphLink = (r: ServedRun, step: string) =>
  `/graph?run=${encodeURIComponent(`${r.fixture}:${r.run.id}`)}&step=${encodeURIComponent(`${r.run.workflow}/${step}`)}`;

/** Where a `locate` answer opens: the run at that write, or the runs of an issue. */
export const locatedLink = (found: Located) =>
  'run' in found ? atLink(found.run, found.at) : `/runs?issue=${found.issue}`;

/** Whether pasted text is a GitHub issue, pull request or comment link, or a comment id, for `/runs?gh=`. */
export const isGitHubRef = (text: string) =>
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+\S*$/.test(text) || /^\d{7,}$/.test(text);
