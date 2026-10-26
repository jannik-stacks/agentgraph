import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configure, readBenchDriveState } from '../bench/drive.ts';
import { readJsonl } from '../bin/resume.ts';
import { isPidRunning } from '../src/owner.ts';
import { tmp } from './kit.ts';

const driver = resolve(import.meta.dirname, '../bench/drive.ts');

const fake = `import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
export const codexUsed = () => Number(process.env.FAKE_CODEX ?? 10);
if (import.meta.main) {
  const [cmd, a, b, c] = process.argv.slice(2);
  const out = cmd === 'run' ? c : b;
  const id = basename(cmd === 'run' ? b : a);
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ cmd, arm: cmd === 'run' ? a : undefined, id }) + '\\n');
  const fail = (process.env.FAKE_FAIL ?? '').split(',');
  const at = join(out, id);
  if (cmd === 'score') {
    mkdirSync(at, { recursive: true });
    if (!existsSync(join(at, 'valid.json'))) writeFileSync(join(at, 'valid.json'), id.startsWith('bad') ? '{"invalid":"x"}' : '{}');
    for (const arm of ['v2', 'floor'])
      if (existsSync(join(at, arm, 'diff.patch'))) writeFileSync(join(at, arm, 'score.json'), '{}');
  }
  if (cmd === 'run' && !existsSync(join(at, a, 'diff.patch'))) {
    if (fail.includes('hang')) {
      const worker = fail.includes('worker') && spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(process.env.FAKE_CALLS + '.hang', String(worker ? worker.pid : process.pid));
      setInterval(() => {}, 1000);
    } else if (fail.includes(id + '/' + a)) process.exitCode = 1;
    else {
      mkdirSync(join(at, a), { recursive: true });
      writeFileSync(join(at, a, 'diff.patch'), 'd');
    }
  }
  if (cmd === 'judge' && fail.includes('judge')) process.exitCode = 1;
}
`;

const dirs: string[] = [];
const procs: ChildProcess[] = [];
const orphans: number[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  for (const pid of orphans.splice(0)) if (isPidRunning(pid)) process.kill(pid, 'SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bench = (cases = ['c1', 'c2']) => {
  const dir = tmp('bench');
  dirs.push(dir);
  mkdirSync(join(dir, 'eng/bin'), { recursive: true });
  writeFileSync(join(dir, 'eng/bin/bench.ts'), fake);
  writeFileSync(join(dir, 'set.json'), JSON.stringify({ cases: cases.map(id => ({ id, repo: 'o/r' })) }));
  return dir;
};
const settings = (dir: string) => ({
  SHA: 'abc',
  ENGINE: join(dir, 'eng'),
  POINTS: 'opencode:m',
  REPEATS: '1',
  JUDGES: 'none',
  REPOS: dir,
});

const start = (dir: string, env: Record<string, string> = {}) => {
  const child = spawn(process.execPath, [driver, 'resume', dir], {
    env: { ...process.env, NODE_OPTIONS: '', DRIVE_TICK: '50', FAKE_CALLS: join(dir, 'calls.jsonl'), ...env },
  });
  procs.push(child);
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  const exit = new Promise<{ code: number | null; signal: string | null; out: string }>(done =>
    child.on('close', (code, signal) => done({ code, signal, out }))
  );
  return { child, exit };
};
const drive = (dir: string, env: Record<string, string> = {}) => start(dir, env).exit;
const events = (dir: string) => readJsonl<{ event: string; reason?: string; job?: string }>(join(dir, 'events.jsonl'));
const calls = (dir: string) => readJsonl<{ cmd: string; arm?: string; id: string }>(join(dir, 'calls.jsonl'));
const until = async (ok: () => boolean) => {
  for (let n = 0; n < 200 && !ok(); n++) await new Promise(r => setTimeout(r, 50));
  expect(ok()).toBe(true);
};
const run = (dir: string) => join(dir, 'abc/opencode-m/r1');

describe('bench driver durability', () => {
  it('runs every job, logs it, and a resume reruns nothing finished', async () => {
    const dir = bench(['c1', 'bad1']);
    writeFileSync(join(dir, 'budget-log.jsonl'), '{"label":"start"}\n{"label":"cut');
    const first = await drive(dir, settings(dir));
    expect(first.code, first.out).toBe(0);
    expect(events(dir).map(e => e.event)).toEqual([
      'start',
      'job-start',
      'job-start',
      'job-done',
      'job-done',
      'finish',
    ]);
    expect(JSON.parse(readFileSync(join(dir, 'drive.json'), 'utf8'))).toMatchObject({ SHA: 'abc', JUDGES: 'none' });
    expect(existsSync(join(dir, 'done/opencode-m/r1/c1'))).toBe(true);
    expect(existsSync(join(dir, 'drive.lock'))).toBe(false);
    const before = calls(dir).length;
    const again = await drive(dir);
    expect(again.code, again.out).toBe(0);
    expect(calls(dir).length - before).toBe(1);
    expect(calls(dir).at(-1)?.cmd).toBe('report');
    expect(
      events(dir)
        .slice(-2)
        .map(e => e.event)
    ).toEqual(['resume', 'finish']);
    expect(readBenchDriveState(dir)).toMatchObject({ status: 'finished', done: 2, total: 2 });
  });

  it('keeps a crashed arm job partial, records why, and resumes only that job', async () => {
    const dir = bench();
    const first = await drive(dir, { ...settings(dir), FAKE_FAIL: 'c2/floor' });
    expect(first.code).toBe(1);
    expect(events(dir).find(e => e.event === 'job-fail')).toMatchObject({
      job: 'opencode-m/r1/c2',
      reason: 'no floor diff',
    });
    expect(events(dir).at(-1)).toMatchObject({ event: 'stop', reason: '1 jobs failed: resume to retry them' });
    expect(readFileSync(join(run(dir), 'c2/v2/diff.patch'), 'utf8')).toBe('d');
    expect(readBenchDriveState(dir)).toMatchObject({ status: 'stopped', done: 1, partial: 1, total: 2 });
    const before = calls(dir).length;
    expect((await drive(dir)).code).toBe(0);
    const later = calls(dir).slice(before);
    expect(later.filter(c => c.id === 'c1' && c.cmd !== 'report')).toEqual([]);
    expect(later.filter(c => c.cmd === 'run').map(c => c.arm)).toEqual(['v2', 'floor']);
    expect(events(dir).find(e => e.event === 'resume')).toMatchObject({ partial: ['opencode-m/r1/c2'] });
  });

  it('a failing judge leaves the job unfinished with its results, and a resume judges it', async () => {
    const dir = bench(['c1']);
    const judged = { ...settings(dir), JUDGES: 'opus:1' };
    expect((await drive(dir, { ...judged, FAKE_FAIL: 'judge' })).code).toBe(1);
    expect(events(dir).find(e => e.event === 'job-fail')?.reason).toBe('judge exit 1');
    expect(existsSync(join(run(dir), 'c1/v2/score.json'))).toBe(true);
    expect(readBenchDriveState(dir)).toMatchObject({ status: 'stopped', done: 0 });
    expect((await drive(dir)).code).toBe(0);
    expect(readBenchDriveState(dir)).toMatchObject({ status: 'finished', done: 1 });
  });

  it('stops on SIGTERM with the reason, stops its jobs and frees the dir', async () => {
    const dir = bench(['c1']);
    const { child, exit } = start(dir, { ...settings(dir), FAKE_FAIL: 'hang' });
    const hang = join(dir, 'calls.jsonl.hang');
    await until(() => existsSync(hang));
    const pid = Number(readFileSync(hang, 'utf8'));
    orphans.push(pid);
    child.kill('SIGTERM');
    expect((await exit).code).toBe(143);
    expect(events(dir).at(-1)).toMatchObject({ event: 'stop', reason: 'signal SIGTERM' });
    expect(existsSync(join(dir, 'drive.lock'))).toBe(false);
    await until(() => !isPidRunning(pid));
    expect(readBenchDriveState(dir)).toMatchObject({ status: 'stopped', reason: 'signal SIGTERM' });
  });

  it('on SIGTERM stops what its jobs started too', async () => {
    const dir = bench(['c1']);
    const { child, exit } = start(dir, { ...settings(dir), FAKE_FAIL: 'hang,worker' });
    const hang = join(dir, 'calls.jsonl.hang');
    await until(() => existsSync(hang));
    const pid = Number(readFileSync(hang, 'utf8'));
    orphans.push(pid);
    child.kill('SIGTERM');
    expect((await exit).code).toBe(143);
    await until(() => !isPidRunning(pid));
  });

  it('after SIGKILL shows crashed, and a resume takes over the dead lock', async () => {
    const dir = bench(['c1']);
    const { child, exit } = start(dir, { ...settings(dir), FAKE_FAIL: 'hang' });
    const hang = join(dir, 'calls.jsonl.hang');
    await until(() => existsSync(hang));
    orphans.push(Number(readFileSync(hang, 'utf8')));
    child.kill('SIGKILL');
    await exit;
    process.kill(orphans[0]!, 'SIGKILL');
    expect(existsSync(join(dir, 'drive.lock'))).toBe(true);
    expect(readBenchDriveState(dir)).toMatchObject({ status: 'crashed', done: 0, partial: 1 });
    const again = await drive(dir);
    expect(again.code, again.out).toBe(0);
    expect(readBenchDriveState(dir).status).toBe('finished');
  });

  it('refuses a second driver on the same dir', async () => {
    const dir = bench(['c1']);
    writeFileSync(join(dir, 'drive.lock'), String(process.pid));
    const second = await drive(dir, settings(dir));
    expect(second.code).toBe(1);
    expect(second.out).toMatch(/another driver runs/);
    expect(events(dir).map(e => e.event)).toEqual(['busy']);
    expect(calls(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'drive.lock'), 'utf8')).toBe(String(process.pid));
    utimesSync(join(dir, 'drive.lock'), 0, 0);
    expect(readBenchDriveState(dir).status).not.toBe('running');
  });

  it('stops on the Codex budget before a job starts, with the reason', async () => {
    const dir = bench(['c1']);
    mkdirSync(run(dir), { recursive: true });
    writeFileSync(join(run(dir), 'budget.json'), JSON.stringify({ now: 50, start: 40, at: new Date().toISOString() }));
    const first = await drive(dir, { ...settings(dir), MAX_CODEX: '45' });
    expect(first.code).toBe(1);
    expect(events(dir).at(-1)).toMatchObject({ event: 'stop', reason: 'Codex weekly 50% is over 45%' });
    expect(calls(dir).filter(c => c.cmd !== 'report')).toEqual([]);
    expect(readBenchDriveState(dir)).toMatchObject({ status: 'stopped', reason: 'Codex weekly 50% is over 45%' });
    expect((await drive(dir, { MAX_CODEX: '60' })).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'drive.json'), 'utf8')).MAX_CODEX).toBe('60');
  });

  it('takes no new job while PAUSE is set and goes on when it is removed', async () => {
    const dir = bench(['c1']);
    writeFileSync(join(dir, 'PAUSE'), '');
    const { exit } = start(dir, settings(dir));
    await until(() => events(dir).some(e => e.event === 'pause'));
    expect(readBenchDriveState(dir).status).toBe('paused');
    expect(calls(dir)).toEqual([]);
    rmSync(join(dir, 'PAUSE'));
    expect((await exit).code).toBe(0);
    expect(events(dir).map(e => e.event)).toEqual(['start', 'pause', 'unpause', 'job-start', 'job-done', 'finish']);
  });
});

describe('bench driver settings', () => {
  it('takes a pre-drive.json dir settings from its queue and rejects a changed fixed one', () => {
    const dir = bench(['c1']);
    writeFileSync(
      join(dir, 'queue.txt'),
      `# old\ncd ${dir} && OUT=${dir} SHA=abc POINTS=m1,m2 REPEAT=1 JUDGES=none CAP=6 ENGINE=${join(dir, 'eng')} REPOS=${dir} node tools/drive.mjs\n`
    );
    expect(configure(dir, {})).toMatchObject({ SHA: 'abc', POINTS: 'm1,m2', REPEAT: '1', CAP: '6' });
    expect(configure(dir, { CAP: '9' }).CAP).toBe('9');
    expect(() => configure(dir, { SHA: 'def' })).toThrow(/SHA is def, but this run started with abc/);
  });
});
