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
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

/** Moves `path` into `.attic/` beside it, never deleting it; answers where it went. */
export const attic = (path: string) => {
  if (!existsSync(path)) return undefined;
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

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const owner = (path: string) => Number((existsSync(`${path}.lock`) && readFileSync(`${path}.lock`, 'utf8')) || 0);

/** Whether a live process other than this one holds the unit at `path`. */
export const busy = (path: string) => {
  const pid = owner(path);
  return pid > 0 && pid !== process.pid && alive(pid);
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
 * Sandbox containers nobody drives: a `docker run` client of a `bothub-<12 hex>` container whose parent is gone (or
 * is `parent`), and such a container with no client at all. Both are stopped; other runs' containers are left alone.
 */
export const sweep = (parent = 1) => {
  const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout ?? '';
  const clients = ps.split('\n').flatMap(l => {
    const m = /^\s*(\d+)\s+(\d+)\s+docker run .*--name (bothub-[0-9a-f]{12})\b/.exec(l);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]! }] : [];
  });
  const listed = spawnSync('docker', ['ps', '--filter', 'name=bothub-', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const running = (listed.stdout ?? '').split('\n').filter(n => /^bothub-[0-9a-f]{12}$/.test(n));
  const stray = [
    ...clients.filter(c => c.ppid === 1 || c.ppid === parent).map(c => (stop(c.pid), c.name)),
    ...running.filter(n => !clients.some(c => c.name === n)),
  ];
  for (const name of new Set(stray)) spawnSync('docker', ['rm', '-f', name], { timeout: 60_000 });
  return [...new Set(stray)];
};

const stop = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
};

/** The host URL of the model proxy's liveness check, from `BOTHUB_PROXY_URL`. */
export const probeUrl = (proxy = process.env.BOTHUB_PROXY_URL ?? 'http://litellm:4000/v1') => {
  const url = new URL(proxy);
  if (url.hostname === 'litellm') url.hostname = '127.0.0.1';
  url.pathname = '/health/liveliness';
  return process.env.BENCH_PROXY_PROBE ?? url.href;
};

/** Why runs cannot work now, when they cannot: the proxy, docker or, with `net`, the package registry is out. */
export const down = async (net = false): Promise<string | undefined> => {
  const reach = (url: string) =>
    fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) }).then(
      r => r.status < 500,
      () => false
    );
  if (!(await reach(probeUrl()))) return `model proxy unreachable at ${probeUrl()}`;
  if (spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 }).status !== 0)
    return 'docker unreachable';
  if (net && !(await reach('https://registry.npmjs.org/'))) return 'network unreachable';
  return undefined;
};

export const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** Waits while `down()` has a reason, logging each wait and the recovery; backs off from 15 s to 5 min. */
export const settle = async (log: (e: object) => void, net = false, check = down, pause = sleep) => {
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
