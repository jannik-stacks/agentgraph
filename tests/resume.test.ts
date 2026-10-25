import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessError, progress, runnerError, statusText } from '../bin/bench.ts';
import {
  appendJsonl,
  moveDirToAttic,
  claim,
  readJsonl,
  ensureRunSettingsPinned,
  probeUrl,
  copyDirIfAbsentAtomic,
  release,
  waitWhileServicesDown,
} from '../bin/resume.ts';
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

  it('moves a partial unit into the attic and never deletes it', () => {
    const dir = root();
    mkdirSync(join(dir, 'case/v2/data'), { recursive: true });
    writeFileSync(join(dir, 'case/v2/data/trace.jsonl'), 'x');
    const first = moveDirToAttic(join(dir, 'case/v2'))!;
    mkdirSync(join(dir, 'case/v2'));
    const second = moveDirToAttic(join(dir, 'case/v2'))!;
    expect(existsSync(join(dir, 'case/v2'))).toBe(false);
    expect(readFileSync(join(first, 'data/trace.jsonl'), 'utf8')).toBe('x');
    expect(second).not.toBe(first);
    expect(readdirSync(join(dir, 'case/.attic'))).toHaveLength(2);
    expect(moveDirToAttic(join(dir, 'case/v2'))).toBeUndefined();
  });

  it('drops checkouts from a unit it moves aside and keeps the records', () => {
    const dir = root();
    mkdirSync(join(dir, 'case/v2/data/work/abc/node_modules'), { recursive: true });
    writeFileSync(join(dir, 'case/v2/data/trace.jsonl'), 'x');
    const to = moveDirToAttic(join(dir, 'case/v2'))!;
    expect(existsSync(join(to, 'data/work'))).toBe(false);
    expect(readFileSync(join(to, 'data/trace.jsonl'), 'utf8')).toBe('x');
  });

  it('publishes a copy whole, with the filter, and keeps a published one', () => {
    const dir = root();
    mkdirSync(join(dir, 'at/data'), { recursive: true });
    writeFileSync(join(dir, 'at/diff.patch'), 'd');
    copyDirIfAbsentAtomic(join(dir, 'at'), join(dir, 'kept'), p => !p.endsWith('/data'));
    expect(readdirSync(join(dir, 'kept'))).toEqual(['diff.patch']);
    writeFileSync(join(dir, 'at/diff.patch'), 'other');
    copyDirIfAbsentAtomic(join(dir, 'at'), join(dir, 'kept'));
    expect(readFileSync(join(dir, 'kept/diff.patch'), 'utf8')).toBe('d');
    expect(readdirSync(dir).sort()).toEqual(['at', 'kept']);
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
  });

  it('calls a run whose last session ended in a harness error infra', () => {
    const data = root();
    mkdirSync(join(data, 'issue-1'));
    const end = (ended: string, final: string) => JSON.stringify({ event: { type: 'end', ended, final, exit: 1 } });
    writeFileSync(
      join(data, 'issue-1/trace.jsonl'),
      `${end('stop', 'done')}\n${end('error', 'Cannot connect to API')}\n`
    );
    expect(harnessError(data)).toBe('harness error: Cannot connect to API');
    writeFileSync(join(data, 'issue-1/trace.jsonl'), `${end('error', 'x')}\n${end('stop', 'done')}\n`);
    expect(harnessError(data)).toBeUndefined();
    expect(harnessError(join(data, 'none'))).toBeUndefined();
  });

  it('calls a stop on a runner error infra, and an agent outcome not', () => {
    expect(runnerError('Stopped by a runner error (SessionStop). The details are in the trace.')).toBeTruthy();
    expect(runnerError('SessionStop: provider down')).toBeTruthy();
    expect(runnerError('Which file should the fix go in?')).toBeUndefined();
    expect(runnerError()).toBeUndefined();
  });
});

describe('progress', () => {
  it('counts done, infra, invalid, running and left units, retries, a wait and the time left', () => {
    const out = root();
    const unit = (id: string, arm = 'v2') => ({ out, case: id, arm });
    const put = (path: string, text: string) => {
      mkdirSync(join(out, path, '..'), { recursive: true });
      writeFileSync(join(out, path), text);
    };
    put('a/v2/diff.patch', 'd');
    put('a/v2/meta.json', '{"ms":600000}');
    put('b/v2/diff.patch', '');
    put('b/v2/meta.json', '{"infra":"empty diff"}');
    put('c/valid.json', '{"invalid":"setup fails"}');
    put('d/v2.lock', String(process.ppid));
    put('e/v2/data/x', 'partial');
    put(
      'log.jsonl',
      [
        { at: '1', event: 'infra', why: 'docker unreachable' },
        { at: '2', event: 'start' },
        { at: '3', event: 'wait', why: 'model proxy unreachable' },
      ]
        .map(l => JSON.stringify(l))
        .join('\n')
    );
    const p = progress(
      ['a', 'b', 'c', 'd', 'e'].map(id => unit(id)),
      2
    );
    expect(p).toEqual({
      total: 5,
      done: 1,
      infra: 1,
      invalid: 1,
      left: 1,
      running: ['d/v2'],
      retries: 1,
      waiting: 'model proxy unreachable since 3',
      eta: 10,
    });
    expect(statusText(p)).toContain('1/5 done, 1 infra, 1 invalid, 1 running, 1 left');
  });

  it('pins the env a run started with and refuses a restart that cannot match it', () => {
    const dir = root();
    const file = join(dir, 'env.json');
    expect(ensureRunSettingsPinned(file, { BENCH_PATH: dir, keys: undefined }, { BENCH_ENGINE: dir })).toEqual({
      BENCH_ENGINE: dir,
      BENCH_PATH: dir,
    });
    expect(ensureRunSettingsPinned(file, {})).toEqual({ BENCH_ENGINE: dir, BENCH_PATH: dir });
    expect(() => ensureRunSettingsPinned(file, { BENCH_PATH: '/elsewhere' })).toThrow(/started with/);
    writeFileAtomic(file, { BENCH_PATH: `${dir}:${join(dir, 'gone')}` });
    expect(() => ensureRunSettingsPinned(file, {})).toThrow(/missing: BENCH_PATH .*gone/);
  });
});
