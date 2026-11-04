import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { leftovers, marked, startTime } from './setup/global.ts';

const log = process.env.AGENTGRAPH_TEST_PROCESSES!;
const ours = (pid: number) => marked(pid, log);
const anyone = () => true;
const proc = (pid: number, pgid: number, started: string) => ({ pid, pgid, started, command: `p${pid}` });

const idle = `'${process.execPath}' -e 'setTimeout(() => {}, 30000)'`;

const orphan = async (prefix = '') => {
  const leader = spawn('sh', ['-c', `${prefix}${idle} & echo $!`], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let out = '';
  leader.stdout.on('data', chunk => (out += chunk));
  await new Promise(resolve => leader.once('exit', resolve));
  return { leader: leader.pid!, child: Number(out) };
};

describe('test process teardown', () => {
  it('leaves a recorded pid alone once a foreign process holds it', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const pid = child.pid!;
      const started = startTime(pid)!;
      expect(started).toBeTruthy();
      expect(leftovers(new Map([[pid, started]]), ours).map(p => p.pid)).toEqual([pid]);
      expect(leftovers(new Map([[pid, 'Mon Jan  1 00:00:00 2001']]), ours)).toEqual([]);
    } finally {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
  });

  it('counts a group only while its leader is ours or gone', () => {
    const spawned = new Map([[100, 'ours']]);
    expect(leftovers(spawned, anyone, [proc(100, 100, 'ours'), proc(101, 100, 'later')]).map(p => p.pid)).toEqual([
      100, 101,
    ]);
    expect(leftovers(spawned, anyone, [proc(101, 100, 'later')]).map(p => p.pid)).toEqual([101]);
    expect(leftovers(spawned, anyone, [proc(100, 100, 'foreign'), proc(101, 100, 'later')])).toEqual([]);
  });

  it('only owns a process that carries the run marker and reports one it cannot read', () => {
    const spawned = new Map([[100, '-']]);
    const running = [proc(101, 100, 'later')];
    expect(leftovers(spawned, () => false, running)).toEqual([]);
    expect(leftovers(spawned, () => undefined, running)).toEqual([{ ...running[0], owned: false }]);
    expect(leftovers(spawned, () => true, running)).toEqual([{ ...running[0], owned: true }]);
  });

  it('owns an orphaned grandchild but not a stranger in a reused group', async () => {
    const real = await orphan();
    const stranger = await orphan('env -u AGENTGRAPH_TEST_PROCESSES ');
    try {
      expect(leftovers(new Map([[real.leader, '-']]), ours)).toMatchObject([{ pid: real.child, owned: true }]);
      expect(leftovers(new Map([[stranger.leader, '-']]), ours)).toEqual([]);
      expect(marked(real.child, `${log}.other`)).toBe(false);
    } finally {
      for (const pid of [real.child, stranger.child])
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
    }
  });
});
