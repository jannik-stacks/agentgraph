import { Context, type Stream, type Scope } from 'effect';
import type { SessionEvent, SessionSpec, SessionStop } from './trace.ts';

/** Runs one harness session in the sandbox and streams what it does. The harness exiting ends it. */
export class Session extends Context.Tag('agentgraph/Session')<
  Session,
  { open: (spec: SessionSpec) => Stream.Stream<SessionEvent, SessionStop, Scope.Scope> }
>() {}
