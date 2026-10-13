import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { runScript, type Launcher } from './runner.ts';
import { depsMarker, gitDirs } from './sandbox.ts';
import type { Hub } from './schema.ts';

export type Deps = NonNullable<Hub['deps']>;

const linked = '.bothub-deps';

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

/** Names the install a worktree needs: its command, its dirs and the content of every lockfile. */
export const depsKey = async (worktree: string, deps: Deps) => {
  const locks = await Promise.all(deps.lockfiles.map(file => readFile(join(worktree, file), 'utf8').catch(() => null)));
  return createHash('sha256')
    .update(JSON.stringify([deps.install, deps.dirs, locks]))
    .digest('hex')
    .slice(0, 24);
};

/**
 * Output of an install that failed on the network: a dropped connection, a timeout, a proxy that gave up, or npm
 * quitting with a request still open.
 */
const network =
  /\b(FETCH_ERROR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|socket hang up)\b|CONNECT response|tunneling socket|Exit handler never called/i;

/** How long an install that failed on the network waits before each try again. */
const installDelays = [2_000, 10_000, 30_000];

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Runs the install in a worktree cleared of its dirs, again after each of `delays` while it fails on the network. */
const installing = async (
  worktree: string,
  deps: Deps,
  launch: Launcher,
  hub: string | undefined,
  delays: readonly number[]
) => {
  const run = async () => {
    for (const dir of deps.dirs) await rm(join(worktree, dir), { recursive: true, force: true });
    return runScript(deps.install, worktree, deps['timeout-minutes'], {}, launch, { hub });
  };
  let result = await run();
  for (const delay of delays) {
    if (result.ok || !network.test(result.output)) break;
    await pause(delay);
    result = await run();
  }
  return result;
};

/** Runs the install in the worktree and moves the dirs it leaves to `entry`. */
const install = async (
  worktree: string,
  deps: Deps,
  entry: string,
  launch: Launcher,
  hub: string | undefined,
  delays: readonly number[]
) => {
  const { ok, output } = await installing(worktree, deps, launch, hub, delays);
  if (!ok) throw new Error(`installing dependencies failed: ${output.split('\n').slice(-10).join('\n')}`);
  const staged = `${entry}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    for (const dir of deps.dirs) {
      if (!(await exists(join(worktree, dir)))) throw new Error(`installing dependencies left no ${dir}`);
      await mkdir(dirname(join(staged, dir)), { recursive: true });
      await rename(join(worktree, dir), join(staged, dir));
    }
    await rename(staged, entry).catch(async error => {
      if (!(await exists(entry))) throw error;
    });
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
};

/** A dot directory other than `.bin` is a tool's cache, which each worktree keeps for itself. */
const shared = (entry: Dirent) => !(entry.isDirectory() && entry.name.startsWith('.') && entry.name !== '.bin');

/** Replaces each dir with a writable one holding a link per entry of the installed dir, caches left out. */
const link = async (worktree: string, deps: Deps, entry: string) => {
  for (const dir of deps.dirs) {
    const at = join(worktree, dir);
    await rm(at, { recursive: true, force: true });
    await mkdir(at, { recursive: true });
    for (const { name } of (await readdir(join(entry, dir), { withFileTypes: true })).filter(shared))
      await symlink(join(entry, dir, name), join(at, name));
    await writeFile(join(at, linked), entry);
  }
};

/** Keeps the dirs out of every change git reports for the repository's worktrees. */
const exclude = async (common: string, deps: Deps) => {
  const file = join(common, 'info', 'exclude');
  const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n');
  const missing = deps.dirs.map(dir => `/${dir}/`).filter(line => !lines.includes(line));
  if (!missing.length) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${lines.at(-1) ? '\n' : ''}${missing.join('\n')}\n`);
};

const inFlight = new Map<string, Promise<void>>();

/** Runs `work` once for `key` at a time: a caller arriving while it runs waits for the same promise. */
const once = (key: string, work: () => Promise<void>) => {
  const running = inFlight.get(key);
  if (running) return running;
  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
};

const ready = async (
  worktree: string,
  deps: Deps,
  cache: string,
  launch: Launcher,
  hub: string | undefined,
  delays: readonly number[]
) => {
  const git = await gitDirs(worktree);
  if (!git) return;
  const entry = join(cache, await depsKey(worktree, deps));
  const marker = join(git.admin, depsMarker);
  const [current] = (await readFile(marker, 'utf8').catch(() => '')).split('\n');
  const intact = await Promise.all(deps.dirs.map(dir => exists(join(worktree, dir, linked))));
  if (current === entry && intact.every(Boolean)) return;
  await rm(marker, { force: true });
  if (!(await exists(entry)))
    await once(entry, async () => {
      if (await exists(entry)) return;
      await mkdir(cache, { recursive: true });
      await install(worktree, deps, entry, launch, hub, delays);
    });
  await link(worktree, deps, entry);
  await exclude(git.common, deps);
  await writeFile(marker, [entry, ...deps.dirs].join('\n'));
};

/**
 * Makes the worktree's dependencies ready: installs them under `cache` once per key, then links each dir into the
 * worktree and records the install in its admin dir, where the sandbox finds it to mount read-only. Concurrent calls
 * for one worktree, or for one install, share the work. An install that fails on the network is tried again after
 * each of `delays`.
 */
export const prepareDeps = (
  worktree: string,
  deps: Deps,
  cache: string,
  launch: Launcher,
  hub?: string,
  delays: readonly number[] = installDelays
) => once(worktree, () => ready(worktree, deps, cache, launch, hub, delays));

/** A launcher that makes a worktree's dependencies ready before anything starts in it. */
export const withDeps = (launch: Launcher, deps: Deps, cache: string, hub?: string): Launcher => ({
  ...launch,
  agent: async (adapter, spec, ...rest) => {
    await prepareDeps(spec.cwd, deps, cache, launch, hub);
    return launch.agent(adapter, spec, ...rest);
  },
  script: async (script, cwd, ...rest) => {
    await prepareDeps(cwd, deps, cache, launch, hub);
    return launch.script(script, cwd, ...rest);
  },
});
