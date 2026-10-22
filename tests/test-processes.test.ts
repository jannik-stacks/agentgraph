import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { leftovers, startTime } from './setup/global.ts';

const proc = (pid: number, pgid: number, started: string) => ({ pid, pgid, started, command: `p${pid}` });

describe('test process teardown', () => {
  it('leaves a recorded pid alone once a foreign process holds it', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const pid = child.pid!;
      const started = startTime(pid)!;
      expect(started).toBeTruthy();
      expect(leftovers(new Map([[pid, started]])).map(p => p.pid)).toEqual([pid]);
      expect(leftovers(new Map([[pid, 'Mon Jan  1 00:00:00 2001']]))).toEqual([]);
    } finally {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
  });

  it('counts a group only while its leader is ours or gone', () => {
    const spawned = new Map([[100, 'ours']]);
    expect(leftovers(spawned, [proc(100, 100, 'ours'), proc(101, 100, 'later')]).map(p => p.pid)).toEqual([100, 101]);
    expect(leftovers(spawned, [proc(101, 100, 'later')]).map(p => p.pid)).toEqual([101]);
    expect(leftovers(spawned, [proc(100, 100, 'foreign'), proc(101, 100, 'later')])).toEqual([]);
  });
});
