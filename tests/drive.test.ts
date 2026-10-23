import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodePath, runLogged, spendGuard } from '../bench/drive.ts';
import { tmp } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bench driver', () => {
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

  it('survives a log file it cannot write', async () => {
    const dir = tmp('drive');
    dirs.push(dir);
    const script = join(dir, 'job.mjs');
    writeFileSync(script, 'process.exit(0);');
    const said: string[] = [];
    const code = await runLogged([script], join(dir, 'missing', 'job.log'), process.env, m => said.push(m));
    expect(code).toBe(0);
    expect(said.join('\n')).toMatch(/ENOENT/);
  });
});

/** A usage source that answers `totals` in turn, and a clock the test moves. */
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
    expect(await guard(0, 1)).toBeUndefined();
  });

  it('stops when this run with the jobs in flight would pass the cap', async () => {
    const f = fake(100, 104);
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    f.clock.now = 61_000;
    expect(await guard(3, 4)).toMatch(/run spend \$4\.00 .* would pass \$5/);
  });

  it('takes no new job when a reading fails after a good one', async () => {
    const f = fake(100, new Error('timeout'));
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    f.clock.now = 61_000;
    expect(await guard(0, 0)).toMatch(/OpenRouter usage unreadable: Error: timeout/);
  });

  it('takes no new job on a reading older than two minutes', async () => {
    const f = fake(100, 100);
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    f.clock.now = 61_000;
    const slow = f.usage;
    const late = async () => {
      const total = await slow();
      f.clock.now += 120_001;
      return total;
    };
    const stale = await spendGuard(5, 0.3, late, f.at);
    expect(await guard(0, 0)).toBeUndefined();
    expect(await stale(0, 0)).toMatch(/OpenRouter usage is \d+s old/);
  });

  it('takes no new job without a baseline', async () => {
    const f = fake(new Error('down'), 100);
    const guard = await spendGuard(5, 0.3, f.usage, f.at);
    expect(await guard(0, 0)).toMatch(/unreadable: Error: down/);
  });
});
