import { Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcSerialization } from 'effect/rpc';
import { Event, Issue } from './event.ts';
import { Proposal } from './proposal.ts';
import { Run, RunRecord } from './types.ts';

export const ActionError = Schema.TaggedStruct('ActionError', { message: Schema.String });

export class ActionUser extends RpcMiddleware.Service<ActionUser>()('ActionUser', { error: ActionError }) {}

export const userHeader = 'x-agentgraph-user';

const Count = Schema.Int.check(Schema.isGreaterThan(0));
const error = ActionError;

export const Actions = RpcGroup.make(
  Rpc.make('show', {
    payload: { issue: Schema.optionalKey(Count) },
    success: Schema.Struct({
      issues: Schema.Array(
        Schema.Struct({
          ...Issue.fields,
          events: Schema.optionalKey(Schema.Array(Event)),
          diff: Schema.optionalKey(Schema.String),
        })
      ),
      runs: Schema.Array(Run),
      notes: Schema.Array(Schema.String),
    }),
    error,
  }),
  Rpc.make('say', { payload: { issue: Count, text: Schema.Trimmed.check(Schema.isNonEmpty()) }, error }),
  Rpc.make('label', {
    payload: { id: Schema.String, patch: Schema.Record(Schema.String, Schema.NullOr(Schema.String)) },
    success: Schema.Record(Schema.String, Schema.String),
    error,
  }),
  Rpc.make('instruct', {
    payload: Schema.Union([
      Schema.Struct({
        ...Proposal.members[10].fields,
        kind: Schema.Literal('dispatch'),
        text: Schema.optionalKey(Schema.String),
      }),
      Schema.Struct({
        kind: Schema.Literal('check'),
        checks: Schema.Array(Schema.String),
        workflow: Schema.optionalKey(Schema.String),
        issue: Schema.optionalKey(Count),
      }),
      Schema.Struct({ kind: Schema.Literal('resume'), id: Schema.String }),
      Schema.Struct({ kind: Schema.Literal('resume'), parked: Schema.Literal(true) }),
    ]),
    success: Schema.Array(RunRecord),
    error,
  })
).middleware(ActionUser);

export type Action = RpcGroup.Rpcs<typeof Actions>;

export const makeActionClient = (url: string, fetch?: typeof globalThis.fetch) =>
  RpcClient.make(Actions).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provide([
          fetch
            ? FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
            : FetchHttpClient.layer,
          RpcSerialization.layerNdjson,
        ])
      )
    )
  );
