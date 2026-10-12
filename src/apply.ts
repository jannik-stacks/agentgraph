import { stringify } from 'yaml';
import type { GitHub } from './github-app.ts';
import { githubIssues } from './issues-github.ts';
import { roles, type Issues } from './issues.ts';
import type { Proposal } from './outputs.ts';
import type { BotEvent } from './types.ts';

/**
 * One effect of an accepted proposal. `key` is the same for the same event, job and proposal, so a retry finds what an
 * earlier run already did; `pending` means it was planned and is not yet known to have landed. A push records the
 * commit it pushed as `sha`.
 */
export type ApplyResult = {
  kind: Proposal['kind'];
  key?: string;
  status: 'pending' | 'applied' | 'skipped' | 'failed';
  url?: string;
  sha?: string;
  reason?: string;
};

type Outcome = Omit<ApplyResult, 'kind' | 'key'>;
type Push = Extract<Proposal, { kind: 'push' }>;
type Context = {
  event: BotEvent;
  issues?: Issues;
  gh?: GitHub;
  push: (
    proposal: Push,
    journal: { expected?: string; committed: (sha: string) => Promise<unknown> }
  ) => Promise<string>;
  hubPr?: (pr: { path: string; content: string; title: string; body: string }) => Promise<string>;
  /** Keys are `<prefix>/<kind>-<n>`; the event id by default. */
  prefix?: string;
  /** Effects recorded by earlier runs of the same event and job. */
  prior?: ApplyResult[];
  /** Persists the journal: once before anything is applied, then after every effect. */
  record?: (results: ApplyResult[]) => Promise<unknown>;
};
type Created = { html_url: string };

/** The hidden marker a written comment or issue carries, so applying it again finds it. */
export const marker = (key: string) => `<!-- bothub:${key} -->`;

const marked = (body: string, key: string) => `${body}\n\n${marker(key)}`;

const tracker = ({ issues, gh, event }: Context) => {
  if (issues) return issues;
  if (gh) return githubIssues(gh, event.repo);
  throw new Error('no issue tracker to write to');
};

const target = ({ number }: BotEvent) => {
  if (number === undefined) throw new Error('the event has no issue or pull request to write to');
  return number;
};

const found = (url: string | undefined, reason: string): Outcome => ({
  status: 'applied',
  ...(url && { url }),
  reason,
});

const comment = async (ctx: Context, body: string, key: string): Promise<Outcome> => {
  const issues = tracker(ctx);
  const number = target(ctx.event);
  const posted = (await issues.get(number))?.comments.find(c => c.body.includes(marker(key)));
  if (posted) return found(posted.url, 'already posted');
  const { url } = await issues.comment(number, marked(body, key));
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
 * same open question asked again becomes a comment on the existing issue. A question already asked under the same key
 * is not asked again.
 */
const ask = async (ctx: Context, question: string, key: string): Promise<Outcome> => {
  const issues = tracker(ctx);
  const { number: parent, actor } = ctx.event;
  const asked = await issues.list({ label: roles.unsure, state: 'all', ...(parent !== undefined && { parent }) });
  const earlier = asked.find(issue => issue.body.includes(marker(key)));
  if (earlier) return found(earlier.url, 'already asked');
  const same = asked.find(issue => issue.state === 'open' && issue.title === title(question));
  if (same) {
    const posted = (await issues.get(same.number))?.comments.find(c => c.body.includes(marker(key)));
    if (posted) return found(posted.url, 'already asked');
    const { url } = await issues.comment(same.number, marked(question, key));
    return { status: 'applied', ...(url && { url }) };
  }
  const created = await issues.create({
    title: title(question),
    body: marked(question, key),
    labels: [roles.unsure],
    ...(parent !== undefined && { parent }),
  });
  if (parent !== undefined) await issues.comment(parent, `@${actor.login} needs a human: #${created.number}`);
  return { status: 'applied', ...(created.url && { url: created.url }) };
};

/** Opens the pull request, or finds the one already open for its head. */
const openPr = async ({ event, gh }: Context, { kind: _, ...pr }: Extract<Proposal, { kind: 'open-pr' }>) => {
  if (!gh) return { status: 'skipped', reason: 'no GitHub client to open a pull request with' } as const;
  const head = encodeURIComponent(`${event.repo.split('/')[0]}:${pr.head}`);
  const open = await gh<Created[]>('GET', `/repos/${event.repo}/pulls?head=${head}&state=open`);
  const existing = Array.isArray(open) ? open[0] : undefined;
  if (existing) return found(existing.html_url, 'already open');
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

type Journal = { key: string; earlier: ApplyResult | undefined; committed: (sha: string) => Promise<unknown> };

const push = async (ctx: Context, proposal: Push, { earlier, committed }: Journal): Promise<Outcome> => {
  let sha: string | undefined;
  const url = await ctx.push(proposal, {
    ...(earlier?.sha && { expected: earlier.sha }),
    committed: commit => committed((sha = commit)),
  });
  return { status: 'applied', url, ...(sha && { sha }) };
};

const applyOne = async (proposal: Proposal, journal: Journal, ctx: Context): Promise<Outcome> => {
  const { key } = journal;
  switch (proposal.kind) {
    case 'reply':
      return comment(ctx, proposal.body, key);
    case 'ask':
      return ask(ctx, proposal.question, key);
    case 'label':
      return label(ctx, proposal);
    case 'open-pr':
      return openPr(ctx, proposal);
    case 'push':
      return push(ctx, proposal, journal);
    case 'note':
      return note(ctx, proposal);
    case 'close':
      return { status: 'skipped', reason: 'a closure is not a write' };
  }
};

/** Accepted proposals with their keys, pushes first. */
const effects = (accepted: Proposal[], prefix: string) => {
  const counts = new Map<Proposal['kind'], number>();
  const keyed = accepted.map(proposal => {
    const n = (counts.get(proposal.kind) ?? 0) + 1;
    counts.set(proposal.kind, n);
    return { proposal, key: `${prefix}/${proposal.kind}-${n}` };
  });
  return [...keyed.filter(e => e.proposal.kind === 'push'), ...keyed.filter(e => e.proposal.kind !== 'push')];
};

/**
 * Applies accepted proposals: pushes first, then the rest in order. Replies, labels and questions go through
 * `issues` (or GitHub's issues when only `gh` is given); pushes and pull requests stay on git and GitHub. The planned
 * effects are recorded as `pending` before the first one is applied, and each is recorded as it lands. An effect an
 * earlier run recorded as applied is not repeated; one it left pending is checked against what is already there. A
 * failure is reported and does not stop the rest, but a pull request whose head failed to push is skipped.
 */
export const apply = async (accepted: Proposal[], ctx: Context): Promise<ApplyResult[]> => {
  const planned = effects(accepted, ctx.prefix ?? ctx.event.id);
  const results: ApplyResult[] = planned.map(({ proposal, key }) => ({ kind: proposal.kind, key, status: 'pending' }));
  await ctx.record?.(results);
  const unpushed = new Set<string>();
  for (const [i, { proposal, key }] of planned.entries()) {
    const earlier = ctx.prior?.find(result => result.key === key);
    const committed = (sha: string) => {
      results[i] = { kind: proposal.kind, key, status: 'pending', sha };
      return ctx.record?.(results) ?? Promise.resolve();
    };
    const outcome: Outcome =
      earlier?.status === 'applied'
        ? {
            status: 'applied',
            ...(earlier.url && { url: earlier.url }),
            ...(earlier.sha && { sha: earlier.sha }),
            reason: 'applied by an earlier run',
          }
        : proposal.kind === 'open-pr' && unpushed.has(proposal.head)
          ? { status: 'skipped', reason: `pushing ${proposal.head} failed` }
          : await applyOne(proposal, { key, earlier, committed }, ctx).catch((e: Error): Outcome => ({
              status: 'failed',
              reason: e.message,
            }));
    if (proposal.kind === 'push' && outcome.status === 'failed') unpushed.add(proposal.branch);
    results[i] = { kind: proposal.kind, key, ...outcome };
    await ctx.record?.(results);
  }
  return results;
};
