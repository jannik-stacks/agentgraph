import type { Proposal } from './proposal.ts';

/** An issue or a pull request, as GitHub returns it. `pull` is set on pull requests. */
export type Issue = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  milestone?: string;
  author: string;
  parent?: number;
  pull?: { branch: string; base: string; head: string; baseSha?: string };
  url: string;
};

/**
 * A comment; `path` and `line` place a review comment, `under` is the review comment it answers. `agentRequest` is what
 * it asks the bot: its text without the `/agent` that calls the bot, when it has one.
 */
export type Comment = {
  id: string;
  author: string;
  body: string;
  at: string;
  agentRequest?: string;
  path?: string;
  line?: number;
  under?: string;
};

/** Something a person or a bot said or did on an issue. */
export type Event = {
  source?: 'cli';
  issue: number;
  kind: 'comment' | 'approved' | 'changes_requested' | 'merged' | 'closed' | 'label' | 'unlabel' | 'commit' | 'check';
  actor: string;
  trusted: boolean;
  at: string;
  comment?: Comment;
  label?: string;
  commit?: { sha: string; title: string };
  check?: { name: string; conclusion: string };
};

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
  id?: string;
  reason?: string;
  moved?: true;
  at?: string;
};

/** The run, step and session a write to the forge comes from, and the operation that names one write. */
export type RunLink = { run: string; step: string; session?: string; operation?: string };

/** The studio page of a run. */
export const makeStudioRunUrl = (studio: string, run: string) =>
  `${studio.replace(/\/+$/, '')}/runs/${encodeURIComponent(run)}`;

/** The body without any provenance marker or ⁂ link in it. */
export const removeRunLink = (body: string) =>
  body.replace(/<!--\s*agentgraph\b[\s\S]*?(?:-->|$)|\[⁂\]\([^)]*\)/g, '').trimEnd();
