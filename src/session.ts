import { Context, Data, Stream, type Scope } from 'effect';
import type { Agent } from './hub.ts';
import type { Run } from './workflow.ts';

export type SessionSpec = {
  harness: Agent['harness'];
  model?: string;
  system: string;
  prompt: string;
  dir: string;
  tools: string[];
  /** Directories outside `dir` the session may read. */
  read?: string[];
  agent: string;
  /** The check this session judges, when it judges one. */
  check?: string;
  minutes: number;
  resume?: Run['sessions'][string];
  /** Opens a copy of `resume` in a new home, leaving the resumed session as it was. */
  fork?: true;
};

/** What a session does, as the harness reports it. `end` comes once the harness exits; with `ended: 'error'` and no reply, `final` holds the harness's error. */
export type SessionEvent =
  | { type: 'start'; session: string; model: string; home: string }
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

/** Runs one harness session in the sandbox and streams what it does. The harness exiting ends it. */
export class Session extends Context.Tag('agentgraph/Session')<
  Session,
  { open: (spec: SessionSpec) => Stream.Stream<SessionEvent, SessionStop, Scope.Scope> }
>() {}
