import { spawnSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLockedByOtherProcess, isOwnerRunning, waitForLock } from '../src/owner.ts';
import { tmp } from './kit.ts';

const lock = (pid: number, at?: Date) => {
  const unit = join(tmp('owner'), 'unit');
  mkdirSync(join(unit, '..'), { recursive: true });
  writeFileSync(`${unit}.lock`, String(pid));
  if (at) utimesSync(`${unit}.lock`, at, at);
  return unit;
};

describe('isLockedByOtherProcess', () => {
  it('is locked while another running process holds it', () => {
    expect(isLockedByOtherProcess(lock(process.ppid))).toBe(true);
  });

  it('is free when the holder exited, is this process, or there is no lock', () => {
    expect(isLockedByOtherProcess(lock(spawnSync('true').pid!))).toBe(false);
    expect(isLockedByOtherProcess(lock(process.pid))).toBe(false);
    expect(isLockedByOtherProcess(join(tmp('owner'), 'none'))).toBe(false);
  });

  it('is free when the lock was written before the machine booted, even if its pid runs again', () => {
    const beforeBoot = new Date(Date.now() - uptime() * 1000 - 3_600_000);
    expect(isLockedByOtherProcess(lock(process.ppid, beforeBoot))).toBe(false);
  });
});

describe('isOwnerRunning', () => {
  it('trusts a running pid only when its label was written since boot', () => {
    expect(isOwnerRunning(String(process.ppid))).toBe(true);
    expect(isOwnerRunning(String(process.ppid), Date.now() - uptime() * 1000 - 3_600_000)).toBe(false);
  });
});

describe('waitForLock', () => {
  it('lets one holder in at a time and hands the lock over on release', async () => {
    const previous = process.env.AGENTGRAPH_STATE;
    process.env.AGENTGRAPH_STATE = tmp('state');
    const order: string[] = [];
    const hold = async (name: string) => {
      const release = await waitForLock('images');
      order.push(`${name} in`);
      await new Promise(done => setTimeout(done, 50));
      order.push(`${name} out`);
      await release();
    };
    try {
      await Promise.all([hold('a'), hold('b')]);
    } finally {
      if (previous === undefined) delete process.env.AGENTGRAPH_STATE;
      else process.env.AGENTGRAPH_STATE = previous;
    }
    expect(order).toEqual(['a in', 'a out', 'b in', 'b out']);
  });
});
