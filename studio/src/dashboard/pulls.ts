import { atomWithStorage } from 'jotai/utils';
import type { Diff, PullListing } from '../../../src/diffs.ts';
import { apiAtom, latest } from '../state.ts';

export type { Diff, PullListing };
export type FileDiff = Diff['files'][number];

export const pullsQueryAtom = apiAtom<PullListing[]>('/api/pulls');
export const pullsAtom = latest(pullsQueryAtom, undefined);

/** Whether diffs leave out changes made only of whitespace. */
export const hideWhitespaceAtom = atomWithStorage('bhm.diff.hide-whitespace', false, undefined, { getOnInit: true });

const cache = new Map<string, Promise<Diff | null>>();

const cached = (key: string, path: string, hideWhitespace: boolean) => {
  const url = hideWhitespace ? `${path}?whitespace=hide` : path;
  let found = cache.get(`${key}:${url}`);
  if (!found) {
    found = fetch(url).then(r => (r.ok ? (r.json() as Promise<Diff>) : null));
    cache.set(`${key}:${url}`, found);
  }
  return found;
};

/** A merge request's diff, fetched once per head commit. */
export const fetchPullDiff = (number: number, head: string | undefined, hideWhitespace = false) =>
  cached(`pull@${head ?? ''}`, `/api/pulls/${number}/diff`, hideWhitespace);

/** What a run committed, fetched once per status it is seen in. */
export const fetchRunDiff = (id: string, status: string, hideWhitespace = false) =>
  cached(`run@${status}`, `/api/runs/${encodeURIComponent(id)}/diff`, hideWhitespace);

/** Added and deleted lines over all files. */
export const totals = (files: Pick<FileDiff, 'additions' | 'deletions'>[]) =>
  files.reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), {
    additions: 0,
    deletions: 0,
  });
