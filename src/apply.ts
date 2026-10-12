import { stringify } from 'yaml';
import type { GitHub, GitHubError } from './github-app.ts';
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
  gh: GitHub;
  push: (proposal: Extract<Proposal, { kind: 'push' }>) => Promise<string>;
  hubPr?: (pr: { path: string; content: string; title: string; body: string }) => Promise<string>;
};
type Created = { html_url: string };

const issuePath = ({ repo, number }: BotEvent) => {
  if (number === undefined) throw new Error('the event has no issue or pull request to write to');
  return `/repos/${repo}/issues/${number}`;
};

const comment = async ({ event, gh }: Context, body: string): Promise<Outcome> => {
  const { html_url } = await gh<Created>('POST', `${issuePath(event)}/comments`, { body });
  return { status: 'applied', url: html_url };
};

const label = async ({ event, gh }: Context, { add = [], remove = [] }: Extract<Proposal, { kind: 'label' }>) => {
  const path = issuePath(event);
  if (add.length) await gh('POST', `${path}/labels`, { labels: add });
  for (const name of remove)
    await gh('DELETE', `${path}/labels/${encodeURIComponent(name)}`).catch((e: GitHubError) => {
      if (e.status !== 404) throw e;
    });
  return { status: 'applied' } as const;
};

const openPr = async ({ event, gh }: Context, { kind: _, ...pr }: Extract<Proposal, { kind: 'open-pr' }>) => {
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
      return comment(ctx, `@${ctx.event.actor.login} ${proposal.question}`);
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
 * Applies accepted proposals as the GitHub App: pushes first, then the rest in order. A failure is reported and
 * does not stop the rest, but a pull request whose head failed to push is skipped.
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
