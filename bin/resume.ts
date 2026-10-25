/**
 * Crash-safe files and units for long bench and tune runs. A log line that a crash cut off is skipped, a unit a dead
 * process left half done goes to an attic beside it, and a run waits while the model proxy or docker is down.
 */
import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Disk, ensureFreeDisk } from '../src/disk.ts';
import { parseModelUrls } from '../src/harnesses.ts';
import { isLockedByOtherProcess } from '../src/owner.ts';
import { writeFileAtomic } from '../src/store.ts';

/** Appends one JSON line, first ending a line a crash left open. */
export const appendJsonl = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const size = existsSync(path) ? statSync(path).size : 0;
  const last = Buffer.alloc(1);
  if (size) {
    const fd = openSync(path, 'r');
    readSync(fd, last, 0, 1, size - 1);
    closeSync(fd);
  }
  appendFileSync(path, `${size && last[0] !== 10 ? '\n' : ''}${JSON.stringify(v)}\n`);
};

export const agentgraphDir = join(import.meta.dirname, '..');

export const readFileOrEmpty = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** The JSON lines of `text`, skipping any a crash cut off. */
export const parseJsonl = <T = Record<string, unknown>>(text: string): T[] =>
  text.split('\n').flatMap(l => {
    try {
      return l ? [JSON.parse(l) as T] : [];
    } catch {
      return [];
    }
  });

export const readJsonl = <T = Record<string, unknown>>(path: string) => parseJsonl<T>(readFileOrEmpty(path));

/**
 * Moves `path` into `.attic/` beside it, keeping its records; answers where it went. Its checkouts and scoring tree
 * are deleted first, since a rerun makes them again.
 */
export const moveDirToAttic = (path: string) => {
  if (!existsSync(path)) return undefined;
  for (const copy of ['data/work', 'tree']) rmSync(join(path, copy), { recursive: true, force: true });
  const stamp = join(dirname(path), '.attic', `${basename(path)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let to = stamp;
  for (let n = 2; existsSync(to); n++) to = `${stamp}-${n}`;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(path, to);
  return to;
};

/** Copies `src` to `dst` through a temp dir and a rename, so `dst` is whole or absent. */
export const copyDirIfAbsentAtomic = (src: string, dst: string, filter?: (path: string) => boolean) => {
  const tmp = `${dst}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(src, tmp, { recursive: true, ...(filter && { filter }) });
  if (existsSync(dst)) rmSync(tmp, { recursive: true, force: true });
  else renameSync(tmp, dst);
};

const owner = (path: string) => Number(readFileOrEmpty(`${path}.lock`) || 0);

/** Takes the unit at `path` for this process, unless a live one holds it; a dead holder's lock is taken over. */
export const claim = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  for (let n = 0; n < 2; n++) {
    try {
      const fd = openSync(`${path}.lock`, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      if (isLockedByOtherProcess(path)) return false;
      rmSync(`${path}.lock`, { force: true });
    }
  }
  return false;
};

export const release = (path: string) => {
  if (owner(path) === process.pid) rmSync(`${path}.lock`, { force: true });
};

/**
 * Removes the sandbox containers (`agentgraph-<12 hex>`) that mount anything under `dir`, the unit this process holds, so
 * a killed run's containers never outlive it; every other container is left alone. Answers the names removed.
 */
export const removeSandboxContainersMountingDir = (dir: string) => {
  const roots = [dir, ...(existsSync(dir) ? [realpathSync(dir)] : [])];
  const names = (
    spawnSync('docker', ['ps', '--filter', 'name=agentgraph-', '--format', '{{.Names}}'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).stdout ?? ''
  )
    .split('\n')
    .filter(n => /^agentgraph-[0-9a-f]{12}$/.test(n));
  if (!names.length) return [];
  const mounts = spawnSync('docker', ['inspect', '-f', '{{.Name}}{{range .Mounts}}\t{{.Source}}{{end}}', ...names], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const stray = (mounts.stdout ?? '').split('\n').flatMap(line => {
    const [name = '', ...sources] = line.split('\t');
    return sources.some(s => roots.some(r => s === r || s.startsWith(`${r}/`))) ? [name.replace(/^\//, '')] : [];
  });
  for (const name of stray) spawnSync('docker', ['rm', '-f', name], { timeout: 60_000 });
  return stray;
};

/** The host URL of the model proxy's liveness check, from `AGENTGRAPH_PROXY_URL`. */
export const probeUrl = (proxy = process.env.AGENTGRAPH_PROXY_URL ?? 'http://gateway:4000/v1') => {
  if (process.env.BENCH_PROXY_PROBE) return process.env.BENCH_PROXY_PROBE;
  const first = Object.values(parseModelUrls(proxy)).find(at => URL.canParse(at));
  if (!first) return undefined;
  const url = new URL(first);
  if (url.hostname === 'gateway') url.hostname = '127.0.0.1';
  url.pathname = '/health/liveliness';
  return url.href;
};

/**
 * Why runs cannot work now, when they cannot: the proxy, docker or, with `net`, the package registry is out, or
 * `disk` stays low after a sweep.
 */
export const down = async (net = false, disk?: Disk): Promise<string | undefined> => {
  const reach = (url: string) =>
    fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) }).then(
      r => r.status < 500,
      () => false
    );
  const probe = probeUrl();
  if (probe && !(await reach(probe))) return `model proxy unreachable at ${probe}`;
  if (spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 }).status !== 0)
    return 'docker unreachable';
  if (net && !(await reach('https://registry.npmjs.org/'))) return 'network unreachable';
  if (disk)
    return ensureFreeDisk(disk).then(
      () => undefined,
      (e: Error) => e.message
    );
  return undefined;
};

/** Waits while `down()` has a reason, logging each wait and the recovery; backs off from 15 s to 5 min. */
export const waitWhileServicesDown = async (
  log: (e: object) => void,
  net = false,
  check = down,
  pause: (ms: number) => Promise<unknown> = sleep
) => {
  let waited = false;
  for (let wait = 15_000; ; wait = Math.min(wait * 2, 300_000)) {
    const why = await check(net);
    if (!why) return waited && log({ event: 'resume' });
    log({ event: 'wait', why, retryIn: wait / 1000 });
    waited = true;
    await pause(wait);
  }
};

/** Counts wall time the process missed, as when the machine slept, in gaps over a minute between 10 s ticks. */
export const clock = () => {
  let last = Date.now();
  let missed = 0;
  const tick = setInterval(() => {
    const gap = Date.now() - last;
    if (gap > 60_000) missed += gap - 10_000;
    last = Date.now();
  }, 10_000);
  tick.unref();
  return {
    missed: () => missed,
    stop: () => clearInterval(tick),
  };
};

const children = new Set<ChildProcess>();

export const startChildProcess = (command: string, args: string[], options: SpawnOptions) => {
  const child = spawn(command, args, { ...options, detached: true });
  children.add(child);
  child.on('error', () => children.delete(child));
  child.on('close', () => children.delete(child));
  return child;
};

/**
 * Ends every child `startChildProcess` started, runs `stop` once on SIGINT, SIGTERM or SIGHUP, then exits; a pause is
 * a stop and a later rerun resumes.
 */
export const onStop = (stop: (signal: string) => void) => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(signal, () => {
      for (const child of children)
        try {
          process.kill(-Number(child.pid), 'SIGTERM');
        } catch {}
      try {
        stop(signal);
      } finally {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    });
};

/** The `BENCH_*` settings of this process that shape a run's results; `BENCH_FRESH` is a one-off and left out. */
export const readBenchResultEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).flatMap(([k, v]) =>
      k.startsWith('BENCH_') && k !== 'BENCH_FRESH' && v ? [[k, v]] : []
    )
  );

/**
 * The settings a run started with, kept in `file` so a restart needs none of them: a given value is recorded, a
 * missing one comes back from the record, `defaults` fill what neither has. A value that differs from the record, or
 * a recorded path that is gone, stops the run; edit `file` to change one on purpose.
 */
export const ensureRunSettingsPinned = (
  file: string,
  given: Record<string, string | undefined>,
  defaults: Record<string, string> = {}
) => {
  const was = JSON.parse(readFileOrEmpty(file) || '{}') as Record<string, string>;
  const env = { ...defaults, ...was };
  for (const [k, v] of Object.entries(given)) {
    if (v === undefined) continue;
    if (was[k] !== undefined && was[k] !== v)
      throw new Error(`${k} is ${v}, but this run started with ${was[k]}: unset it to resume, or edit ${file}`);
    env[k] = v;
  }
  const gone = Object.entries(env).flatMap(([k, v]) =>
    v.startsWith('/') ? v.split(':').flatMap(p => (existsSync(p) ? [] : [`${k} ${p}`])) : []
  );
  if (gone.length) throw new Error(`cannot resume, recorded in ${file} but missing: ${gone.join(', ')}`);
  writeFileAtomic(file, env);
  return env;
};
