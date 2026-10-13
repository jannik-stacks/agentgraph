import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { checkPaths, type Proposal } from './outputs.ts';
import type { BotEvent } from './types.ts';

const exec = promisify(execFile);
const repoName = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
const bot = { name: 'bothub[bot]', email: 'bothub[bot]@users.noreply.github.com' };

/** Runs git without a shell; `env` extends the process environment and never appears in errors. */
const git = async (args: string[], env: Record<string, string> = {}) => {
  try {
    const { stdout } = await exec('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      maxBuffer: 16 << 20,
    });
    return stdout.trim();
  } catch (e) {
    const { stderr } = e as { stderr?: string };
    throw new Error(`git ${args.join(' ')} failed: ${stderr?.trim() || (e as Error).name}`);
  }
};

const names = (output: string) => output.split('\0').filter(Boolean);

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

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
      if (await exists(path)) await git(['-C', path, 'fetch', '--prune', 'origin'], env);
      else {
        await mkdir(dirname(path), { recursive: true });
        await git(['clone', '--mirror', cloneUrl(repo), path], env);
      }
      return path;
    });

  /**
   * Refreshes the mirror and checks out the event's ref (or the default branch) for a run. Resolves to its path and
   * the commit it starts from, which `publish` and `changes` take back as `base`.
   */
  const create = async ({ repo, ref }: Pick<BotEvent, 'repo' | 'ref'>, runId: string) => {
    const mirror = await sync(repo);
    const path = worktreePath(dataDir, runId);
    const rev = !ref ? 'HEAD' : ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    await serial(repo, () => git(['-C', mirror, 'worktree', 'add', '--detach', path, `${rev}^{commit}`]));
    return { path, base: await git(['-C', path, 'rev-parse', 'HEAD']) };
  };

  /**
   * Pushes a run's `branch` without forcing, after checking that every file it changes since `base` is listed in
   * `files` and allowed by `paths`. Reports the commit to `committed` before pushing it; when the remote branch is
   * already at `expected`, nothing is pushed. Resolves to the branch URL; throws with the reason it refused.
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
    }: Omit<Extract<Proposal, { kind: 'push' }>, 'kind'> & {
      paths?: string[];
      message: string;
      base: string;
      expected?: string;
      committed?: (sha: string) => Promise<unknown>;
    }
  ) => {
    const path = worktreePath(dataDir, runId);
    if (!(await exists(path))) throw new Error(`no worktree for run "${runId}"`);
    const run = (args: string[], env?: Record<string, string>) => git(['-C', path, ...args], env);
    const ref = `refs/heads/${branch}`;
    const origin = cloneUrl(repo);
    const url = origin.startsWith('https://github.com/')
      ? `https://github.com/${repo}/tree/${branch}`
      : `${origin}#${branch}`;
    if (expected) {
      const [remote] = (await run(['ls-remote', origin, ref], await auth(repo))).split(/\s/);
      if (remote === expected) return url;
    }

    const head = await run(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    if (head !== ref) {
      const taken = await run(['rev-parse', '--verify', '--quiet', ref]).then(
        () => true,
        () => false
      );
      if (taken) throw new Error(`branch "${branch}" exists but is not checked out`);
      await run(['checkout', '-q', '-b', branch]);
    }

    // Uncommitted changes are committed when the proposal lists every one of them; otherwise nothing is pushed.
    const dirty = [
      ...new Set([
        ...names(await run(['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard'])),
        ...names(await run(['diff', '--cached', '--name-only', '--no-renames', '-z'])),
      ]),
    ];
    const stray = dirty.filter(file => !files.includes(file));
    if (stray.length) throw new Error(`uncommitted changes not listed in the proposal: ${stray.join(', ')}`);
    if (dirty.length) {
      await run(['add', '-A', '--', ...dirty]);
      await run(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message, '--', ...dirty], {
        GIT_AUTHOR_NAME: bot.name,
        GIT_AUTHOR_EMAIL: bot.email,
        GIT_COMMITTER_NAME: bot.name,
        GIT_COMMITTER_EMAIL: bot.email,
      });
    }

    const changed = names(await run(['diff', '--name-only', '--no-renames', '-z', `${base}...${ref}`]));
    if (!changed.length) throw new Error(`branch "${branch}" has no changes`);
    const unlisted = changed.find(file => !files.includes(file));
    if (unlisted) throw new Error(`"${unlisted}" changed but is not listed in the proposal`);
    const outside = checkPaths(changed, paths);
    if (outside) throw new Error(outside);

    await committed?.(await run(['rev-parse', ref]));
    await run(['push', '-q', origin, `${ref}:${ref}`], await auth(repo));
    return url;
  };

  /**
   * Files a run changed since `base`, committed or not, and their diff (limited to `only` when given). Reads through a
   * copy of the index, so the worktree's own index is untouched.
   */
  const changes = async (runId: string, base: string, only: string[] = []) => {
    const path = worktreePath(dataDir, runId);
    if (!(await exists(path))) throw new Error(`no worktree for run "${runId}"`);
    const index = await git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const scratch = `${index}.bothub-${randomBytes(4).toString('hex')}`;
    await copyFile(index, scratch).catch(() => {});
    try {
      const env = { GIT_INDEX_FILE: scratch };
      const run = (args: string[]) => git(['-C', path, ...args], env);
      await run(['add', '-A']);
      const files = names(await run(['diff', '--cached', '--name-only', '--no-renames', '-z', base]));
      const diff = await run(['diff', '--cached', '--no-renames', base, '--', ...only]);
      return { files, diff };
    } finally {
      await rm(scratch, { force: true });
    }
  };

  /** The commit where a run's worktree forked from `branch`, a ref, or the default branch when none is given. */
  const forkPoint = async (repo: string, runId: string, branch?: string) => {
    const path = worktreePath(dataDir, runId);
    const target = !branch
      ? await git(['-C', mirrorPath(repo), 'rev-parse', 'HEAD'])
      : branch.startsWith('refs/')
        ? branch
        : `refs/heads/${branch}`;
    return git(['-C', path, 'merge-base', 'HEAD', target]);
  };

  /** Deletes a run's worktree and prunes it from the mirror. Never throws. */
  const remove = async (repo: string, runId: string) => {
    await rm(worktreePath(dataDir, runId), { recursive: true, force: true });
    await serial(repo, () => git(['-C', mirrorPath(repo), 'worktree', 'prune'])).catch(() => {});
  };

  return { create, publish, changes, forkPoint, remove };
};

export type Workspaces = ReturnType<typeof workspaces>;
