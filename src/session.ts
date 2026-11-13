import { Context, type Stream, type Scope } from 'effect';
import { type SessionEvent, type SessionSpec, type SessionStop } from './types.ts';

export class Session extends Context.Service<
  Session,
  { open: (spec: SessionSpec) => Stream.Stream<SessionEvent, SessionStop, Scope.Scope> }
>()('agentgraph/Session') {}
