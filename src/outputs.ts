import { z } from 'zod';
import { Closure, hubGlobs, humanOnly, NoteKind, type Job, type Mode, type Return } from './schema.ts';

const text = z.string().min(1);

/** A note a run proposes; it lands as `notes/<note>/<slug>.md` with status proposed. */
export const NoteProposal = z.strictObject({
  kind: z.literal('note'),
  note: NoteKind,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
  title: text,
  body: text,
});

/**
 * A write an agent asks the hub to make on its behalf. `close` is not a write: it states that the job stopped short
 * of done, and why.
 */
export const Proposal = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reply'), body: text }),
  z.strictObject({ kind: z.literal('label'), add: z.array(text).optional(), remove: z.array(text).optional() }),
  z.strictObject({ kind: z.literal('push'), branch: text, files: z.array(text).optional() }),
  z.strictObject({
    kind: z.literal('merge-request'),
    title: text,
    body: z.string(),
    branch: text,
    into: text.optional(),
    draft: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('merge'), request: z.int().positive() }),
  NoteProposal,
  z.strictObject({
    kind: z.literal('hub'),
    title: text,
    body: z.string(),
    files: z
      .array(
        z.union([
          z.strictObject({ path: text, content: z.string() }),
          z.strictObject({ path: text, delete: z.literal(true) }),
        ])
      )
      .min(1)
      .max(50),
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
  'merge-request': 1,
  merge: 1,
  note: 3,
  hub: 1,
  ask: 1,
  close: 1,
};

/** The label a human adds to an approval issue; never a bot. */
export const approved = 'approved';

/** Why a hub file change is refused: it leaves the hub, or touches `hub.yaml`, `bots/` or `workflows/`. */
export const humanOnlyPath = (path: string) => {
  if (path.startsWith('/') || path.split('/').includes('..')) return `path "${path}" leaves the hub`;
  if (humanOnly.some(glob => matchGlob(glob, path))) return `path "${path}" changes only by a human`;
};

const kindOf = (entry: Return) => (hubGlobs(entry) ? 'hub' : entry);

/**
 * What a job may write: its effective `returns`, its `paths`, and its rendered `branch` and `into`. `defaultBranch` is
 * the repository's, when known.
 */
export type Allowance = Pick<Job, 'paths' | 'branch' | 'into'> & { returns: Return[]; defaultBranch?: string };

/** Why a merge request may not target `into`: it is neither the job's `into` nor the default branch. */
const checkInto = (into: string | undefined, allowance: Allowance) => {
  if (into === undefined || into === allowance.into || into === allowance.defaultBranch) return;
  const job = allowance.into ? `the job's "${allowance.into}"` : 'the default branch';
  return `merge request into "${into}", but this job's requests go into ${job}`;
};

const check = (proposal: Proposal, allowance: Allowance): string | undefined => {
  const { paths, branch, returns } = allowance;
  const pinned = (name: string) =>
    branch && name !== branch ? `branch "${name}" is not the job's branch "${branch}"` : undefined;
  switch (proposal.kind) {
    case 'push':
      return checkBranch(proposal.branch) ?? pinned(proposal.branch) ?? checkPaths(proposal.files ?? [], paths);
    case 'merge-request':
      return (
        checkBranch(proposal.branch) ??
        pinned(proposal.branch) ??
        (proposal.branch === (proposal.into ?? allowance.into) ? 'a branch cannot be merged into itself' : undefined) ??
        checkInto(proposal.into, allowance)
      );
    case 'label':
      return proposal.add?.includes(approved) ? `only a human adds the "${approved}" label` : undefined;
    case 'hub': {
      const globs = returns.flatMap(entry => hubGlobs(entry) ?? []);
      for (const { path } of proposal.files) {
        const refused = humanOnlyPath(path);
        if (refused) return refused;
        if (!globs.some(glob => matchGlob(glob, path))) return `path "${path}" is outside hub(${globs.join(', ')})`;
      }
    }
  }
};

/**
 * Checks proposals against what a job allows: its effective `returns`, its `paths` for pushed files, its rendered
 * `branch` for pushes and merge requests, its rendered `into` (or the default branch) as the only targets of a merge
 * request, the `hub(<globs>)` it returns for hub file changes, at most 3 replies and 1 of every other kind. A `close`
 * is always allowed. Fails closed: every proposal that is not explicitly allowed is rejected with a reason. `apply`
 * says whether the job's mode lets accepted proposals land. A `merge` is checked against the request when it lands.
 */
export const validate = (proposals: Proposal[], allowance: Allowance, mode: Mode): Validated => {
  const kinds = new Set(allowance.returns.map(kindOf));
  const accepted: Proposal[] = [];
  const rejected: Rejection[] = [];
  const counts = new Map<Proposal['kind'], number>();
  for (const proposal of proposals) {
    const count = counts.get(proposal.kind) ?? 0;
    const max = caps[proposal.kind];
    const reason =
      proposal.kind !== 'close' && !kinds.has(proposal.kind)
        ? `"${proposal.kind}" is not allowed for this job`
        : (check(proposal, allowance) ?? (count >= max ? `more than ${max} "${proposal.kind}" proposals` : undefined));
    if (reason) {
      rejected.push({ proposal, reason });
      continue;
    }
    counts.set(proposal.kind, count + 1);
    accepted.push(proposal);
  }
  return { accepted, rejected, apply: mode !== 'log' };
};
