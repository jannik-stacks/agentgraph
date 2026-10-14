import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { git, gitStatus } from './git.ts';
import { readJsonl } from './jsonl.ts';
import { commentsIn, fold, type Op, type Pull } from './pulls.ts';
import type { Run, Store } from './store.ts';

/** One file of a diff. `patch` holds its hunks, left out when the file is binary or larger than the cap. */
export type FileDiff = {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  binary?: true;
  tooLarge?: true;
  patch?: string;
};

/** The change from `base` to `head`, measured from where they forked. */
export type Diff = { base: string; head: string; files: FileDiff[]; hiddenFiles?: number };

/** How a diff is read: the byte cap per file, and whether changes made only of whitespace are left out. */
export type DiffOptions = { cap?: number; whitespace?: 'show' | 'hide' };

const has = async (repo: string, rev: string) =>
  (await gitStatus(repo, ['cat-file', '-e', `${rev}^{commit}`]).catch(() => undefined))?.code === 0;

const resolve = async (repo: string, rev: string) => {
  const found = await gitStatus(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).catch(() => undefined);
  return (found?.code === 0 && found.stdout) || undefined;
};

const statuses: Record<string, FileDiff['status']> = { A: 'added', D: 'deleted' };

/** Per-file stats of `base...head`, without patches. `flags` go to every `git diff`, such as `-w`. */
export const diffStat = async (repo: string, base: string, head: string, flags: string[] = []) => {
  const range = `${base}...${head}`;
  const [numstat, names] = await Promise.all([
    git(repo, ['diff', '--numstat', '-z', '--no-renames', ...flags, range]),
    git(repo, ['diff', '--name-status', '-z', '--no-renames', ...flags, range]),
  ]);
  const status = new Map<string, FileDiff['status']>();
  const parts = names.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) status.set(parts[i + 1]!, statuses[parts[i]!] ?? 'modified');
  return numstat
    .split('\0')
    .filter(Boolean)
    .map((line): FileDiff => {
      const [added = '', deleted = '', path = ''] = line.split('\t');
      const binary = added === '-';
      return {
        path,
        status: status.get(path) ?? 'modified',
        additions: binary ? 0 : Number(added),
        deletions: binary ? 0 : Number(deleted),
        ...(binary && { binary: true as const }),
      };
    });
};

/**
 * Per-file unified diff of `base...head` in `repo` (a bare repository or a `.git` directory), the way GitHub shows a
 * pull request. A file whose patch is over `cap` bytes is marked `tooLarge` and carries no patch. With `whitespace`
 * set to `hide`, changes made only of whitespace are left out, and `hiddenFiles` counts the files that had nothing else.
 */
export const diffOf = async (
  repo: string,
  base: string,
  head: string,
  { cap = 128 * 1024, whitespace = 'show' }: DiffOptions = {}
): Promise<Diff> => {
  const [from, to] = await Promise.all([resolve(repo, base), resolve(repo, head)]);
  if (!from || !to) throw new Error(`"${from ? head : base}" is not a commit in ${repo}`);
  const flags = whitespace === 'hide' ? ['-w'] : [];
  const [files, all] = await Promise.all([
    diffStat(repo, from, to, flags),
    flags.length ? diffStat(repo, from, to) : undefined,
  ]);
  const hidden = all ? { hiddenFiles: all.length - files.length } : {};
  if (!files.length) return { base: from, head: to, files, ...hidden };
  const text = await git(repo, ['diff', '--no-renames', '--no-color', '--no-ext-diff', ...flags, `${from}...${to}`]);
  const sections = text.split(/^diff --git /m).slice(1);
  return {
    base: from,
    head: to,
    ...hidden,
    files: files.map((file, i) => {
      if (file.binary) return file;
      const section = sections[i] ?? '';
      const start = section.search(/^@@ /m);
      const patch = start < 0 ? '' : section.slice(start).replace(/\n$/, '');
      return patch.length > cap ? { ...file, tooLarge: true } : { ...file, patch };
    }),
  };
};

const bare = (dir: string) => existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects'));

/**
 * The repositories behind a data directory, best first: the local `origin.git` the served hub pushes to, the origins
 * its mirrors under `repos/` were cloned from, then the mirrors themselves, which also hold commits that were never
 * pushed.
 */
export const reposOf = async (dataDir: string) => {
  const found: string[] = [];
  const add = (dir: string) => {
    if (bare(dir) && !found.includes(dir)) found.push(dir);
  };
  add(join(dataDir, 'origin.git'));
  const mirrors: string[] = [];
  for (const owner of await readdir(join(dataDir, 'repos')).catch(() => []))
    for (const name of await readdir(join(dataDir, 'repos', owner)).catch(() => []))
      if (name.endsWith('.git')) mirrors.push(join(dataDir, 'repos', owner, name));
  for (const mirror of mirrors) {
    const url = (await git(mirror, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
    if (url && isAbsolute(url)) add(url);
  }
  mirrors.forEach(add);
  return found;
};

const firstWith = async (repos: string[], rev: string) => {
  for (const repo of repos) if (await has(repo, rev)) return repo;
};

const readOps = (file: string) => readJsonl<Op>(file);

/** A merge request with where its change is measured from: the target's tip, or where it was when the request merged. */
type Located = Pull & { base: string; head: string; repo: string };

const locate = async (repos: string[], pull: Pull, ops: Op[]): Promise<Located | undefined> => {
  const merged = ops.find(op => op.number === pull.number && op.op === 'merge');
  const repo = repos[0];
  if (!repo) return;
  const live = pull.state === 'open' ? await resolve(repo, `refs/heads/${pull.branch}`) : undefined;
  const head = live ?? pull.head;
  const base = merged?.op === 'merge' ? merged['into-sha'] : await resolve(repo, `refs/heads/${pull.into}`);
  if (!head || !base) return;
  const at = (await firstWith(repos, head)) ?? repo;
  return { ...pull, head, base, repo: at };
};

/** The run that opened a merge request: one of its origin event's runs of its job, preferring the one that recorded it. */
const openerOf = async (store: Store, runs: Run[], pull: Pull) => {
  if (!pull.origin) return;
  const { job, event } = pull.origin;
  const candidates = runs.filter(run => run.event.id === event && `${run.workflow}/${run.job}` === job && !run.check);
  for (const run of candidates) if ((await store.outcome(run.id))?.pr === pull.number) return run;
  return candidates[0];
};

/**
 * The merge requests in `<data>/pulls.jsonl`, each with the run that opened it, the issue that run was for, whether it
 * merges cleanly, its files with their added and deleted lines, and its comments.
 */
export const listPulls = async (store: Store) => {
  const ops = await readOps(join(store.dir, 'pulls.jsonl'));
  const repos = await reposOf(store.dir);
  const runs = await store.list();
  const pulls = fold(ops, n => `#${n}`).map(({ shas: _, ...pull }) => pull);
  return Promise.all(
    pulls.toReversed().map(async pull => {
      const opener = await openerOf(store, runs, pull);
      const located = await locate(repos, pull, ops).catch(() => undefined);
      const files = located
        ? await diffStat(located.repo, located.base, located.head).catch(() => undefined)
        : undefined;
      const mergeable =
        located && pull.state === 'open'
          ? await gitStatus(located.repo, ['merge-tree', '--write-tree', '--no-messages', located.base, located.head])
              .then(exit => exit.code === 0)
              .catch(() => undefined)
          : undefined;
      return {
        ...pull,
        ...(located && { head: located.head, base: located.base }),
        ...(mergeable !== undefined && { mergeable }),
        comments: commentsIn(ops, pull.number, n => `#${n}`),
        ...(opener && { run: opener.id, ...(opener.event.number !== undefined && { issue: opener.event.number }) }),
        ...(files && {
          files: files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
        }),
      };
    })
  );
};

export type PullListing = Awaited<ReturnType<typeof listPulls>>[number];

/** One merge request's diff, or undefined when there is no such request or no repository to read it from. */
export const pullDiff = async (store: Store, number: number, options: DiffOptions = {}) => {
  const ops = await readOps(join(store.dir, 'pulls.jsonl'));
  const pull = fold(ops, n => `#${n}`).find(p => p.number === number);
  if (!pull) return;
  const located = await locate(await reposOf(store.dir), pull, ops);
  if (!located) return { number, files: [] as FileDiff[] };
  return { number, ...(await diffOf(located.repo, located.base, located.head, options)) };
};

const parkedCommit = async (repo: string, run: Run) => {
  if (!run.parked) return;
  const since = Date.parse(run.startedAt ?? run.event.ts) / 1000;
  const log = await git(repo, ['log', '--format=%H %ct %s', `refs/heads/${run.parked}`]).catch(() => '');
  const parked = log
    .split('\n')
    .map(line => line.split(' '))
    .filter(([, time, ...subject]) => Number(time) >= since && subject.join(' ').endsWith('(parked)'));
  return parked.at(-1)?.[0];
};

/**
 * What a run changed: the commit it pushed, or the one it parked its work on, against the commit it started from (or
 * the commit's parent when the run did not record one). Empty when the run committed nothing.
 */
export const runDiff = async (
  store: Store,
  run: Run,
  options: DiffOptions = {}
): Promise<Diff & { commit?: string }> => {
  const empty = { base: run.base ?? '', head: '', files: [] };
  const repos = await reposOf(store.dir);
  const outcome = await store.outcome(run.id);
  const pushed = outcome?.results.find(result => result.kind === 'push' && result.sha)?.sha;
  let commit = pushed;
  for (const repo of repos) commit ??= await parkedCommit(repo, run);
  if (!commit) return empty;
  const repo = await firstWith(repos, commit);
  if (!repo) return empty;
  const base = run.base && (await has(repo, run.base)) ? run.base : `${commit}^`;
  return { commit, ...(await diffOf(repo, base, commit, options)) };
};
