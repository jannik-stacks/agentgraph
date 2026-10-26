import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export const readStateDir = () => process.env.AGENTGRAPH_STATE || join(homedir(), '.cache', 'agentgraph');
const heartbeats = () => join(readStateDir(), 'owners');

export const ownerId = randomBytes(6).toString('hex');
let beating: NodeJS.Timeout | undefined;

const beat = () => {
  try {
    mkdirSync(heartbeats(), { recursive: true });
    writeFileSync(join(heartbeats(), ownerId), '');
  } catch {}
};

export const startHeartbeat = () => {
  beat();
  if (!beating) (beating = setInterval(beat, 30_000)).unref();
  return `${process.pid}:${ownerId}`;
};

/** @internal */
export const isPidRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const bootedAt = () => Date.now() - uptime() * 1000;

export const isOwnerRunning = (label: string, writtenAt = Date.now()) => {
  const [pid, owner] = label.split(':');
  if (owner === ownerId) return true;
  try {
    if (owner && Date.now() - statSync(join(heartbeats(), owner)).mtimeMs < 120_000) return true;
  } catch {}
  return writtenAt > bootedAt() - 60_000 && Number(pid) > 0 && isPidRunning(Number(pid));
};

export const isLockedByOtherProcess = (path: string) => {
  try {
    const pid = readFileSync(`${path}.lock`, 'utf8').trim();
    return Number(pid) !== process.pid && isOwnerRunning(pid, statSync(`${path}.lock`).mtimeMs);
  } catch {
    return false;
  }
};

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const release = (path: string, holder: string) => async () => {
  if ((await readFile(path, 'utf8').catch(() => undefined)) === holder) await rm(path, { force: true });
};
const exists = (e: unknown) => (e as NodeJS.ErrnoException).code === 'EEXIST';
const succeed = async (path: string, before: string, candidate: string) => {
  let claim = `${path}.${createHash('sha256').update(before).digest('hex')}.next`;
  for (;;) {
    try {
      await link(candidate, claim);
      break;
    } catch (e) {
      if (!exists(e)) throw e;
      const other = await readFile(claim, 'utf8').catch(e => (missing(e) ? undefined : Promise.reject(e)));
      if (other === undefined || isOwnerRunning(other)) return false;
      claim = `${path}.${createHash('sha256').update(`${claim}\0${other}`).digest('hex')}.next`;
    }
  }
  try {
    if ((await readFile(path, 'utf8').catch(() => undefined)) !== before) return false;
    await rename(candidate, path);
    return true;
  } finally {
    await rm(claim, { force: true });
  }
};
export const createLock = async (path: string) => {
  const holder = `${startHeartbeat()}:${randomUUID()}`;
  const candidate = `${path}.${randomUUID()}`;
  await writeFile(candidate, holder, { flag: 'wx' });
  try {
    for (let tries = 0; tries < 2; tries++) {
      try {
        await link(candidate, path);
        return release(path, holder);
      } catch (e) {
        if (!exists(e)) throw e;
        const before = await readFile(path, 'utf8').catch(e => (missing(e) ? undefined : Promise.reject(e)));
        if (before === undefined) continue;
        if (before ? isOwnerRunning(before) : Date.now() - (await stat(path)).mtimeMs < 120_000)
          throw new Error(`held by ${before || 'an initializing owner'}`, { cause: e });
        if (await succeed(path, before, candidate)) return release(path, holder);
        break;
      }
    }
    throw new Error('lock contended');
  } finally {
    await rm(candidate, { force: true });
  }
};

export const waitForLock = async (name: string) => {
  const path = join(readStateDir(), 'locks', `${name}.lock`);
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    const taken = await createLock(path).catch((e: NodeJS.ErrnoException) =>
      e.code === undefined ? undefined : Promise.reject(e)
    );
    if (taken) return taken;
    await setTimeout(500);
  }
};
