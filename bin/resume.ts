import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Disk, ensureFreeDisk } from '../src/disk.ts';
import { parseModelUrls } from '../src/harnesses.ts';
import { isLockedByOtherProcess } from '../src/owner.ts';
import { readRecordSync } from '../src/store.ts';

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

export const parseJsonl = <T = Record<string, unknown>>(text: string): T[] => {
  const skipped: string[] = [];
  const rows = text.split('\n').flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch (e) {
      skipped.push(`line ${i + 1}: ${String(e)}`);
      return [];
    }
  });
  if (skipped.length) console.warn(`${skipped.length} skipped invalid JSONL rows: ${skipped.join('; ')}`);
  return rows;
};

export const readJsonl = <T = Record<string, unknown>>(path: string) => parseJsonl<T>(readRecordSync(path));

const owner = (path: string) => Number(readFileOrEmpty(`${path}.lock`) || 0);

export const claim = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  for (let n = 0; n < 2; n++) {
    try {
      const fd = openSync(`${path}.lock`, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (isLockedByOtherProcess(path)) return false;
      rmSync(`${path}.lock`, { force: true });
    }
  }
  return false;
};

export const release = (path: string) => {
  if (owner(path) === process.pid) rmSync(`${path}.lock`, { force: true });
};

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

export const getHostProxyUrl = (proxy = process.env.AGENTGRAPH_PROXY_URL ?? 'http://gateway:4000/v1') => {
  const first = Object.values(parseModelUrls(proxy)).find(at => URL.canParse(at));
  if (!first) return undefined;
  const url = new URL(first);
  if (url.hostname === 'gateway') url.hostname = '127.0.0.1';
  return url;
};

export const probeUrl = (proxy?: string) => {
  if (process.env.BENCH_PROXY_PROBE) return process.env.BENCH_PROXY_PROBE;
  const url = getHostProxyUrl(proxy);
  if (!url) return undefined;
  url.pathname = '/health/liveliness';
  return url.href;
};

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
