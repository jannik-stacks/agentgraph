import { Schema, Struct } from 'effect';

const Text = Schema.optionalKey(Schema.String);
const Names = Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)));

const Comment = Schema.Struct({ kind: Schema.Literal('comment'), body: Schema.String, under: Text });
const React = Schema.Struct({
  kind: Schema.Literal('react'),
  comment: Text,
  review: Schema.optionalKey(Schema.Boolean),
});
const Label = Schema.Struct({ kind: Schema.Literal('label'), add: Names, remove: Names });
const Push = Schema.Struct({
  kind: Schema.Literal('push'),
  branch: Schema.String,
  message: Schema.String,
  onto: Text,
  merge: Schema.optionalKey(Schema.Literal(true)),
});
const Rebase = Schema.Struct({
  kind: Schema.Literal('rebase'),
  branch: Schema.String,
  from: Schema.String,
  onto: Schema.String,
  head: Text,
});
const PullRequest = Schema.Struct({
  kind: Schema.Literal('pull_request'),
  branch: Schema.String,
  base: Schema.String,
  title: Schema.String,
  body: Schema.String,
});
const Merge = Schema.Struct({ kind: Schema.Literal('merge'), number: Schema.Int, head: Schema.String });
const Filed = Schema.Struct({
  kind: Schema.Literal('issue'),
  milestone: Text,
  title: Schema.String,
  body: Schema.String,
  parent: Schema.optionalKey(Schema.Int),
  labels: Names,
});
const Ask = Schema.Struct({ kind: Schema.Literal('ask'), question: Schema.String });
const Stuck = Schema.Struct({ kind: Schema.Literal('ask'), runner: Schema.String });
const Back = Schema.Struct({ kind: Schema.Literal('back'), why: Schema.String });
const Run = Schema.Struct({
  kind: Schema.Literal('run'),
  workflow: Schema.String,
  issue: Schema.Int,
  step: Text,
});
const Tell = Schema.Struct({ kind: Schema.Literal('tell'), issue: Schema.Int, text: Schema.String });

export const Proposal = Schema.Union([
  Comment,
  React,
  Label,
  Push,
  Rebase,
  PullRequest,
  Merge,
  Filed,
  Ask,
  Back,
  Run,
  Tell,
]);
export type Proposal = typeof Proposal.Type;

const { kind, title, body } = Filed.fields;

export const Said = Schema.Union([
  Comment,
  Label,
  Push.mapFields(Struct.omit(['onto', 'merge'])),
  PullRequest,
  Merge,
  Schema.Struct({
    kind,
    relation: Schema.Literal('part'),
    title,
    body,
    size: Schema.Literals(['XS', 'S', 'M', 'L', 'XL']),
    stacks_on: Schema.optionalKey(Schema.Int),
    depends_on: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Int))),
  }),
  Schema.Struct({ kind, relation: Schema.Literals(['follow-up', 'graph']), title, body }),
  Ask,
  Stuck,
  Back,
  Run,
  Tell,
]);
export type Said = typeof Said.Type;

export const Kind = Schema.Literals([...new Set(Said.members.map(m => m.fields.kind.literal))]);
