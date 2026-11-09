import { Context, type Stream, type Scope } from 'effect';
import { type SessionEvent, type SessionSpec, type SessionStop } from './types.ts';

/** Runs one harness session in the sandbox and streams what it does. The harness exiting ends it. */
export class Session extends Context.Service<
  Session,
  { open: (spec: SessionSpec) => Stream.Stream<SessionEvent, SessionStop, Scope.Scope> }
>()('agentgraph/Session') {}
