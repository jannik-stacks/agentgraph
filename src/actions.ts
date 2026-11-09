import { Effect, Layer, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcSerialization } from 'effect/rpc';
import { Event, Issue } from './event.ts';
import { Proposal } from './proposal.ts';
import { Run, RunRecord, Verdict } from './types.ts';

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
  Rpc.make('log', { payload: { hash: Schema.String }, success: Schema.String, error }),
  Rpc.make('runs', { payload: { id: Schema.optionalKey(Schema.String) }, success: Schema.Unknown, error }),
  Rpc.make('results', { success: Schema.Unknown, error }),
  Rpc.make('watch', {
    payload: { issue: Schema.optionalKey(Count) },
    success: Schema.Array(RunRecord),
    stream: true,
    error,
  }),
  Rpc.make('verdicts', {
    payload: { workflow: Schema.String, step: Schema.String, check: Schema.String },
    success: Schema.Array(Verdict),
    error,
  }),
  Rpc.make('say', { payload: { issue: Count, text: Schema.Trimmed.check(Schema.isNonEmpty()) }, error }),
  Rpc.make('label', {
    payload: { id: Schema.String, patch: Schema.Record(Schema.String, Schema.NullOr(Schema.String)) },
    success: Schema.Record(Schema.String, Schema.String),
    error,
  }),
  Rpc.make('review', {
    payload: { issue: Count, verdict: Schema.Literals(['approved', 'changes_requested']), text: Schema.String },
    error,
  }),
  Rpc.make('merge', {
    payload: { issue: Count },
    success: Schema.Struct({ base: Schema.String, head: Schema.String }),
    error,
  }),
  Rpc.make('export', {
    payload: { issue: Count, as: Schema.optionalKey(Schema.String), patch: Schema.optionalKey(Schema.String) },
    success: Schema.NullOr(
      Schema.Union([
        Schema.Struct({ ref: Schema.String, base: Schema.String, stat: Schema.String }),
        Schema.Struct({ why: Schema.String }),
      ])
    ),
    error,
  }),
  Rpc.make('prune', {
    payload: { apply: Schema.Boolean },
    success: Schema.Struct({ files: Schema.Number, bytes: Schema.Number }),
    error,
  }),
  Rpc.make('close', { payload: { issue: Count }, success: Schema.Array(Schema.Number), error }),
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

export const makeActionClient = (href: string, fetch: typeof globalThis.fetch) => {
  const url = new URL(href);
  return RpcClient.make(Actions).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({
        url: url.origin + url.pathname,
        transformClient: HttpClient.mapRequest(HttpClientRequest.setUrlParams(url.searchParams)),
      }).pipe(
        Layer.provide([
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          RpcSerialization.layerNdjson,
        ])
      )
    )
  );
};
