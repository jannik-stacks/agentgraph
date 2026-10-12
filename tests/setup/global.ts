import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Proc = { pid: number; pgid: number; command: string };

const processes = (): Proc[] =>
  execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return m && !m[3]!.startsWith('Z') ? [{ pid: Number(m[1]), pgid: Number(m[2]), command: m[4]! }] : [];
    });

/** Running processes that are in `spawned`, or in a process group led by one of them. */
export const leftovers = (spawned: Set<number>) =>
  processes().filter(p => p.pid !== process.pid && (spawned.has(p.pid) || spawned.has(p.pgid)));

/** Records every process the tests spawn and fails the run if any of them outlives it. */
export default () => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-test-processes-'));
  const log = join(dir, 'pids');
  writeFileSync(log, '');
  process.env.BOTHUB_TEST_PROCESSES = log;

  return async () => {
    const spawned = new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number));
    rmSync(dir, { recursive: true, force: true });
    let left = leftovers(spawned);
    for (let i = 0; i < 40 && left.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      left = leftovers(spawned);
    }
    if (!left.length) return;
    for (const p of left)
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {}
    throw new Error(
      `tests left ${left.length} process(es) running (now killed):\n${left.map(p => `  ${p.pid} ${p.command}`).join('\n')}`
    );
  };
};
