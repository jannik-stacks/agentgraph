import { Context, Data, Layer, type Scope, type Stream } from 'effect';
import type { Harness } from './hub.ts';
import { todoStream } from './todo.ts';
import type { Run } from './workflow.ts';

export type SessionSpec = {
  harness: Harness;
  model?: string;
  system: string;
  prompt: string;
  dir: string;
  tools: string[];
  bot: string;
  minutes: number;
  resume?: Run['sessions'][string];
};

/** What a session does, as the harness reports it. `end` comes once the harness exits; with `ended: 'error'` and no reply, `final` holds the harness's error. */
export type AgentEvent =
  | { type: 'start'; session: string; model: string; home: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; output?: string; ok?: boolean; exit?: number; denied?: true }
  | { type: 'usage'; input: number; output: number; usd?: number }
  | { type: 'end'; final: string; ended: 'stop' | 'cap' | 'error'; exit: number };

export class SessionStop extends Data.TaggedError('SessionStop')<{
  reason: 'timeout' | 'stalled' | 'budget' | 'provider' | 'human' | 'sandbox';
  detail?: string;
}> {}

/** Runs one harness session in the sandbox and streams what it does. The harness exiting ends it. */
export class Session extends Context.Tag('bothub/Session')<
  Session,
  { open: (spec: SessionSpec) => Stream.Stream<AgentEvent, SessionStop, Scope.Scope> }
>() {}

/** Plays back one list of events per session opened, for tests. */
export const scripted = (_turns: AgentEvent[][]): Layer.Layer<Session> =>
  Layer.succeed(Session, { open: () => todoStream('scripted.open') });
