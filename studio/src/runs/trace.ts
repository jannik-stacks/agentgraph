import type { Trace } from '../../../core/src/store.ts';
import type { Outcome, Run } from '../../../core/src/workflow.ts';

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

/** One trace line in a few words. */
export const say = (line: Trace) => {
  if ('session' in line)
    return `session ${line.session.resumed ? 'resumed' : 'started'}, ended ${line.session.ended}, $${line.session.usd}`;
  if ('check' in line) {
    const { check, pass, ms, findings } = line.check;
    return `${check} ${pass ? 'passed' : 'failed'}${line.item ? ` on ${line.item}` : ''} in ${ms} ms${findings ? `: ${findings}` : ''}`;
  }
  if ('applied' in line)
    return `${line.applied.proposal.kind} ${line.applied.ok ? 'applied' : `failed: ${line.applied.reason}`}`;
  if ('outcome' in line) return [line.outcome.kind, detail(line.outcome)].filter(Boolean).join(': ');
  if ('prompt' in line) return `prompt for ${line.prompt.agent}`;
  if ('saved' in line) return `saved ${[...Object.keys(line.saved), ...(line.cleared ?? [])].join(', ')}`;
  return line.event.type;
};

/** A core run as the dev server answers it: the run, its trace, and where it lives. */
export type CoreRun = { fixture: string; repo: string; run: Run; trace: Trace[] };

type Line<K extends string> = Extract<Trace, Record<K, unknown>>;

/** One harness session: its prompt when the trace has one, its events, and how it ended. */
export type Session = { prompt?: Line<'prompt'>; events: Line<'event'>[]; end?: Line<'session'> };

/** A run's trace as the steps it visited in order, each a list of sessions and the other lines. */
export const visitsOf = (trace: Trace[]) => {
  const visits: { step: string; parts: (Session | Trace)[] }[] = [];
  let open: Session | undefined;
  for (const line of trace) {
    if (visits.at(-1)?.step !== line.step) {
      visits.push({ step: line.step, parts: [] });
      open = undefined;
    }
    const parts = visits.at(-1)!.parts;
    const fresh = (): Session => {
      open = { events: [] };
      parts.push(open);
      return open;
    };
    if ('prompt' in line) fresh().prompt = line;
    else if ('event' in line) {
      const started = open?.events.some(e => e.event.type === 'start');
      (!open || (line.event.type === 'start' && started) ? fresh() : open).events.push(line);
    } else if ('session' in line) {
      (open ?? fresh()).end = line;
      open = undefined;
    } else parts.push(line);
  }
  return visits;
};

/** The pages a run left on the forge: the comments, commits, pull requests and issues it applied. */
export const linksOf = (trace: Trace[]) =>
  trace.flatMap(line =>
    'applied' in line && line.applied.url ? [{ kind: line.applied.proposal.kind, url: line.applied.url }] : []
  );
