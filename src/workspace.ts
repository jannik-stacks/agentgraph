import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
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
  const bases = new Map<string, string>();
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

  /** Refreshes the mirror and checks out the event's ref (or the default branch) for a run. Resolves to its path. */
  const create = async ({ repo, ref }: Pick<BotEvent, 'repo' | 'ref'>, runId: string) => {
    const mirror = await sync(repo);
    const path = worktreePath(dataDir, runId);
    const rev = !ref ? 'HEAD' : ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    await serial(repo, () => git(['-C', mirror, 'worktree', 'add', '--detach', path, `${rev}^{commit}`]));
    bases.set(runId, await git(['-C', path, 'rev-parse', 'HEAD']));
    return path;
  };

  /**
   * Pushes a run's `branch` without forcing, after checking that every file it changes since the run started is
   * listed in `files` and allowed by `paths`. Resolves to the branch URL; throws with the reason it refused.
   */
  const publish = async (
    repo: string,
    runId: string,
    {
      branch,
      files = [],
      paths,
      message,
    }: Omit<Extract<Proposal, { kind: 'push-branch' }>, 'kind'> & { paths?: string[]; message: string }
  ) => {
    const base = bases.get(runId);
    if (!base) throw new Error(`no worktree for run "${runId}"`);
    const path = worktreePath(dataDir, runId);
    const run = (args: string[], env?: Record<string, string>) => git(['-C', path, ...args], env);
    const ref = `refs/heads/${branch}`;

    const head = await run(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    if (head !== ref) {
      const taken = await run(['rev-parse', '--verify', '--quiet', ref]).then(
        () => true,
        () => false
      );
      if (taken) throw new Error(`branch "${branch}" exists but is not checked out`);
      await run(['checkout', '-q', '-b', branch]);
    }

    // Uncommitted changes are committed only for files the proposal lists; the rest are left behind.
    const dirty = new Set([
      ...names(await run(['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard'])),
      ...names(await run(['diff', '--cached', '--name-only', '--no-renames', '-z'])),
    ]);
    const listed = files.filter(file => dirty.has(file));
    if (listed.length) {
      await run(['add', '-A', '--', ...listed]);
      await run(['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message, '--', ...listed], {
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

    await run(['push', '-q', cloneUrl(repo), `${ref}:${ref}`], await auth(repo));
    return `https://github.com/${repo}/tree/${branch}`;
  };

  /** Deletes a run's worktree and prunes it from the mirror. Never throws. */
  const remove = async (repo: string, runId: string) => {
    bases.delete(runId);
    await rm(worktreePath(dataDir, runId), { recursive: true, force: true });
    await serial(repo, () => git(['-C', mirrorPath(repo), 'worktree', 'prune'])).catch(() => {});
  };

  return { create, publish, remove };
};

export type Workspaces = ReturnType<typeof workspaces>;
