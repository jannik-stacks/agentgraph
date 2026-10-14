import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { botEnv, git } from './git.ts';
import { checkPaths, type Proposal } from './outputs.ts';
import type { BotEvent } from './types.ts';

const repoName = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

const names = (output: string) => output.split('\0').filter(Boolean);

const conflictMarker = /^(<{7}|>{7})( |$)/m;

/** The files among `files` in `cwd` that still hold a conflict marker. */
export const unresolved = async (cwd: string, files: string[]) => {
  const marked = await Promise.all(
    files.map(async file => (conflictMarker.test(await readFile(join(cwd, file), 'utf8').catch(() => '')) ? file : ''))
  );
  return marked.filter(Boolean);
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

/** The branch a run's work is parked on, beside the job's own `branch`, one per run. */
export const parkedBranch = (branch: string, runId: string) => `${branch}-parked-${runId}`;

/** Where the worktree for a run lives. */
export const worktreePath = (dataDir: string, runId: string) => join(dataDir, 'work', runId);

/**
 * Git workspaces under `dataDir`: one bare mirror per repository in `repos/<owner>/<repo>.git`, refreshed
 * before each run, and one detached worktree per run in `work/<runId>`. A token, when given, is sent as an
 * auth header through the environment, so it is neither in argv nor in the mirror's config.
 */
export const workspaces = ({
  dataDir,
  cloneUrl = repo => `https://github.com/${repo}.git`,
  token,
}: {
  dataDir: string;
  cloneUrl?: (repo: string) => string;
  token?: (repo: string) => Promise<string | undefined>;
}) => {
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(repo: string, task: () => Promise<T>) => {
    const next = (queues.get(repo) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(repo, next);
    return next;
  };

  const mirrorPath = (repo: string) => {
    if (!repoName.test(repo)) throw new Error(`invalid repository "${repo}"`);
    return join(dataDir, 'repos', `${repo}.git`);
  };

  const auth = async (repo: string): Promise<Record<string, string>> => {
    const value = await token?.(repo);
    if (!value) return {};
    const basic = Buffer.from(`x-access-token:${value}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}`,
    };
  };

  const sync = (repo: string) =>
    serial(repo, async () => {
      const path = mirrorPath(repo);
      const env = await auth(repo);
      if (await exists(path)) await git(path, ['fetch', '--prune', 'origin'], env);
      else {
        await mkdir(dirname(path), { recursive: true });
        await git(dirname(path), ['clone', '--mirror', cloneUrl(repo), path], env);
      }
      return path;
    });

  /**
   * Refreshes the mirror and checks out a run's start: the job's `branch` when it exists, otherwise the event's ref
   * (a branch or a commit, or the default branch). With `merge`, that branch is merged in without committing,
   * conflict markers left in place. Resolves to the path, the commit the change is measured from (`base`, which `publish` and `changes` take
   * back; the merged-in tip with `merge`), the commit checked out (`head`), the files left conflicting and, when it
   * started at the job's existing branch, that `branch`. With `fresh`, it starts from the ref even when the branch
   * exists, and resolves to the branch's tip as `replace`, for `publish` to replace. With `from`, it starts at that
   * branch instead when it exists, such as the work parked for the job's branch.
   */
  const create = async (
    {
      repo,
      ref,
      branch,
      merge,
      fresh,
      from,
    }: Pick<BotEvent, 'repo' | 'ref'> & { branch?: string; merge?: string; fresh?: boolean; from?: string },
    runId: string
  ) => {
    const mirror = await sync(repo);
    const path = worktreePath(dataDir, runId);
    const at = (name: string) => `${/^(refs\/|[0-9a-f]{40}$)/.test(name) ? name : `refs/heads/${name}`}^{commit}`;
    const verify = (name: string) => git(mirror, ['rev-parse', '--verify', '--quiet', at(name)]).catch(() => '');
    const own = branch ? await verify(branch) : '';
    const picked = from ? await verify(from) : '';
    const rev = picked || (!fresh && own) || (ref ? at(ref) : 'HEAD^{commit}');
    await serial(repo, () => git(mirror, ['worktree', 'add', '--detach', path, rev]));
    const head = await git(path, ['rev-parse', 'HEAD']);
    const started = !own || !branch ? {} : fresh ? { replace: own } : { branch };
    if (!merge) return { path, base: head, head, conflicts: [], ...started };
    const base = await verify(merge);
    if (!base) throw new Error(`branch "${merge}" does not exist`);
    const merging = ['-c', 'commit.gpgsign=false', 'merge', '--no-commit', '--no-ff', '-q', base];
    await git(path, merging, botEnv).catch(() => {});
    const conflicts = names(await git(path, ['diff', '--name-only', '--diff-filter=U', '-z']));
    return { path, base, head, conflicts, ...started };
  };

  /**
   * Pushes a run's commit to `branch` without forcing, after checking that every file it changes since `base` is
   * allowed by `paths` and every file it changes on top of the branch is listed in `files`; a run that started at the
   * branch moves it forward. With `replace`, the branch is replaced instead, only while it is still at that commit.
   * A merge in progress
   * is committed whole with both parents once no conflicting file keeps a marker; then every file the branch changes
   * against the merged-in tip must be allowed by `paths`. The latest work parked for the branch (see `parkedBranch`)
   * that the run builds on counts as already listed. Reports the commit to `committed` before pushing it; when the
   * remote branch is already at `expected`, nothing is pushed. Resolves to the branch URL; throws with the reason it
   * refused.
   */
  const publish = async (
    repo: string,
    runId: string,
    {
      branch,
      files = [],
      paths,
      message,
      base,
      expected,
      committed,
      replace,
    }: Omit<Extract<Proposal, { kind: 'push' }>, 'kind'> & {
      paths?: string[];
      message: string;
      base: string;
      expected?: string;
      replace?: string;
      committed?: (sha: string) => Promise<unknown>;
    }
  ) => {
    const path = worktreePath(dataDir, runId);
    if (!(await exists(path))) throw new Error(`no worktree for run "${runId}"`);
    const run = (args: string[], env?: Record<string, string>) => git(path, args, env);
    const ref = `refs/heads/${branch}`;
    const origin = cloneUrl(repo);
    const url = origin.startsWith('https://github.com/')
      ? `https://github.com/${repo}/tree/${branch}`
      : `${origin}#${branch}`;
    if (expected) {
      const [remote] = (await run(['ls-remote', origin, ref], await auth(repo))).split(/\s/);
      if (remote === expected) return url;
    }

    const tip = await run(['rev-parse', '--verify', '--quiet', ref]).catch(() => '');
    const kept = ['--list', `${branch}-parked*`, '--merged', 'HEAD', '--sort=-refname', '--format=%(objectname)'];
    const [parked = ''] = (await run(['branch', ...kept])).split('\n');
    const builds = (commit: string) =>
      run(['merge-base', '--is-ancestor', commit, 'HEAD']).then(
        () => true,
        () => false
      );
    const ahead = await builds(tip || 'HEAD');
    if (!ahead && !replace) throw new Error(`branch "${branch}" exists and this run did not start from it`);

    // Uncommitted changes are committed when the proposal lists every one of them; a merge is committed whole.
    const merging = await run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '');
    const dirty = [
      ...new Set([
        ...names(await run(['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard'])),
        ...names(await run(['diff', '--cached', '--name-only', '--no-renames', '-z'])),
      ]),
    ];
    const stray = merging ? [] : dirty.filter(file => !files.includes(file));
    if (stray.length) throw new Error(`uncommitted changes not listed in the proposal: ${stray.join(', ')}`);
    if (merging) {
      const conflicted = names(await run(['diff', '--name-only', '--diff-filter=U', '-z']));
      const marked = await unresolved(path, conflicted);
      if (marked.length) throw new Error(`conflict markers left in ${marked.join(', ')}`);
      await run(['add', '-A']);
      await run(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message], botEnv);
    } else if (dirty.length) {
      await run(['add', '-A', '--', ...dirty]);
      await run(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message, '--', ...dirty], botEnv);
    }

    const diffed = async (from: string) =>
      names(await run(['diff', '--name-only', '--no-renames', '-z', `${from}...HEAD`]));
    const changed = await diffed(merging || base);
    if (!changed.length) throw new Error(`branch "${branch}" has no changes`);
    const since = parked || tip;
    const own = since && since !== base && !merging && !replace ? await diffed(since) : changed;
    const unlisted = merging ? undefined : own.find(file => !files.includes(file));
    if (unlisted) throw new Error(`"${unlisted}" changed but is not listed in the proposal`);
    const outside = checkPaths(changed, paths);
    if (outside) throw new Error(outside);

    if (parked && !merging && !replace) {
      const floor = tip && (await builds(tip)) ? tip : base;
      const count = (to: string) => run(['rev-list', '--count', `${floor}..${to}`]).then(Number);
      if ((await count('HEAD')) - (await count(parked)) <= 1) {
        await run(['reset', '-q', '--soft', floor]);
        await run(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message], botEnv);
      }
    }

    await committed?.(await run(['rev-parse', 'HEAD']));
    const lease = replace ? [`--force-with-lease=${ref}:${replace}`] : [];
    await run(['push', '-q', ...lease, origin, `HEAD:${ref}`], await auth(repo));
    return url;
  };

  /**
   * Commits everything in a run's worktree, untracked files included, and pushes it to `branch`, without forcing.
   */
  const park = async (repo: string, runId: string, branch: string, message: string) => {
    const run = (args: string[], env?: Record<string, string>) => git(worktreePath(dataDir, runId), args, env);
    await run(['add', '-A']);
    await run(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '--allow-empty', '-m', message], botEnv);
    await run(['push', '-q', cloneUrl(repo), `HEAD:refs/heads/${branch}`], await auth(repo));
    await run(['update-ref', `refs/heads/${branch}`, 'HEAD']);
  };

  /** Runs `use` with git in a run's worktree on a copy of its index, so the worktree's own index is untouched. */
  const scratched = async <T>(runId: string, use: (run: (args: string[]) => Promise<string>) => Promise<T>) => {
    const path = worktreePath(dataDir, runId);
    if (!(await exists(path))) throw new Error(`no worktree for run "${runId}"`);
    const index = await git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const scratch = `${index}.bothub-${randomBytes(4).toString('hex')}`;
    await copyFile(index, scratch).catch(() => {});
    try {
      return await use(args => git(path, args, { ...botEnv, GIT_INDEX_FILE: scratch }));
    } finally {
      await rm(scratch, { force: true });
    }
  };

  /**
   * Files a run changed since `base`, committed or not, and their diff (limited to `only` when given), with `context`
   * lines around each hunk or the whole enclosing `function`.
   */
  const changes = (runId: string, base: string, only: string[] = [], context?: number | 'function') =>
    scratched(runId, async run => {
      await run(['add', '-A']);
      const files = names(await run(['diff', '--cached', '--name-only', '--no-renames', '-z', base]));
      const around = context === undefined ? [] : context === 'function' ? ['--function-context'] : [`-U${context}`];
      const diff = await run(['diff', '--cached', '--no-renames', ...around, base, '--', ...only]);
      return { files, diff };
    });

  /**
   * A commit of a run's worktree as it is now, committed or not: its `HEAD` when nothing is uncommitted, otherwise a
   * new commit on top of it that no branch points at. The worktree is left as it was.
   */
  const snapshot = (runId: string) =>
    scratched(runId, async run => {
      await run(['add', '-A']);
      const tree = await run(['write-tree']);
      const head = await run(['rev-parse', 'HEAD']);
      if (tree === (await run(['rev-parse', 'HEAD^{tree}']))) return head;
      return run(['commit-tree', tree, '-p', head, '-m', `bothub: ${runId}`]);
    });

  /** The commit where a run's worktree forked from `branch`, a ref, a commit, or the default branch when none is given. */
  const forkPoint = async (repo: string, runId: string, branch?: string) => {
    const path = worktreePath(dataDir, runId);
    const target = !branch
      ? await git(mirrorPath(repo), ['rev-parse', 'HEAD'])
      : branch.startsWith('refs/') || /^[0-9a-f]{40}$/.test(branch)
        ? branch
        : `refs/heads/${branch}`;
    return git(path, ['merge-base', 'HEAD', target]);
  };

  /** Whether a worktree holds work no branch has: uncommitted changes, or commits no ref reaches. */
  const unkept = async (path: string) =>
    !!(await git(path, ['status', '--porcelain'])) ||
    !!(await git(path, ['rev-list', '-n', '1', 'HEAD', '--not', '--glob=refs/*']));

  /**
   * Deletes a run's worktree and prunes it from the mirror, first parking work no branch has on `bothub/kept-<runId>`
   * (see `park`). A worktree whose work could not be parked is left in place. Never throws; resolves to the branch it
   * parked on.
   */
  const remove = async (repo: string, runId: string) => {
    const path = worktreePath(dataDir, runId);
    const kept = `bothub/kept-${runId}`;
    let parked: string | undefined;
    if (await exists(path))
      try {
        if (await unkept(path)) await park(repo, runId, (parked = kept), `bothub: ${runId} (parked)`);
      } catch (e) {
        console.error(`kept worktree ${path}: could not park it: ${(e as Error).message}`);
        return;
      }
    await rm(path, { recursive: true, force: true });
    await serial(repo, () => git(mirrorPath(repo), ['worktree', 'prune'])).catch(() => {});
    return parked;
  };

  return { create, publish, park, changes, snapshot, forkPoint, remove };
};

export type Workspaces = ReturnType<typeof workspaces>;
