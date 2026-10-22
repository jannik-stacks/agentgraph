import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Proc = { pid: number; pgid: number; started: string; command: string };

const ps = (args: string[]) =>
  execFileSync('ps', ['-o', 'pid=,pgid=,stat=,lstart=,command=', ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const parse = (out: string): Proc[] =>
  out.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
    return m && !m[3]!.startsWith('Z') ? [{ pid: Number(m[1]), pgid: Number(m[2]), started: m[4]!, command: m[5]! }] : [];
  });

/** Start time of a running process, so a later process that reuses its pid is not mistaken for it. */
export const startTime = (pid: number): string | undefined => {
  try {
    return parse(ps(['-p', String(pid)]))[0]?.started;
  } catch {
    return undefined;
  }
};

/** Running processes the tests spawned (same pid and start time), or in a process group one of them led. */
export const leftovers = (spawned: Map<number, string>, running: Proc[] = parse(ps(['-A']))) => {
  const byPid = new Map(running.map(p => [p.pid, p]));
  const ours = (pid: number) => spawned.has(pid) && byPid.get(pid)?.started === spawned.get(pid);
  const ourGroup = (pgid: number) => spawned.has(pgid) && (!byPid.has(pgid) || ours(pgid));
  return running.filter(p => p.pid !== process.pid && (ours(p.pid) || ourGroup(p.pgid)));
};

/** Records every process the tests spawn and fails the run if any of them outlives it. */
export default () => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-test-processes-'));
  const log = join(dir, 'pids');
  writeFileSync(log, '');
  process.env.BOTHUB_TEST_PROCESSES = log;

  return async () => {
    const spawned = new Map(
      readFileSync(log, 'utf8')
        .split('\n')
        .flatMap(line => {
          const m = /^(\d+) (.+)$/.exec(line);
          return m ? [[Number(m[1]), m[2]!] as const] : [];
        })
    );
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
