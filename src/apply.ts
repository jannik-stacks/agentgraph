import { stringify } from 'yaml';
import type { GitHub } from './github-app.ts';
import { githubIssues } from './issues-github.ts';
import { roles, type Issues } from './issues.ts';
import type { Proposal } from './outputs.ts';
import type { BotEvent } from './types.ts';

export type ApplyResult = {
  kind: Proposal['kind'];
  status: 'applied' | 'skipped' | 'failed';
  url?: string;
  reason?: string;
};

type Outcome = Omit<ApplyResult, 'kind'>;
type Context = {
  event: BotEvent;
  issues?: Issues;
  gh?: GitHub;
  push: (proposal: Extract<Proposal, { kind: 'push' }>) => Promise<string>;
  hubPr?: (pr: { path: string; content: string; title: string; body: string }) => Promise<string>;
};
type Created = { html_url: string };

const tracker = ({ issues, gh, event }: Context) => {
  if (issues) return issues;
  if (gh) return githubIssues(gh, event.repo);
  throw new Error('no issue tracker to write to');
};

const target = ({ number }: BotEvent) => {
  if (number === undefined) throw new Error('the event has no issue or pull request to write to');
  return number;
};

const comment = async (ctx: Context, body: string): Promise<Outcome> => {
  const { url } = await tracker(ctx).comment(target(ctx.event), body);
  return { status: 'applied', ...(url && { url }) };
};

const label = async (ctx: Context, { kind: _, ...change }: Extract<Proposal, { kind: 'label' }>) => {
  await tracker(ctx).label(target(ctx.event), change);
  return { status: 'applied' } as const;
};

const title = (question: string) => {
  const line = question.trim().split('\n')[0] ?? question;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * Opens an `unsure` issue for the question, as a sub-issue of the triggering one, and points the actor at it. The
 * same open question asked again becomes a comment on the existing issue.
 */
const ask = async (ctx: Context, question: string): Promise<Outcome> => {
  const issues = tracker(ctx);
  const { number: parent, actor } = ctx.event;
  const open = await issues.list({ label: roles.unsure, ...(parent !== undefined && { parent }) });
  const same = open.find(issue => issue.title === title(question));
  if (same) {
    const { url } = await issues.comment(same.number, question);
    return { status: 'applied', ...(url && { url }) };
  }
  const created = await issues.create({
    title: title(question),
    body: question,
    labels: [roles.unsure],
    ...(parent !== undefined && { parent }),
  });
  if (parent !== undefined) await issues.comment(parent, `@${actor.login} needs a human: #${created.number}`);
  return { status: 'applied', ...(created.url && { url: created.url }) };
};

const openPr = async ({ event, gh }: Context, { kind: _, ...pr }: Extract<Proposal, { kind: 'open-pr' }>) => {
  if (!gh) return { status: 'skipped', reason: 'no GitHub client to open a pull request with' } as const;
  const base = pr.base ?? (await gh<{ default_branch: string }>('GET', `/repos/${event.repo}`)).default_branch;
  const { html_url } = await gh<Created>('POST', `/repos/${event.repo}/pulls`, { ...pr, base });
  return { status: 'applied', url: html_url } as const;
};

/** The hub-repo file a `note` proposal adds, as a proposed note. */
export const noteFile = ({ note, slug, title, body }: Extract<Proposal, { kind: 'note' }>) => ({
  path: `notes/${note}/${slug}.md`,
  content: `---\n${stringify({ title, status: 'proposed' })}---\n\n${body.trim()}\n`,
});

const note = async ({ event, hubPr }: Context, proposal: Extract<Proposal, { kind: 'note' }>): Promise<Outcome> => {
  if (!hubPr) return { status: 'skipped', reason: 'no hub repository to open a note pull request in' };
  const file = noteFile(proposal);
  const body = `Proposed ${proposal.note} note from ${event.url ?? event.repo}.`;
  return { status: 'applied', url: await hubPr({ ...file, title: `note: ${proposal.title}`, body }) };
};

const applyOne = async (proposal: Proposal, ctx: Context): Promise<Outcome> => {
  switch (proposal.kind) {
    case 'reply':
      return comment(ctx, proposal.body);
    case 'ask':
      return ask(ctx, proposal.question);
    case 'label':
      return label(ctx, proposal);
    case 'open-pr':
      return openPr(ctx, proposal);
    case 'push':
      return { status: 'applied', url: await ctx.push(proposal) };
    case 'note':
      return note(ctx, proposal);
  }
};

const pushesFirst = (proposals: Proposal[]) => [
  ...proposals.filter(p => p.kind === 'push'),
  ...proposals.filter(p => p.kind !== 'push'),
];

/**
 * Applies accepted proposals: pushes first, then the rest in order. Replies, labels and questions go through
 * `issues` (or GitHub's issues when only `gh` is given); pushes and pull requests stay on git and GitHub. A failure is
 * reported and does not stop the rest, but a pull request whose head failed to push is skipped.
 */
export const apply = async (accepted: Proposal[], ctx: Context): Promise<ApplyResult[]> => {
  const results: ApplyResult[] = [];
  const unpushed = new Set<string>();
  for (const proposal of pushesFirst(accepted)) {
    const outcome =
      proposal.kind === 'open-pr' && unpushed.has(proposal.head)
        ? { status: 'skipped' as const, reason: `pushing ${proposal.head} failed` }
        : await applyOne(proposal, ctx).catch((e: Error): Outcome => ({ status: 'failed', reason: e.message }));
    if (proposal.kind === 'push' && outcome.status === 'failed') unpushed.add(proposal.branch);
    results.push({ kind: proposal.kind, ...outcome });
  }
  return results;
};
