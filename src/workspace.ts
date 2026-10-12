import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { BotEvent } from './types.ts';

const exec = promisify(execFile);
const repoName = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

/** Runs git without a shell; errors name the command but never the auth arguments. */
const git = async (args: string[], auth: string[] = []) => {
  try {
    const { stdout } = await exec('git', [...auth, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 << 20,
    });
    return stdout.trim();
  } catch (e) {
    const { stderr } = e as { stderr?: string };
    throw new Error(`git ${args.join(' ')} failed: ${stderr?.trim() || (e as Error).name}`);
  }
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

/** Where the worktree for a run lives. */
export const worktreePath = (dataDir: string, runId: string) => join(dataDir, 'work', runId);

/**
 * Git workspaces under `dataDir`: one bare mirror per repository in `repos/<owner>/<repo>.git`, refreshed
 * before each run, and one detached worktree per run in `work/<runId>`. A token, when given, is sent as a
 * per-command header and never stored in the mirror's config.
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

  const auth = async (repo: string) => {
    const value = await token?.(repo);
    if (!value) return [];
    const basic = Buffer.from(`x-access-token:${value}`).toString('base64');
    return ['-c', `http.extraHeader=Authorization: basic ${basic}`];
  };

  const sync = (repo: string) =>
    serial(repo, async () => {
      const path = mirrorPath(repo);
      const header = await auth(repo);
      if (await exists(path)) await git(['-C', path, 'fetch', '--prune', 'origin'], header);
      else {
        await mkdir(dirname(path), { recursive: true });
        await git(['clone', '--mirror', cloneUrl(repo), path], header);
      }
      return path;
    });

  /** Refreshes the mirror and checks out the event's ref (or the default branch) for a run. Resolves to its path. */
  const create = async ({ repo, ref }: Pick<BotEvent, 'repo' | 'ref'>, runId: string) => {
    const mirror = await sync(repo);
    const path = worktreePath(dataDir, runId);
    const rev = !ref ? 'HEAD' : ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    await serial(repo, () => git(['-C', mirror, 'worktree', 'add', '--detach', path, `${rev}^{commit}`]));
    return path;
  };

  /** Deletes a run's worktree and prunes it from the mirror. Never throws. */
  const remove = async (repo: string, runId: string) => {
    await rm(worktreePath(dataDir, runId), { recursive: true, force: true });
    await serial(repo, () => git(['-C', mirrorPath(repo), 'worktree', 'prune'])).catch(() => {});
  };

  return { create, remove };
};

export type Workspaces = ReturnType<typeof workspaces>;
