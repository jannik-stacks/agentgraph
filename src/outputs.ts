import { z } from 'zod';
import { Closure, NoteKind, type Job, type Mode, type ProposalKind } from './schema.ts';

const text = z.string().min(1);

/**
 * A write an agent asks the hub to make on its behalf. `close` is not a write: it states that the job stopped short
 * of done, and why.
 */
export const Proposal = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reply'), body: text }),
  z.strictObject({ kind: z.literal('label'), add: z.array(text).optional(), remove: z.array(text).optional() }),
  z.strictObject({ kind: z.literal('push'), branch: text, files: z.array(text).optional() }),
  z.strictObject({
    kind: z.literal('open-pr'),
    title: text,
    body: z.string(),
    head: text,
    base: text.optional(),
    draft: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('note'),
    note: NoteKind,
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    title: text,
    body: text,
  }),
  z.strictObject({ kind: z.literal('ask'), question: text }),
  z.strictObject({ kind: z.literal('close'), as: Closure.extract(['blocked', 'deferred', 'no-op']), reason: text }),
]);
export type Proposal = z.infer<typeof Proposal>;

export type Rejection = { proposal: Proposal; reason: string };
export type Validated = { accepted: Proposal[]; rejected: Rejection[]; apply: boolean };

const block = /^(`{3,}|~{3,})[ \t]*bothub[ \t]*\r?\n([\s\S]*?)^\1[ \t]*$/gm;

/** Reads proposals from the last fenced `bothub` block of an agent's final message: a JSON array or JSON Lines. */
export const extractProposals = (message: string): { proposals: Proposal[]; errors: string[] } => {
  const source = [...message.matchAll(block)].at(-1)?.[2]?.trim();
  if (!source) return { proposals: [], errors: [] };
  const errors: string[] = [];
  const proposals: Proposal[] = [];
  parseItems(source, errors).forEach((item, i) => {
    const parsed = Proposal.safeParse(item);
    if (parsed.success) proposals.push(parsed.data);
    else errors.push(`proposal ${i + 1}: ${z.prettifyError(parsed.error)}`);
  });
  return { proposals, errors };
};

const parseItems = (source: string, errors: string[]): unknown[] => {
  if (source.startsWith('[')) {
    try {
      const items: unknown = JSON.parse(source);
      if (Array.isArray(items)) return items;
    } catch (e) {
      errors.push(`invalid JSON: ${(e as Error).message}`);
      return [];
    }
  }
  return source.split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      return [];
    }
  });
};

const globTokens: Record<string, string> = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*' };

/** Matches a repository path against a glob where `*` stays within one segment and `**` spans any number. */
export const matchGlob = (glob: string, path: string): boolean =>
  new RegExp(
    '^' +
      glob
        .split(/(\*\*\/|\*\*|\*)/)
        .map(part => globTokens[part] ?? part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('') +
      '$'
  ).test(path);

const branchName = /^bothub\/[\w.-]+(?:\/[\w.-]+)*$/;

const checkBranch = (branch: string) =>
  branchName.test(branch) && !branch.includes('..') && !branch.endsWith('.lock')
    ? undefined
    : `branch "${branch}" must be a plain name under "bothub/"`;

/** Why one of `files` escapes the repository, is a GitHub workflow `globs` do not name, or falls outside `globs`. */
export const checkPaths = (files: string[], globs: string[] | undefined) => {
  const workflows = globs?.some(glob => glob.startsWith('.github/workflows')) ?? false;
  for (const file of files) {
    if (file.startsWith('/') || file.split('/').includes('..')) return `path "${file}" escapes the repository`;
    if (file.startsWith('.github/workflows/') && !workflows)
      return `path "${file}" is a GitHub workflow, which a job changes only when its paths name .github/workflows`;
    if (globs && !globs.some(glob => matchGlob(glob, file))) return `path "${file}" is outside the allowed paths`;
  }
};

const caps: Record<Proposal['kind'], number> = {
  reply: 3,
  label: 1,
  push: 1,
  'open-pr': 1,
  note: 1,
  ask: 1,
  close: 1,
};

/** The label a human adds to an approval issue; never a bot. */
export const approved = 'approved';

const check = (
  proposal: Proposal,
  { paths, branch }: Pick<Extract<Job, { type: 'bot' }>, 'paths' | 'branch'>
): string | undefined => {
  const pinned = (name: string) =>
    branch && name !== branch ? `branch "${name}" is not the job's branch "${branch}"` : undefined;
  switch (proposal.kind) {
    case 'push':
      return checkBranch(proposal.branch) ?? pinned(proposal.branch) ?? checkPaths(proposal.files ?? [], paths);
    case 'open-pr':
      return checkBranch(proposal.head) ?? pinned(proposal.head);
    case 'label':
      return proposal.add?.includes(approved) ? `only a human adds the "${approved}" label` : undefined;
  }
};

/**
 * Checks proposals against what a job allows: its effective `can`, its `paths` for pushed files and its rendered
 * `branch`, at most 3 replies and 1 of every other kind. A `close` is always allowed. Fails closed: every proposal that is not explicitly allowed
 * is rejected with a reason. `apply` says whether the job's mode lets accepted proposals reach GitHub.
 */
export const validate = (
  proposals: Proposal[],
  allowance: Pick<Extract<Job, { type: 'bot' }>, 'paths' | 'branch'> & { can: ProposalKind[] },
  mode: Mode
): Validated => {
  const accepted: Proposal[] = [];
  const rejected: Rejection[] = [];
  const counts = new Map<Proposal['kind'], number>();
  for (const proposal of proposals) {
    const count = counts.get(proposal.kind) ?? 0;
    const max = caps[proposal.kind];
    const reason =
      proposal.kind !== 'close' && !allowance.can.includes(proposal.kind)
        ? `"${proposal.kind}" is not allowed for this job`
        : (check(proposal, allowance) ?? (count >= max ? `more than ${max} "${proposal.kind}" proposals` : undefined));
    if (reason) {
      rejected.push({ proposal, reason });
      continue;
    }
    counts.set(proposal.kind, count + 1);
    accepted.push(proposal);
  }
  return { accepted, rejected, apply: mode !== 'shadow' };
};
