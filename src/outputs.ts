import { z } from 'zod';
import type { Job, Mode } from './schema.ts';

const text = z.string().min(1);

/** A write an agent asks the hub to make on its behalf. */
export const Proposal = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reply'), body: text }),
  z.strictObject({ kind: z.literal('label'), add: z.array(text).optional(), remove: z.array(text).optional() }),
  z.strictObject({ kind: z.literal('push-branch'), branch: text, files: z.array(text).optional() }),
  z.strictObject({
    kind: z.literal('open-pr'),
    title: text,
    body: z.string(),
    head: text,
    base: text.optional(),
    draft: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('propose-rule'), path: text, content: z.string() }),
  z.strictObject({ kind: z.literal('ask-human'), question: text }),
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

/** Why one of `files` escapes the repository or falls outside `globs`, if one does. */
export const checkPaths = (files: string[], globs: string[] | undefined) => {
  for (const file of files) {
    if (file.startsWith('/') || file.split('/').includes('..')) return `path "${file}" escapes the repository`;
    if (globs && !globs.some(glob => matchGlob(glob, file))) return `path "${file}" is outside the allowed paths`;
  }
};

const check = (proposal: Proposal, globs: string[] | undefined): string | undefined => {
  switch (proposal.kind) {
    case 'push-branch':
      return checkBranch(proposal.branch) ?? checkPaths(proposal.files ?? [], globs);
    case 'open-pr':
      return checkBranch(proposal.head);
    case 'propose-rule':
      return checkPaths([proposal.path], globs);
  }
};

/**
 * Checks proposals against a job's `safe-outputs`. Fails closed: every proposal that is not explicitly
 * allowed is rejected with a reason. `apply` says whether the job's mode lets accepted proposals reach GitHub.
 */
export const validate = (proposals: Proposal[], outputs: Job['safe-outputs'], mode: Mode): Validated => {
  const accepted: Proposal[] = [];
  const rejected: Rejection[] = [];
  const counts = new Map<Proposal['kind'], number>();
  for (const proposal of proposals) {
    const allowed = outputs[proposal.kind];
    const count = counts.get(proposal.kind) ?? 0;
    const reason = !allowed
      ? `"${proposal.kind}" is not allowed for this job`
      : (check(proposal, allowed.paths) ??
        (count >= allowed.max ? `more than ${allowed.max} "${proposal.kind}" proposals` : undefined));
    if (reason) {
      rejected.push({ proposal, reason });
      continue;
    }
    counts.set(proposal.kind, count + 1);
    accepted.push(proposal);
  }
  return { accepted, rejected, apply: mode !== 'shadow' };
};
