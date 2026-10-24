/**
 * Crash-safe files and units for long bench and tune runs. A result file is written whole or not at all, a log line
 * that a crash cut off is skipped, a unit a dead process left half done goes to an attic beside it, and a run waits
 * while the model proxy or docker is down.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
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
import { uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Disk, ensureFreeDisk } from '../src/disk.ts';
import { isPidRunning } from '../src/env.ts';

const text = (v: unknown) => (typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);

/** Writes `path` through a synced temp file and a rename, so a reader sees the old file or the whole new one. */
export const write = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text(v));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};

/** Appends one JSON line, first ending a line a crash left open. */
export const append = (path: string, v: unknown) => {
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

/** The JSON lines of `path`, skipping any a crash cut off. */
export const jsonl = <T = Record<string, unknown>>(path: string): T[] =>
  (existsSync(path) ? readFileSync(path, 'utf8') : '').split('\n').flatMap(l => {
    try {
      return l ? [JSON.parse(l) as T] : [];
    } catch {
      return [];
    }
  });

/**
 * Moves `path` into `.attic/` beside it, keeping its records; answers where it went. Its checkouts and scoring tree
 * are deleted first, since a rerun makes them again.
 */
export const attic = (path: string) => {
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
export const publish = (src: string, dst: string, filter?: (path: string) => boolean) => {
  const tmp = `${dst}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(src, tmp, { recursive: true, ...(filter && { filter }) });
  if (existsSync(dst)) rmSync(tmp, { recursive: true, force: true });
  else renameSync(tmp, dst);
};

const owner = (path: string) => Number((existsSync(`${path}.lock`) && readFileSync(`${path}.lock`, 'utf8')) || 0);

/** Since when this machine runs, so a lock from before a reboot is stale even when its pid was reused. */
const booted = () => Date.now() - uptime() * 1000;
const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** Whether a live process other than this one holds the unit at `path`. */
export const busy = (path: string) => {
  const pid = owner(path);
  return pid > 0 && pid !== process.pid && isPidRunning(pid) && mtime(`${path}.lock`) > booted() - 60_000;
};

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
      if (busy(path)) return false;
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
export const sweep = (dir: string) => {
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
export const probeUrl = (proxy = process.env.AGENTGRAPH_PROXY_URL ?? 'http://litellm:4000/v1') => {
  const url = new URL(proxy);
  if (url.hostname === 'litellm') url.hostname = '127.0.0.1';
  url.pathname = '/health/liveliness';
  return process.env.BENCH_PROXY_PROBE ?? url.href;
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
  if (!(await reach(probeUrl()))) return `model proxy unreachable at ${probeUrl()}`;
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
export const settle = async (
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

/** Runs `stop` once on SIGINT, SIGTERM or SIGHUP, then exits; a pause is a stop and a later rerun resumes. */
export const onStop = (stop: (signal: string) => void) => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(signal, () => {
      try {
        stop(signal);
      } finally {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    });
};

/** The `BENCH_*` settings of this process that shape a run's results; `BENCH_FRESH` is a one-off and left out. */
export const benchEnv = () =>
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
export const pin = (file: string, given: Record<string, string | undefined>, defaults: Record<string, string> = {}) => {
  const was = JSON.parse(existsSync(file) ? readFileSync(file, 'utf8') : '{}') as Record<string, string>;
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
  write(file, env);
  return env;
};
