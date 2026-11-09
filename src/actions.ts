import { Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { Rpc, RpcClient, type RpcClientError, RpcGroup, RpcMiddleware, RpcSerialization } from 'effect/rpc';
import { Event, Issue } from './event.ts';
import { Proposal } from './proposal.ts';
import { Count, Run, RunRecord, Verdict } from './types.ts';

export const ActionError = Schema.TaggedStruct('ActionError', { message: Schema.String });

export class ActionUser extends RpcMiddleware.Service<ActionUser>()('ActionUser', { error: ActionError }) {}

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
    error: ActionError,
  }),
  Rpc.make('log', { payload: { hash: Schema.String }, success: Schema.NullOr(Schema.String), error: ActionError }),
  Rpc.make('runs', { payload: { id: Schema.optionalKey(Schema.String) }, success: Schema.Unknown, error: ActionError }),
  Rpc.make('results', { success: Schema.Unknown, error: ActionError }),
  Rpc.make('watch', {
    payload: { issue: Schema.optionalKey(Count) },
    success: Schema.Array(RunRecord),
    stream: true,
    error: ActionError,
  }),
  Rpc.make('verdicts', {
    payload: { workflow: Schema.String, step: Schema.String, check: Schema.String },
    success: Schema.Array(Verdict),
    error: ActionError,
  }),
  Rpc.make('say', { payload: { issue: Count, text: Schema.Trimmed.check(Schema.isNonEmpty()) }, error: ActionError }),
  Rpc.make('label', {
    payload: { id: Schema.String, patch: Schema.Record(Schema.String, Schema.NullOr(Schema.String)) },
    success: Schema.Record(Schema.String, Schema.String),
    error: ActionError,
  }),
  Rpc.make('review', {
    payload: { issue: Count, verdict: Schema.Literals(['approved', 'changes_requested']), text: Schema.String },
    error: ActionError,
  }),
  Rpc.make('merge', {
    payload: { issue: Count },
    success: Schema.Struct({ base: Schema.String, head: Schema.String }),
    error: ActionError,
  }),
  Rpc.make('export', {
    payload: { issue: Count, as: Schema.optionalKey(Schema.String), patch: Schema.optionalKey(Schema.String) },
    success: Schema.NullOr(
      Schema.Union([
        Schema.Struct({ ref: Schema.String, base: Schema.String, stat: Schema.String }),
        Schema.Struct({ why: Schema.String }),
      ])
    ),
    error: ActionError,
  }),
  Rpc.make('prune', {
    payload: { apply: Schema.Boolean },
    success: Schema.Struct({ files: Schema.Number, bytes: Schema.Number }),
    error: ActionError,
  }),
  Rpc.make('close', { payload: { issue: Count }, success: Schema.Array(Schema.Number), error: ActionError }),
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
    error: ActionError,
  })
).middleware(ActionUser);

export const runActions = <A, E>(
  href: string,
  fetch: typeof globalThis.fetch,
  use: (actions: RpcClient.FromGroup<typeof Actions, RpcClientError.RpcClientError>) => Effect.Effect<A, E>
) => {
  const url = new URL(href);
  const protocol = RpcClient.layerProtocolHttp({
    url: url.origin + url.pathname,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setUrlParams(url.searchParams)),
  }).pipe(
    Layer.provide([
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      RpcSerialization.layerNdjson,
    ])
  );
  return Effect.scoped(Effect.flatMap(RpcClient.make(Actions).pipe(Effect.provide(protocol)), use));
};
