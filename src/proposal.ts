import { Schema } from 'effect';

const Text = Schema.optionalWith(Schema.String, { exact: true });
const Names = Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { exact: true });

const Comment = Schema.Struct({ kind: Schema.Literal('comment'), body: Schema.String, edit: Text, under: Text });
const React = Schema.Struct({
  kind: Schema.Literal('react'),
  comment: Text,
  review: Schema.optionalWith(Schema.Boolean, { exact: true }),
  remove: Text,
});
const Label = Schema.Struct({ kind: Schema.Literal('label'), add: Names, remove: Names });
const Push = Schema.Struct({
  kind: Schema.Literal('push'),
  branch: Schema.String,
  message: Schema.String,
  onto: Text,
  merge: Schema.optionalWith(Schema.Literal(true), { exact: true }),
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
  title: Schema.String,
  body: Schema.String,
  parent: Schema.optionalWith(Schema.Int, { exact: true }),
  labels: Names,
});
const Ask = Schema.Struct({ kind: Schema.Literal('ask'), question: Schema.String });
const Back = Schema.Struct({ kind: Schema.Literal('back'), why: Schema.String });
const Run = Schema.Struct({
  kind: Schema.Literal('run'),
  workflow: Schema.String,
  issue: Schema.Int,
  step: Text,
});
const Tell = Schema.Struct({ kind: Schema.Literal('tell'), issue: Schema.Int, text: Schema.String });

/**
 * What a run may change on the repo, and the three proposals that steer the run. `react` and `rebase` are the runner's
 * own; a rebase moves the commits on `branch` after `from` onto `onto`, or replays `head` in the checkout only.
 * A react with `remove` takes back the reaction of that id. A push with `onto` lands the files as one commit on `onto` and replaces the branch, or with
 * `merge` as a merge of `onto` into it; either refuses when the branch moved past the commit the checkout started from. An issue with a `parent` is filed as its sub-issue.
 */
export const Proposal = Schema.Union(
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
  Tell
);
export type Proposal = typeof Proposal.Type;

const { kind, title, body } = Filed.fields;

/**
 * A proposal as an agent writes it. An issue is a `part` of the run's issue, a `follow-up` found while working on it,
 * or a `hub` change to the bot's own workflows, agents or checks. A part's `stacks_on` and `depends_on` name earlier
 * issues in the same block by position, from 1.
 */
export const Said = Schema.Union(
  Comment.omit('edit'),
  Label,
  Push.omit('onto', 'merge'),
  PullRequest,
  Merge,
  Schema.Struct({
    kind,
    relation: Schema.Literal('part'),
    title,
    body,
    size: Schema.Literal('XS', 'S', 'M', 'L', 'XL'),
    priority: Schema.Literal('high', 'medium', 'low'),
    stacks_on: Schema.optionalWith(Schema.Int, { exact: true }),
    depends_on: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.Int)), { exact: true }),
  }),
  Schema.Struct({ kind, relation: Schema.Literal('follow-up', 'hub'), title, body }),
  Ask,
  Back,
  Run,
  Tell
);
export type Said = typeof Said.Type;

/** The kinds an agent may return. */
export const Kind = Schema.Literal(...new Set(Said.members.map(m => m.fields.kind.literals[0])));
