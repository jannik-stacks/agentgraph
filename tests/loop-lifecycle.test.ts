import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { stringify } from 'yaml';
import { ensureInstance } from '../src/instance.ts';
import { createLoopLock, findLoopLock, readLoopHolder } from '../src/owner.ts';
import { seeded } from './fixtures.ts';
import { git, tmp } from './kit.ts';
import { removeAfter } from './world.ts';

const cli = join(import.meta.dirname, '../bin/run.ts');
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AGENTGRAPH_STATE;
  process.env.AGENTGRAPH_STATE = tmp('state');
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENTGRAPH_STATE;
  else process.env.AGENTGRAPH_STATE = saved;
});

const makeLoops = async (names: string[], shared = false) => {
  const world = seeded('loop-lifecycle', { 'README.md': 'hello' });
  removeAfter(world.root);
  const root = join(world.root, 'instances');
  const env = join(world.root, 'model.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_EVERY=60\n');
  const instances = [];
  for (const [n, name] of names.entries()) {
    const checkout = shared || n === 0 ? world.seed : join(world.root, `checkout-${name}`);
    if (checkout !== world.seed) git(world.root, 'clone', '-q', world.seed, checkout);
    const graph = join(world.root, `graph-${name}`);
    const ready = join(world.root, `ready-${name}`);
    mkdirSync(join(graph, 'plugins'), { recursive: true });
    writeFileSync(join(graph, 'settings.yaml'), '{}');
    writeFileSync(
      join(graph, 'plugins/ready.ts'),
      `
import { writeFileSync } from 'node:fs';
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'ready', tracker: host => { const setup = folder.tracker(host); return { ...setup,
layer: (trust, as) => { writeFileSync(${JSON.stringify(ready)}, 'ready'); return setup.layer(trust, as); }
}; } };`
    );
    const instance = await ensureInstance(root, name, checkout);
    writeFileSync(
      join(instance.dir, 'instance.yaml'),
      stringify({
        checkout,
        base: 'main',
        owner: 'owner',
        exported: {},
        loop: true,
        graph,
        env,
        provider: 'anthropic',
        tracker: 'ready',
      })
    );
    instances.push({ ...instance, ready });
  }
  const options = {
    cwd: world.root,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: '',
      AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
      AGENTGRAPH_RUNNER: 'box',
      AGENTGRAPH_SANDBOX_URL: 'http://unused',
    },
  };
  const agi = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, '--data', root], { ...options, encoding: 'utf8' });
  const spawnAgi = (...args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args, '--data', root], { ...options, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const closed = new Promise<{ code: number | null; output: string }>(done =>
      child.once('close', code => done({ code, output }))
    );
    return { child, output: () => output, closed };
  };
  return { root, instances, agi, spawnAgi };
};

const stopAfter = (child: ChildProcess) =>
  onTestFinished(() => void (child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')));

it('takes over a lock whose holder exited on this host, even with a fresh heartbeat', async () => {
  const w = await makeLoops(['stale']);
  const owner = '0123456789ab';
  mkdirSync(join(process.env.AGENTGRAPH_STATE!, 'owners'), { recursive: true });
  writeFileSync(join(process.env.AGENTGRAPH_STATE!, 'owners', owner), '');
  const path = findLoopLock(w.instances[0]!.checkout);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${spawnSync('true').pid}:${owner}:${hostname()}:${randomUUID()}`);
  const result = w.agi('loop', '--once', '--instance', 'stale');
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('already loops')]);
  expect(existsSync(path)).toBe(false);
});

it('refuses a second loop on one checkout, from another instance or the same process', async () => {
  const w = await makeLoops(['first', 'second'], true);
  const lock = await createLoopLock(w.instances[0]!.checkout);
  try {
    const refused = w.agi('loop', '--once', '--instance', 'second');
    expect([refused.status, refused.stderr.trim()]).toEqual([
      1,
      `pid ${process.pid} already loops on ${w.instances[0]!.checkout}; agi stop --instance second --data ${w.root}, or agi restart --instance second --data ${w.root}`,
    ]);
  } finally {
    await lock.release();
  }
  const both = w.agi('loop', '--once', '--instance', 'first', '--instance', 'second');
  expect([both.status, both.stderr]).toEqual([
    1,
    expect.stringMatching(/(first|second): stopped: pid \d+ already loops on/),
  ]);
});

it('waits for a stopping loop to release the checkout, then starts', async () => {
  const w = await makeLoops(['wait']);
  const lock = await createLoopLock(w.instances[0]!.checkout);
  await lock.stop();
  const loop = w.spawnAgi('loop', '--once', '--instance', 'wait');
  stopAfter(loop.child);
  await vi.waitFor(
    () => expect(loop.output()).toContain(`waiting for the stopping loop (pid ${process.pid}) to exit`),
    {
      timeout: 20_000,
    }
  );
  expect(existsSync(w.instances[0]!.ready)).toBe(false);
  await lock.release();
  expect((await loop.closed).code).toBe(0);
  expect(existsSync(w.instances[0]!.ready)).toBe(true);
});

it('stops a loop and returns once it released the checkout', async () => {
  const w = await makeLoops(['run']);
  const loop = w.spawnAgi('loop', '--instance', 'run');
  stopAfter(loop.child);
  await vi.waitFor(() => expect(existsSync(w.instances[0]!.ready)).toBe(true), { timeout: 20_000 });
  expect(readLoopHolder(w.instances[0]!.checkout)).toEqual({ pid: loop.child.pid, host: hostname(), stopping: false });
  const stop = w.spawnAgi('stop', '--instance', 'run');
  const stopped = await stop.closed;
  expect([stopped.code, stopped.output, readLoopHolder(w.instances[0]!.checkout)]).toEqual([
    0,
    expect.stringContaining(`stopping pid ${loop.child.pid} (run)`),
    undefined,
  ]);
  expect((await loop.closed).code).toBe(0);
  const again = w.agi('stop', '--instance', 'run');
  expect([again.status, again.stdout]).toEqual([0, 'no loop on run\n']);
});

it('detaches a loop with a default log, restarts it and stops every loop', async () => {
  const w = await makeLoops(['left', 'right']);
  const started = w.agi('loop', '--detach', '--instance', 'left', '--instance', 'right');
  const pattern = /^loop pid (\d+) on left, right; log (.+loop-left\+right-\d{4}-\d\d-\d\d\.log)$/m;
  expect([started.status, started.stdout]).toEqual([0, expect.stringMatching(pattern)]);
  const [, pid, log] = pattern.exec(started.stdout)!;
  try {
    expect(w.instances.map(i => readLoopHolder(i.checkout)?.pid)).toEqual([Number(pid), Number(pid)]);
    const partial = w.agi('stop', '--instance', 'left');
    expect([partial.status, partial.stderr]).toEqual([
      2,
      expect.stringContaining('agi stop --instance left --instance right'),
    ]);
    const restarted = w.agi('restart', '--instance', 'left', '--instance', 'right');
    expect([restarted.status, restarted.stdout]).toEqual([
      0,
      expect.stringMatching(new RegExp(`^stopping pid ${pid} \\(left, right\\)[^]*${pattern.source}`, 'm')),
    ]);
    const next = Number(pattern.exec(restarted.stdout)![1]);
    expect(next).not.toBe(Number(pid));
    expect(w.instances.map(i => readLoopHolder(i.checkout)?.pid)).toEqual([next, next]);
  } finally {
    const stopped = w.agi('stop');
    expect([stopped.status, w.instances.map(i => readLoopHolder(i.checkout))]).toEqual([0, [undefined, undefined]]);
  }
  expect(readFileSync(log!, 'utf8')).toContain('left: ');
  const fresh = join(w.root, '..', 'fresh');
  git(w.root, 'clone', '-q', w.instances[0]!.checkout, fresh);
  expect((await ensureInstance(w.root, undefined, fresh)).made).toBe(true);
});
