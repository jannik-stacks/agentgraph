import { existsSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readRunResults } from '../bin/results.ts';
import { Schema } from 'effect';
import { readResultSheet, readResultSheets, writeResultSheet } from '../src/store.ts';
import { findCheckFields, ResultSheet } from '../src/results.ts';
import type { CheckEntry } from '../src/trace.ts';
import {
  formatResultValue,
  readFieldValue,
  type RunResults,
  splitRunsByAxis,
  getFieldSummary,
} from '../studio/src/results/result.ts';
import { tmp } from './kit.ts';

const run = (key: string, at: string, usd: number, pass = true, dead?: string): RunResults => ({
  key,
  at,
  ...(dead && { dead }),
  axes: { workflow: key.startsWith('a') ? 'issue' : 'triage' },
  results: { 'run-stats': { at, pass, value: { usd, tools: 10, ok: pass } } },
});

const checks = {
  'run-stats': {
    mode: 'warn' as const,
    returns: {
      type: 'object' as const,
      properties: { usd: { type: 'number' as const, unit: 'usd' as const, description: 'list price' } },
    },
    pass: { properties: { usd: { maximum: 2 } } },
  },
};

const entry = (at: string, usd: number, version = 'v1'): CheckEntry => ({
  at,
  step: 'end',
  version,
  usd: 0,
  check: { check: 'run-stats', pass: true, value: { usd }, ms: 0 },
});

describe('results', () => {
  it('types fields from the check, with its unit and the bound of its pass, else from the values', () => {
    const fields = findCheckFields([run('a1', '2026-10-01T00:00:00Z', 1)], checks);
    expect(fields).toEqual([
      {
        check: 'run-stats',
        field: 'usd',
        mode: 'warn',
        type: 'number',
        description: 'list price',
        unit: 'usd',
        limit: { maximum: 2 },
      },
      { check: 'run-stats', field: 'tools', mode: 'warn', type: 'number' },
      { check: 'run-stats', field: 'ok', mode: 'warn', type: 'boolean' },
    ]);
  });

  it('reads values by their unit', () => {
    expect(formatResultValue({ type: 'number', unit: 'usd' }, 0.004)).toBe('<$0.01');
    expect(formatResultValue({ type: 'number', unit: 'usd' }, 1.5)).toBe('$1.50');
    expect(formatResultValue({ type: 'number', unit: 'minutes' }, 75)).toBe('1 h 15 min');
    expect(formatResultValue({ type: 'number', unit: 'seconds' }, 30)).toBe('30 s');
    expect(formatResultValue({ type: 'number', unit: 'share' }, 0.5)).toBe('50%');
    expect(formatResultValue({ type: 'boolean' }, 0.25)).toBe('25%');
    expect(formatResultValue({ type: 'number', unit: 'tokens' }, 12_345)).toBe('12.3k');
  });

  it('summarizes a field without the dead runs, with failed results, values past the limit and a trend by day', () => {
    const runs = [
      run('a1', '2026-10-01T00:00:00Z', 1),
      run('a2', '2026-10-01T01:00:00Z', 3, false),
      run('a3', '2026-10-02T00:00:00Z', 1.5),
      run('a4', '2026-10-02T01:00:00Z', 9, false, 'no session started'),
    ];
    const [usd] = findCheckFields(runs, checks);
    const s = getFieldSummary(runs, usd!);
    expect(s.values).toEqual([1, 3, 1.5]);
    expect(s.median).toBe(1.5);
    expect(s.warned).toBe(1);
    expect(s.outside.map(r => r.key)).toEqual(['a2']);
    expect(s.dead).toBe(1);
    expect(s.trend).toEqual([2, 1.5]);
    expect([...splitRunsByAxis(runs, 'workflow').keys()]).toEqual(['issue']);
  });

  it('reads each run of a data dir with the latest result of each check and why a run says nothing', () => {
    const data = tmp('results');
    const put = (id: string, status: string, trace: object[], entries: CheckEntry[]) => {
      mkdirSync(join(data, id), { recursive: true });
      writeFileSync(
        join(data, id, 'run.json'),
        JSON.stringify({
          id,
          issue: 1,
          workflow: 'issue',
          status,
          started: '2026-10-01T00:00:00Z',
          meta: { engine: { origin: { plugin: 'bench', version: 'v1', job: 'smoke', input: { arm: 'candidate' } } } },
        })
      );
      writeFileSync(join(data, id, 'trace.jsonl'), trace.map(t => JSON.stringify(t)).join('\n'));
      writeFileSync(join(data, id, 'checks.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));
    };
    put('r1', 'done', [{ at: '1', step: 'code', event: { type: 'start' } }], [entry('2', 1), entry('3', 2, 'v0')]);
    put('r2', 'stopped', [], []);
    const { fields, runs } = readRunResults(
      'runs',
      { data },
      { checks: { 'run-stats': { ...checks['run-stats'], version: 'v1' } } as never }
    );
    expect(fields.map(f => f.field)).toEqual(['usd']);
    expect(Schema.decodeUnknownSync(ResultSheet)({ fields, runs })).toEqual({ fields, runs });
    expect(runs[0]).toMatchObject({
      axes: { plugin: 'bench', job: 'smoke' },
      meta: { engine: { origin: { plugin: 'bench' } } },
    });
    expect(runs.find(r => r.key === 'r1')!.results['run-stats']).toEqual({ at: '2', pass: true, value: { usd: 1 } });
    expect(runs.find(r => r.key === 'r2')!.dead).toBe('ended before any step passed or any session started');
  });
});

describe('result sheets', () => {
  it.each([
    { fields: [], runs: [{ ...run('a', 'now', 1), meta: { tool: { note: '<script>text</script>' } } }] },
    {
      fields: [],
      runs: [
        {
          ...run('b', 'now', 1),
          results: { empty: { at: 'now', pass: false, empty: true, later: true, older: true, share: 0 } },
        },
      ],
    },
  ])('round trips public measurements and owner metadata %#', sheet => {
    expect(Schema.decodeUnknownSync(ResultSheet)(sheet)).toEqual(sheet);
  });

  it.each([
    { fields: [], runs: [{ ...run('a', 'now', 1), href: 'javascript:alert(1)' }] },
    { fields: [], runs: [{ ...run('a', 'now', 1), href: '/\n/evil.example' }] },
    { fields: [], runs: [{ ...run('a', 'now', 1), href: '//evil.example' }] },
    { fields: [], runs: [{ ...run('a', 'now', 1), href: String.raw`/\evil.example` }] },
    { fields: [], runs: [{ ...run('a', 'now', 1), meta: { tool: 'x'.repeat(8192) } }] },
    {
      fields: [],
      runs: [{ ...run('a', 'now', 1), results: { cost: { at: 'now', pass: true, value: { usd: Infinity } } } }],
    },
    { fields: Array.from({ length: 1001 }, (_, i) => ({ check: 'c', field: `f${i}` })), runs: [] },
    { fields: [], runs: [run('same', 'now', 1), run('same', 'now', 2)] },
    {
      fields: [
        { check: 'c', field: 'f' },
        { check: 'c', field: 'f' },
      ],
      runs: [],
    },
    { fields: [{ check: 'c', field: 'f', limit: { maximum: Infinity } }], runs: [] },
  ])('refuses invalid exports %#', sheet => {
    expect(Schema.decodeUnknownEither(ResultSheet)(sheet)._tag).toBe('Left');
  });
});

describe('result exports', () => {
  it('shares checked files through discovery and the generic Results source', () => {
    const data = tmp('export-results');
    const root = join(data, 'plugins');
    const path = join(root, 'custom', 'job', 'results.json');
    const row = { ...run('sample', 'now', 1), meta: { custom: { arm: 'candidate' } } };
    const sheet = { fields: findCheckFields([row], checks), runs: [row] };
    writeResultSheet(path, sheet);
    expect(readResultSheet(path)).toEqual(sheet);
    expect(readResultSheets([root, root])).toHaveLength(1);
    const loaded = readRunResults('exports', { data });
    expect(loaded.runs[0]).toMatchObject({ meta: row.meta, axes: { export: '0/custom/job/results.json' } });
    expect(Object.keys(loaded.runs[0]!.results)).toEqual(['run-stats']);
    expect(loaded.fields[0]).toMatchObject({ check: 'run-stats', unit: 'usd' });
  });

  it('compares the same metric across jobs and rejects conflicting definitions', () => {
    const data = tmp('export-comparison');
    const root = join(data, 'plugins');
    const first = run('same', 'now', 1);
    const second = run('same', 'later', 3);
    const fields = findCheckFields([first], checks);
    writeResultSheet(join(root, 'bench', 'a', 'results.json'), { fields, runs: [first] });
    const other = join(root, 'bench', 'b', 'results.json');
    writeResultSheet(other, { fields, runs: [second] });
    const loaded = readRunResults('exports', { data });
    expect(loaded.fields).toEqual(fields);
    expect(loaded.runs.map(row => readFieldValue(row, fields[0]!))).toEqual([1, 3]);
    expect(new Set(loaded.runs.map(row => row.key)).size).toBe(2);
    writeResultSheet(other, {
      fields: fields.map(field => ({ ...field, description: 'another meaning' })),
      runs: [second],
    });
    expect(() => readRunResults('exports', { data })).toThrow('conflicting result field');
  });

  it('exports ordinary runs through the CLI without copying their prompts', () => {
    const data = tmp('export-cli');
    const at = '2026-10-01T00:00:00Z';
    const dir = join(data, 'r1');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({
        id: 'r1',
        issue: 1,
        workflow: 'issue',
        status: 'running',
        started: at,
        meta: { engine: { origin: { plugin: 'bench', version: 'v1', job: 'smoke', input: { arm: 'candidate' } } } },
      })
    );
    writeFileSync(join(dir, 'checks.jsonl'), JSON.stringify(entry(at, 2)) + '\n');
    const output = join(data, 'plugins', 'bench', 'smoke', 'results.json');
    execFileSync(process.execPath, ['bin/results.ts', 'runs', data, output]);
    expect(readResultSheet(output).runs[0]).toMatchObject({
      axes: { plugin: 'bench', job: 'smoke' },
      meta: { engine: { origin: { input: { arm: 'candidate' } } } },
    });
    expect(readFileSync(output, 'utf8')).not.toContain('prompt');
  });

  it('exports every benchmark arm, including artifact baselines', () => {
    const root = tmp('export-bench');
    for (const arm of ['human', 'v2', 'floor']) {
      const dir = join(root, 'sample', arm);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'score.json'), JSON.stringify({ files: 1, ms: 1000, usd: 0.5, suite: { ok: true } }));
    }
    const output = join(root, 'output.json');
    execFileSync(process.execPath, ['bin/results.ts', 'bench', root, output]);
    expect(readResultSheet(output).runs.map(row => row.axes.arm)).toEqual(['human', 'v2', 'floor']);
  });

  it('exports tune summaries without embedding their candidate details', () => {
    const root = tmp('export-tune');
    const dir = join(root, 'acme', 'candidate');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tune.json'), JSON.stringify({ repo: 'acme/demo' }));
    writeFileSync(
      join(dir, 'iterations.jsonl'),
      JSON.stringify({
        id: 'i1',
        at: 'now',
        iteration: 1,
        proposer: 'manual',
        verdict: 'kept',
        graph: 'private-graph-location',
        evals: [{ split: 'fit', cases: ['one'], quality: 0.5, usd: 2, minutes: 3 }],
      }) + '\n'
    );
    const output = join(root, 'output.json');
    execFileSync(process.execPath, ['bin/results.ts', 'tune', root, output]);
    expect(readResultSheet(output).runs[0]!.results['tune/score']!.value).toEqual({ quality: 0.5, usd: 2, minutes: 3 });
    expect(readFileSync(output, 'utf8')).not.toContain('private-graph-location');
  });

  it('skips symlinked files and directories and reports malformed exports', () => {
    const root = tmp('export-scope');
    const outside = tmp('export-other');
    writeResultSheet(join(outside, 'results.json'), { fields: [], runs: [] });
    symlinkSync(outside, join(root, 'linked'));
    symlinkSync(join(outside, 'results.json'), join(root, 'results.json'));
    expect(readResultSheets([root])).toEqual([]);
    const malformed = join(root, 'bad', 'results.json');
    mkdirSync(join(root, 'bad'));
    writeFileSync(malformed, '{');
    expect(() => readRunResults('exports', { bench: [root] })).toThrow('invalid result sheet JSON');
    expect(readResultSheets([join(root, 'missing')])).toEqual([]);
  });

  it('rejects malformed and oversized files before replacing valid data', () => {
    const root = tmp('export-limits');
    const path = join(root, 'results.json');
    const sheet = { fields: [], runs: [run('a', 'now', 1)] };
    writeResultSheet(path, sheet);
    expect(() => writeResultSheet(path, { ...sheet, runs: [{ ...sheet.runs[0]!, href: 'javascript:bad' }] })).toThrow(
      'invalid result sheet'
    );
    expect(readResultSheet(path)).toEqual(sheet);
    truncateSync(path, 16_777_217);
    expect(() => readResultSheet(path)).toThrow('exceeds 16 MiB');
    const big = join(root, 'big.json');
    expect(() =>
      writeResultSheet(big, { fields: [], runs: [{ ...run('b', 'now', 1), axes: { text: 'x'.repeat(16_777_216) } }] })
    ).toThrow('exceeds 16 MiB');
    expect(existsSync(big)).toBe(false);
  });

  it('bounds discovery rather than silently dropping exports', () => {
    const root = tmp('export-count');
    for (let i = 0; i < 257; i++) writeResultSheet(join(root, String(i), 'results.json'), { fields: [], runs: [] });
    expect(() => readResultSheets([root])).toThrow('exceed 256 files');
  });
});
