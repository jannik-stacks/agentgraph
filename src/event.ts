import { Schema, type Types } from 'effect';
import type { Proposal } from './proposal.ts';

export const Count = Schema.Int.check(Schema.isGreaterThan(0));

export const issueStatuses = ['working', 'needs-review', 'needs-answer', 'done', 'stopped'] as const;
export type IssueStatus = (typeof issueStatuses)[number];

const Text = Schema.optionalKey(Schema.String);

/**
 * An issue or a pull request, as GitHub returns it. `pull` is set on pull requests. `stacksOn` is the issue or pull
 * request its work builds on, `dependsOn` the issues that must close before it starts, and `withheld` marks an
 * outsider's issue whose title and text are replaced.
 */
export const Issue = Schema.Struct({
  number: Count,
  title: Schema.String,
  body: Schema.String,
  state: Schema.Literals(['open', 'closed', 'merged']),
  labels: Schema.mutable(Schema.Array(Schema.String)),
  milestone: Text,
  author: Schema.String,
  parent: Schema.optionalKey(Count),
  withheld: Schema.optionalKey(Schema.Literal(true)),
  stacksOn: Schema.optionalKey(Count),
  dependsOn: Schema.optionalKey(Schema.mutable(Schema.Array(Count))),
  pull: Schema.optionalKey(
    Schema.Struct({ branch: Schema.String, base: Schema.String, head: Schema.String, baseSha: Text })
  ),
  url: Schema.String,
});
export type Issue = Types.Mutable<typeof Issue.Type>;

/**
 * A comment; `path` and `line` place a review comment, `under` is the review comment it answers. `agentRequest` is what
 * it asks the bot when it calls it with `/agent`: the command after `/agent:`, and the rest of its text.
 */
export const Comment = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
  at: Schema.String,
  edited: Text,
  agentRequest: Schema.optionalKey(Schema.Struct({ command: Text, text: Schema.String })),
  path: Text,
  line: Schema.optionalKey(Count),
  under: Text,
});
export type Comment = Types.Mutable<typeof Comment.Type>;

/**
 * Something a person or a bot said or did on an issue. `id` names it in its tracker and stays the same on every read;
 * `review` marks a review that only commented, and `reviewer` whom a review was asked of.
 */
export const Event = Schema.Struct({
  source: Schema.optionalKey(Schema.Literal('cli')),
  id: Schema.String,
  issue: Count,
  kind: Schema.Literals([
    'comment',
    'approved',
    'changes_requested',
    'review_requested',
    'merged',
    'closed',
    'label',
    'unlabel',
    'column',
    'commit',
    'check',
  ]),
  actor: Schema.String,
  bot: Schema.Boolean,
  trusted: Schema.Boolean,
  at: Schema.String,
  comment: Schema.optionalKey(Comment),
  review: Schema.optionalKey(Schema.Literal(true)),
  reviewer: Text,
  label: Text,
  column: Schema.optionalKey(Schema.Struct({ project: Schema.String, name: Schema.String })),
  commit: Schema.optionalKey(Schema.Struct({ sha: Schema.String, title: Schema.String })),
  check: Schema.optionalKey(Schema.Struct({ name: Schema.String, conclusion: Schema.String })),
});
export type Event = Types.Mutable<typeof Event.Type>;

/**
 * How a proposal landed; `id` is the comment a reply posted or edited, the number of an issue opened, or the reaction
 * given. `at` is when its body was stamped with the run it came from. `moved` marks a push or rebase refused because
 * its branch is no longer where the checkout builds on.
 */
export type Applied = {
  operation?: string;
  issue?: number;
  proposal: Proposal;
  ok: boolean;
  url?: string;
  held?: string[];
  id?: string;
  reason?: string;
  moved?: true;
  at?: string;
};

/** The run, step and session a write to the tracker comes from, and the operation that names one write. */
export type RunLink = { run: string; step: string; session?: string; operation?: string };

/** The studio page of a run. */
export const makeStudioRunUrl = (studio: string, run: string) =>
  `${studio.replace(/\/+$/, '')}/runs/${encodeURIComponent(run)}`;

export const formatRunMark = (text: string, url?: string) => {
  const mark = url ? `[⁂](${url.replaceAll('(', '%28').replaceAll(')', '%29')})` : '⁂';
  const trimmed = text.trimEnd();
  const last = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
  return !trimmed ? mark : /^\s*(?:```|~~~|\||<)/.test(last) ? `${trimmed}\n\n${mark}` : `${trimmed} ${mark}`;
};

const statusSection = /<!-- agentgraph status -->\n?([\s\S]*?)\n?(?:<!-- end agentgraph status -->|$)\s*/;

export const getStatusHeader = (body: string) => statusSection.exec(body)?.[1] ?? '';

export const makeBodyWithStatus = (body: string, header: string) => {
  const text = body.replace(statusSection, '').trimStart();
  return [header && `<!-- agentgraph status -->\n${header}\n<!-- end agentgraph status -->`, text]
    .filter(Boolean)
    .join('\n\n');
};

export const removeRunLink = (body: string) =>
  body
    .replace(statusSection, '')
    .replace(/<!--\s*agentgraph\b[\s\S]*?(?:-->|$)|[ \t]*\[⁂\]\([^)]*\)/g, '')
    .replace(/<details><summary>(?:<a href="[^"]*">⁂<\/a>|⁂)<\/summary>\s*<\/details>/g, '')
    .replace(/\s*⁂\s*$/, '')
    .trimEnd();
