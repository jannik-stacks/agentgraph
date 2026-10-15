import { Context, Data, Layer, type Scope, type Stream } from 'effect';
import type { Harness } from './hub.ts';
import type { Sandbox } from './sandbox.ts';
import { todoStream } from './todo.ts';
import type { Run } from './workflow.ts';

export type SessionSpec = {
  harness: Harness;
  model?: string;
  system: string;
  prompt: string;
  dir: string;
  tools: string[];
  resume?: Run['sessions'][string];
};

export type AgentEvent =
  | { type: 'start'; session: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; output?: string; ok?: boolean }
  | { type: 'usage'; input: number; output: number; usd?: number }
  | { type: 'end'; final: string };

export class SessionStop extends Data.TaggedError('SessionStop')<{
  reason: 'timeout' | 'stalled' | 'budget' | 'provider' | 'human' | 'sandbox';
  detail?: string;
}> {}

/** Runs one harness session in the sandbox and streams what it does. The harness exiting ends it. */
export class Session extends Context.Tag('bothub/Session')<
  Session,
  { open: (spec: SessionSpec) => Stream.Stream<AgentEvent, SessionStop, Scope.Scope> }
>() {}

/** The claude, opencode and pi adapters, picked by `spec.harness`. */
export const harnesses: Layer.Layer<Session, never, Sandbox> = Layer.succeed(Session, {
  open: () => todoStream('harnesses.open'),
});

/** Plays back one list of events per session opened, for tests. */
export const scripted = (_turns: AgentEvent[][]): Layer.Layer<Session> =>
  Layer.succeed(Session, { open: () => todoStream('scripted.open') });
