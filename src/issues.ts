import type { Proposal } from './outputs.ts';
import type { IssueFile, IssuesBackend } from './schema.ts';

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
  human?: IssueFile['human'];
  comments: Comment[];
  url?: string;
};

export type IssueFilter = { label?: string; state?: Issue['state'] | 'all'; parent?: number };

/** Where issues live, behind one interface. `list` leaves out comments; `get` includes them. */
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
};

/** Labels that give an issue its role. */
export const roles = { plan: 'plan', spec: 'spec', unsure: 'unsure' } as const;

export const matches = (issue: Issue, { label, state = 'open', parent }: IssueFilter = {}) =>
  (state === 'all' || issue.state === state) &&
  (label === undefined || issue.labels.includes(label)) &&
  (parent === undefined || issue.parent === parent);
