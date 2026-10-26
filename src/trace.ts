import { Data } from 'effect';
import type { Applied, Event } from './event.ts';
import type { Agent, Check } from './folder.ts';
import type { Checkout } from './sandbox.ts';
import type { CheckResult, Outcome, Run } from './workflow.ts';

export type SessionSpec = {
  harness: Agent['harness'];
  model?: string;
  system: string;
  prompt: string;
  dir: string;
  base?: string;
  tools: string[];
  /** Directories outside `dir` the session may read. */
  read?: string[];
  agent: string;
  /** The check this session judges, when it judges one. */
  check?: string;
  returns?: NonNullable<Check['returns']>;
  minutes: number;
  resume?: Run['sessions'][string];
  /** Opens a copy of `resume` in a new home, leaving the resumed session as it was. */
  fork?: true;
};

/** What a session does, as the harness reports it. `end` comes once the harness exits; with `ended: 'error'` and no reply, `final` holds the harness's error. */
export type SessionEvent =
  | { type: 'start'; session: string; harness: string; provider?: string; model: string; home: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: unknown;
      output?: string;
      ok?: boolean;
      exit?: number;
      denied?: true;
      /** How long the tool ran, when the harness says. */
      ms?: number;
    }
  /** `input` counts every input token, cache reads and writes among them. */
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      usd?: number;
      /** The model no list price was found for, when the harness reported no cost either. */
      unpriced?: string;
    }
  | { type: 'end'; final: string; ended: 'stop' | 'cap' | 'error'; exit: number };

export class SessionStop extends Data.TaggedError('SessionStop')<{
  reason: 'timeout' | 'stalled' | 'budget' | 'provider' | 'human' | 'sandbox';
  detail?: string;
}> {}

/** The comment an aside answered, when the run noted it. */
export type Aside = { issue?: number; comment?: string; review?: true };

/**
 * One line of a run's trace. A `prompt` line holds everything a session is opened with and precedes its events. A
 * `saved` line holds the fields of `run.json` that a put changed, and `cleared` the ones it removed. A session's prompt,
 * event and session lines share its `key`, so sessions running at once stay apart. Check results are not trace lines but
 * entries of the run's check record.
 */
export type Trace = { at: string; step: string } & (
  | { prompt: SessionSpec; key?: string; item?: string; aside?: Aside }
  | { event: SessionEvent; key?: string }
  | {
      key?: string;
      session: {
        id?: string;
        resumed: boolean;
        aside?: true;
        ended: Extract<SessionEvent, { type: 'end' }>['ended'] | SessionStop['reason'];
        exit?: number;
        usd: number;
      };
    }
  | { setup: { ms: number; exit: number } }
  | { cache: { files: number } }
  | { env: NonNullable<Checkout['env']> }
  | { applied: Applied }
  | { outcome: Outcome; run: Pick<Run, 'step' | 'status' | 'tries' | 'rounds'> }
  | { saved: Partial<Run>; cleared?: (keyof Run)[] }
  | { spoken: Event }
  | { told: { text: string; by: string } }
);

/** A check's full output in the store: its sha256 and its length in bytes. */
export type Log = { hash: string; bytes: number };

export type CheckEntry = {
  at: string;
  step: string;
  check: CheckResult;
  version: string;
  usd: number;
  item?: string;
  exit?: number;
  log?: Log;
  later?: true;
};

export const findLatestChecks = (entries: CheckEntry[], versions: Record<string, string> = {}, from = '') => {
  const latest = new Map<string, CheckEntry>();
  const current = (e: CheckEntry) => versions[e.check.check] === undefined || versions[e.check.check] === e.version;
  for (const e of entries.toSorted((a, b) => a.at.localeCompare(b.at))) {
    if (e.item !== undefined || e.at < from) continue;
    const was = latest.get(e.check.check);
    if (!was || current(e) || !current(was)) latest.set(e.check.check, e);
  }
  return [...latest.values()].map(e => (current(e) ? e : { ...e, older: true as const }));
};
