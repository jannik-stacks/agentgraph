import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';

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
