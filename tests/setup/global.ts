import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Proc = { pid: number; pgid: number; started: string; command: string };

const ps = (args: string[], columns = 'pid=,pgid=,stat=,lstart=,command=') =>
  execFileSync('ps', ['-ww', '-o', columns, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const parse = (out: string): Proc[] =>
  out.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line);
    return m && !m[3]!.startsWith('Z')
      ? [{ pid: Number(m[1]), pgid: Number(m[2]), started: m[4]!, command: m[5]! }]
      : [];
  });

// UNEXPECTED: a later process may reuse a pid, so its start time tells them apart.
export const startTime = (pid: number): string | undefined => {
  try {
    return parse(ps(['-p', String(pid)]))[0]?.started;
  } catch {
    return undefined;
  }
};

export const marked = (pid: number, log: string): boolean | undefined => {
  let env: string;
  try {
    if (ps(['-p', String(pid)], 'uid=').trim() !== String(process.getuid?.())) return false;
    if (process.platform === 'linux') env = readFileSync(`/proc/${pid}/environ`, 'utf8');
    else {
      env = ps(['-E', '-p', String(pid)], 'command=');
      if (env === ps(['-p', String(pid)], 'command=')) return undefined;
    }
  } catch {
    return undefined;
  }
  return env.split(/[\s\0]/).includes(`AGENTGRAPH_TEST_PROCESSES=${log}`);
};

export const leftovers = (
  spawned: Map<number, string>,
  ours: (pid: number) => boolean | undefined,
  running: Proc[] = parse(ps(['-A']))
) => {
  const byPid = new Map(running.map(p => [p.pid, p]));
  const recorded = (pid: number) => spawned.has(pid) && byPid.get(pid)?.started === spawned.get(pid);
  const group = (pgid: number) => spawned.has(pgid) && (!byPid.has(pgid) || recorded(pgid));
  return running
    .filter(p => p.pid !== process.pid && (recorded(p.pid) || group(p.pgid)))
    .flatMap(p => {
      const owned = ours(p.pid);
      return owned === false ? [] : [{ ...p, owned: owned === true }];
    });
};

export default () => {
  // UNEXPECTED: oxlint and oxfmt read every ancestor directory, so a crowded system TMPDIR slows them by seconds.
  const dir = mkdtempSync('/tmp/agentgraph-test-');
  const log = join(dir, 'pids');
  writeFileSync(log, '');
  mkdirSync(join(dir, 'tmp'));
  process.env.AGENTGRAPH_TEST_PROCESSES = log;
  process.env.TMPDIR = join(dir, 'tmp');

  return async () => {
    const spawned = new Map(
      readFileSync(log, 'utf8')
        .split('\n')
        .flatMap(line => {
          const m = /^(\d+) (.+)$/.exec(line);
          return m ? [[Number(m[1]), m[2]!] as const] : [];
        })
    );
    const ours = (pid: number) => marked(pid, log);
    let left = leftovers(spawned, ours);
    for (let i = 0; i < 40 && left.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      left = leftovers(spawned, ours);
    }
    for (const p of left.filter(p => p.owned))
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    if (!left.length) return;
    throw new Error(
      `tests left ${left.length} process(es) running:\n${left
        .map(p => `  ${p.pid} ${p.command}${p.owned ? ' (killed)' : ' (environment unreadable, not killed)'}`)
        .join('\n')}`
    );
  };
};
