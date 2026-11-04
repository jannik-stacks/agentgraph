import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendBenchResults, makeBenchInput, readSlotRun } from '../bin/bench.ts';
import { nodePath, runLogged, runQueue, spendGuard } from '../bench/start-runs.ts';
import { type BenchInput, getBenchSlot, isBenchRunDone } from '../bench/runs.ts';
import { writeImportedRun } from '../src/instance.ts';
import { git, tmp } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('start-runs helpers', () => {
  it('finds node on PATH at each spawn', () => {
    const node = nodePath();
    expect(node.startsWith('/')).toBe(true);
    expect(existsSync(node)).toBe(true);
  });

  it('logs a job to its file and returns its exit code', async () => {
    const dir = tmp('drive');
    dirs.push(dir);
    const script = join(dir, 'job.mjs');
    writeFileSync(script, "console.log('out'); console.error('err'); process.exit(3);");
    const log = join(dir, 'job.log');
    expect(await runLogged([script, 'score', 'case'], log, process.env)).toBe(3);
    expect(readFileSync(log, 'utf8')).toMatch(/### .* score case\nout\nerr\n|### .* score case\nerr\nout\n/);
  });

  it('reports a failed log write as a failed job', async () => {
    const dir = tmp('drive');
    dirs.push(dir);
    const script = join(dir, 'job.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);');
    const said: string[] = [];
    const code = await runLogged([script], join(dir, 'missing', 'job.log'), process.env, m => said.push(m));
    expect(code).toBe(1);
    expect(said.join('\n')).toMatch(/ENOENT/);
  });
});

const fake = (...totals: (number | Error)[]) => {
  const clock = { now: 0 };
  const usage = async () => {
    const next = totals.length > 1 ? totals.shift()! : totals[0]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { clock, usage, at: () => clock.now };
};

describe('spend guard', () => {
  it('counts only this run, not what the account spent before', async () => {
    const f = fake(100, 101);
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    f.clock.now = 61_000;
    expect(await guard.check(0)).toBeUndefined();
  });

  it('stops when this run with the jobs in flight would pass the cap', async () => {
    const f = fake(100, 104);
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    for (let n = 0; n < 4; n++) guard.finished();
    f.clock.now = 61_000;
    expect(await guard.check(3)).toMatch(/run spend \$4\.00 with 3 in flight at ~\$1\.00 a job would pass \$5/);
  });

  it('estimates a job from the jobs finished in this run', async () => {
    const f = fake(100, 103);
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    f.clock.now = 61_000;
    expect(await guard.check(0)).toBeUndefined();
    guard.finished();
    expect(await guard.check(0)).toMatch(/at ~\$3\.00 a job/);
  });

  it('takes no new job when a reading fails after a good one', async () => {
    const f = fake(100, new Error('timeout'));
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    f.clock.now = 61_000;
    expect(await guard.check(0)).toMatch(/OpenRouter usage unreadable: Error: timeout/);
  });

  it('takes no new job on a reading older than two minutes', async () => {
    const f = fake(100);
    let slow = false;
    const usage = async () => {
      const total = await f.usage();
      if (slow) f.clock.now += 120_001;
      return total;
    };
    const guard = await spendGuard(5, 0.3, usage, f.at);
    f.clock.now = 61_000;
    slow = true;
    expect(await guard.check(0)).toMatch(/OpenRouter usage is 120s old/);
  });

  it('takes no new job without a baseline', async () => {
    const f = fake(new Error('down'), 100);
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    expect(await guard.check(0)).toMatch(/unreadable: Error: down/);
  });
});

const makeSet = () => {
  const root = tmp('start-runs');
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const set = join(root, 'set');
  mkdirSync(join(set, 'cases', 'demo'), { recursive: true });
  writeFileSync(join(set, 'set.json'), JSON.stringify({ cases: [{ id: 'demo', repo: 'me/demo' }] }));
  return { repo, set, base: git(repo, 'rev-parse', 'HEAD') };
};

const addRun = async (s: ReturnType<typeof makeSet>, input: BenchInput, ...checks: object[]) => {
  const at = join(getBenchSlot(s.set, input), '1');
  git(s.repo, 'init', '-q', '--bare', join(at, 'tracker', 'origin.git'));
  await writeImportedRun({ checkout: s.repo, tracker: join(at, 'tracker'), data: join(at, 'data') }, s.base, {
    version: 't',
    from: s.base,
    input,
  });
  for (const check of checks) await appendBenchResults(readSlotRun(getBenchSlot(s.set, input))!, [check as never], 't');
};

const arm = (pass: boolean) => ({ check: 'bench/arm', pass, ...(!pass && { findings: 'docker down' }) });

describe('isBenchRunDone', () => {
  const v2 = makeBenchInput({ id: 'demo', repo: 'me/demo' }, 'v2', 1, { point: 'opencode:luna' });

  it('is not done without a run or before its hidden score', async () => {
    const s = makeSet();
    expect(isBenchRunDone(s.set, v2, false)).toBe(false);
    await addRun(s, v2, arm(true), { check: 'bench/size', pass: true });
    expect(isBenchRunDone(s.set, v2, false)).toBe(false);
  });

  it('is done once scored, and when judged once it has a judge result, n/a included', async () => {
    const s = makeSet();
    await addRun(s, v2, arm(true), { check: 'bench/hidden', pass: true });
    expect(isBenchRunDone(s.set, v2, false)).toBe(true);
    expect(isBenchRunDone(s.set, v2, true)).toBe(false);
    await appendBenchResults(
      readSlotRun(getBenchSlot(s.set, v2))!,
      [{ check: 'bench/judge', pass: false, na: true, findings: 'no change to judge' }],
      't'
    );
    expect(isBenchRunDone(s.set, v2, true)).toBe(true);
  });

  it('is done when the arm failed for infra or the case is invalid', async () => {
    const s = makeSet();
    await addRun(s, v2, arm(false));
    expect(isBenchRunDone(s.set, v2, true)).toBe(true);
    const floor = makeBenchInput({ id: 'demo', repo: 'me/demo' }, 'floor', 1);
    expect(isBenchRunDone(s.set, floor, true)).toBe(false);
    await addRun(s, { case: 'demo', arm: 'human', repeat: 1 }, { check: 'bench/valid', pass: false });
    expect(isBenchRunDone(s.set, floor, true)).toBe(true);
  });
});

describe('start-runs', () => {
  const cli = join(import.meta.dirname, '../bench/start-runs.ts');
  const start = (set: string, ...args: string[]) =>
    spawnSync(process.execPath, [cli, set, '--arms', 'v2', '--repeats', '2', ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

  it('plans every run and counts the ones on disk', async () => {
    const s = makeSet();
    expect(start(s.set, '--dry').stdout).toContain('planned 2, on disk 0, starting 2');
    const done = makeBenchInput({ id: 'demo', repo: 'me/demo' }, 'v2', 2, { point: 'opencode:luna' });
    await addRun(s, done, { check: 'bench/arm', pass: false, findings: 'docker down' });
    expect(start(s.set, '--dry').stdout).toContain('planned 2, on disk 1, starting 1');
    expect(start(s.set, '--dry', '--label', 'x=y').stdout).toContain('on disk 0');
  });

  it('refuses a second start-runs on the same set', () => {
    const s = makeSet();
    writeFileSync(join(s.set, 'start-runs.lock'), String(process.pid));
    const r = start(s.set);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`another start-runs works on ${s.set} as pid ${process.pid}`);
  });
});

describe('runQueue', () => {
  it('takes each item once and never more than the parallel limit while a spend check is slow', async () => {
    let active = 0;
    let most = 0;
    const ran: number[] = [];
    const stopped = await runQueue(
      [1, 2, 3, 4, 5],
      2,
      async n => {
        active++;
        most = Math.max(most, active);
        await new Promise(r => setTimeout(r, 40));
        ran.push(n);
        active--;
      },
      () => new Promise(r => setTimeout(() => r(undefined), 10))
    );
    expect([stopped, most, ran.toSorted()]).toEqual([undefined, 2, [1, 2, 3, 4, 5]]);
  });

  it('stops taking items once the check gives a reason and lets the running ones finish', async () => {
    const ran: number[] = [];
    const answers = [undefined, undefined, 'cap'];
    const stopped = await runQueue(
      [1, 2, 3, 4],
      2,
      async n => {
        await new Promise(r => setTimeout(r, 5));
        ran.push(n);
      },
      async () => answers.shift()
    );
    expect([stopped, ran.toSorted()]).toEqual(['cap', [1, 2]]);
  });

  it('passes a failed item on to the caller', async () => {
    await expect(
      runQueue([1], 1, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});
