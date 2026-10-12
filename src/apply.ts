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
type Context = { event: BotEvent; gh: GitHub };
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

const applyOne = async (proposal: Proposal, ctx: Context): Promise<Outcome> => {
  switch (proposal.kind) {
    case 'reply':
      return comment(ctx, proposal.body);
    case 'ask-human':
      return comment(ctx, `@${ctx.event.actor.login} ${proposal.question}`);
    case 'label':
      return label(ctx, proposal);
    case 'open-pr':
      return openPr(ctx, proposal);
    case 'push-branch':
      return { status: 'skipped', reason: `the runner pushes ${proposal.branch}` };
    case 'propose-rule':
      return { status: 'skipped', reason: `opening a rule pull request for ${proposal.path} is not supported yet` };
  }
};

/** Applies accepted proposals as the GitHub App, in order. A failure is reported and does not stop the rest. */
export const apply = async (accepted: Proposal[], ctx: Context): Promise<ApplyResult[]> => {
  const results: ApplyResult[] = [];
  for (const proposal of accepted) {
    const outcome = await applyOne(proposal, ctx).catch((e: Error): Outcome => ({
      status: 'failed',
      reason: e.message,
    }));
    results.push({ kind: proposal.kind, ...outcome });
  }
  return results;
};
