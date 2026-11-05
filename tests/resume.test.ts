import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessError, runnerError } from '../bin/bench.ts';
import { appendJsonl, claim, readJsonl, probeUrl, release, waitWhileServicesDown } from '../bin/resume.ts';
import { isLockedByOtherProcess } from '../src/owner.ts';
import { writeFileAtomic } from '../src/store.ts';
import { tuneRows } from '../bin/tune.ts';
import { tmp } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const root = () => {
  const dir = tmp('resume');
  dirs.push(dir);
  return dir;
};
const dead = () => spawnSync('true').pid!;

describe('crash-safe files', () => {
  it('writes whole files and leaves no temp file', () => {
    const dir = root();
    writeFileAtomic(join(dir, 'a/score.json'), { ok: true });
    writeFileAtomic(join(dir, 'a/score.json'), { ok: false });
    expect(JSON.parse(readFileSync(join(dir, 'a/score.json'), 'utf8'))).toEqual({ ok: false });
    expect(readdirSync(join(dir, 'a'))).toEqual(['score.json']);
  });

  it('counts corrupt JSONL rows and reports their line numbers', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = join(root(), 'log.jsonl');
    writeFileSync(file, '{"ok":true}\nbroken\n');
    const rows = readJsonl(file);
    const messages = warning.mock.calls.flat().join(' ');
    warning.mockRestore();
    expect(rows).toEqual([{ ok: true }]);
    expect(messages).toContain('1 skipped invalid JSONL rows: line 2');
  });

  it('skips a line a crash cut off and starts the next append on a new line', () => {
    const file = join(root(), 'log.jsonl');
    writeFileSync(file, '{"a":1}\n{"b":');
    expect(readJsonl(file)).toEqual([{ a: 1 }]);
    appendJsonl(file, { c: 3 });
    appendJsonl(file, { d: 4 });
    expect(readJsonl(file)).toEqual([{ a: 1 }, { c: 3 }, { d: 4 }]);
  });

  it('reads a tune whose last step line was torn', () => {
    const dir = root();
    writeFileSync(join(dir, 'tune.json'), '{"repo":"me/demo"}');
    writeFileSync(join(dir, 'iterations.jsonl'), '{"id":"i000-init","verdict":"kept"}\n{"id":"i001');
    expect(tuneRows(dir).steps.map(s => s.id)).toEqual(['i000-init']);
  });
});

describe('unit locks', () => {
  it('holds a unit for a live process and takes it over from a dead one', () => {
    const unit = join(root(), 'case/v2');
    mkdirSync(join(unit, '..'));
    writeFileSync(`${unit}.lock`, String(process.ppid), { flag: 'w' });
    expect(isLockedByOtherProcess(unit)).toBe(true);
    expect(claim(unit)).toBe(false);
    writeFileSync(`${unit}.lock`, String(dead()));
    expect(isLockedByOtherProcess(unit)).toBe(false);
    expect(claim(unit)).toBe(true);
    expect(readFileSync(`${unit}.lock`, 'utf8')).toBe(String(process.pid));
    expect(isLockedByOtherProcess(unit)).toBe(false);
    release(unit);
    expect(existsSync(`${unit}.lock`)).toBe(false);
  });
});

describe('environment', () => {
  it('waits while the environment is down and logs the wait and the recovery', async () => {
    const log: object[] = [];
    const answers = ['model proxy unreachable', 'docker unreachable', undefined];
    const waits: number[] = [];
    await waitWhileServicesDown(
      e => log.push(e),
      false,
      async () => answers.shift(),
      async ms => void waits.push(ms)
    );
    expect(log).toEqual([
      { event: 'wait', why: 'model proxy unreachable', retryIn: 15 },
      { event: 'wait', why: 'docker unreachable', retryIn: 30 },
      { event: 'resume' },
    ]);
    expect(waits).toEqual([15_000, 30_000]);
  });

  it('probes the proxy from the host', () => {
    expect(probeUrl('http://gateway:4000/v1')).toBe('http://127.0.0.1:4000/health/liveliness');
    expect(probeUrl('http://gateway:4999/v1')).toBe('http://127.0.0.1:4999/health/liveliness');
    expect(probeUrl('claude=,opencode=http://gateway:4001/v1')).toBe('http://127.0.0.1:4001/health/liveliness');
    expect(probeUrl('claude=')).toBeUndefined();
  });

  it('calls a run whose last session ended in a harness error infra', () => {
    const data = root();
    mkdirSync(join(data, 'issue-1'));
    const end = (ended: string, final: string) => JSON.stringify({ event: { type: 'end', ended, final, exit: 1 } });
    writeFileSync(
      join(data, 'issue-1/trace.jsonl'),
      `${end('stop', 'done')}\n${end('error', 'Cannot connect to API')}\n`
    );
    expect(harnessError(data, 'issue-1')).toBe('harness error: Cannot connect to API');
    writeFileSync(join(data, 'issue-1/trace.jsonl'), `${end('error', 'x')}\n${end('stop', 'done')}\n`);
    expect(harnessError(data, 'issue-1')).toBeUndefined();
    expect(harnessError(data, 'none')).toBeUndefined();
  });

  it('calls a stop on a runner error infra, and an agent outcome not', () => {
    expect(runnerError('Stopped by a runner error (SessionStop). The details are in the trace.')).toBeTruthy();
    expect(runnerError('SessionStop: provider down')).toBeTruthy();
    expect(runnerError('Which file should the fix go in?')).toBeUndefined();
    expect(runnerError()).toBeUndefined();
  });
});
