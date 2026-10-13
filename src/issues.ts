import { toEvent } from './github.ts';
import type { Proposal } from './outputs.ts';
import type { Association, IssueFile, IssuesBackend } from './schema.ts';
import type { BotEvent } from './types.ts';

export type Comment = { author: string; ts: string; body: string; url?: string };

/** An issue in either backend. Plans are labelled `plan` with their steps as sub-issues, specs `spec`, open questions `unsure`. */
export type Issue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  body: string;
  author?: string;
  parent?: number;
  links?: number[];
  changes?: NonNullable<IssueFile['changes']>;
  comments: Comment[];
  url?: string;
};

export type IssueFilter = { label?: string; state?: Issue['state'] | 'all'; parent?: number };

/**
 * Where issues live, behind one interface. `list` leaves out comments; `get` includes them. `watch` emits the same
 * `BotEvent`s a webhook would for changes after `ready` resolves, until `stop` is called; with `replay`, a backend that
 * can also emits what is already there while getting ready.
 */
export type Issues = {
  backend: IssuesBackend;
  list: (filter?: IssueFilter) => Promise<Issue[]>;
  get: (number: number) => Promise<Issue | undefined>;
  create: (
    issue: Pick<Issue, 'title'> & Partial<Pick<Issue, 'body' | 'labels' | 'parent' | 'links'>>
  ) => Promise<Issue>;
  comment: (number: number, body: string) => Promise<Comment>;
  label: (number: number, change: Omit<Extract<Proposal, { kind: 'label' }>, 'kind'>) => Promise<void>;
  close: (number: number) => Promise<void>;
  link: (parent: number, child: number) => Promise<void>;
  watch: (
    onEvent: (event: BotEvent) => void,
    options?: { interval?: number; replay?: boolean }
  ) => { ready: Promise<void>; stop: () => void };
};

/** Labels that give an issue its role. */
export const roles = { plan: 'plan', spec: 'spec', unsure: 'unsure' } as const;

export const matches = (issue: Issue, { label, state = 'open', parent }: IssueFilter = {}) =>
  (state === 'all' || issue.state === state) &&
  (label === undefined || issue.labels.includes(label)) &&
  (parent === undefined || issue.parent === parent);

type Change =
  | { kind: 'issues'; action: 'opened' | 'closed' | 'reopened'; issue: Issue; sender: string }
  | { kind: 'issues'; action: 'labeled'; issue: Issue; sender: string; label: string }
  | { kind: 'issue_comment'; issue: Issue; comment: Comment };

/** Turns an issue change into a `BotEvent` through the webhook normaliser, so both backends emit the same shape. */
export const changeEvent = (
  change: Change,
  {
    repo,
    id,
    association,
    source = 'github',
  }: { repo: string; id: string; association: (login: string) => Association; source?: BotEvent['source'] }
): BotEvent | undefined => {
  const { issue } = change;
  const author = issue.author ?? (change.kind === 'issues' ? change.sender : change.comment.author);
  const item = {
    number: issue.number,
    html_url: issue.url ?? `#${issue.number}`,
    body: issue.body,
    user: { login: author },
    author_association: association(author),
  };
  const repository = { full_name: repo };
  const payload =
    change.kind === 'issues'
      ? {
          action: change.action,
          repository,
          sender: { login: change.sender },
          issue: item,
          ...('label' in change && { label: { name: change.label } }),
        }
      : {
          action: 'created',
          repository,
          sender: { login: change.comment.author },
          issue: item,
          comment: {
            body: change.comment.body,
            html_url: change.comment.url ?? item.html_url,
            author_association: association(change.comment.author),
          },
        };
  const event = toEvent(change.kind, id, payload);
  return event && { ...event, source };
};
