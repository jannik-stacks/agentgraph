import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRunResults } from '../bin/results.ts';
import type { CheckEntry } from '../src/trace.ts';
import {
  findCheckFields,
  formatResultValue,
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
        JSON.stringify({ id, issue: 1, workflow: 'issue', status, started: '2026-10-01T00:00:00Z' })
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
    expect(runs.find(r => r.key === 'r1')!.results['run-stats']).toEqual({ at: '2', pass: true, value: { usd: 1 } });
    expect(runs.find(r => r.key === 'r2')!.dead).toBe('ended before any step passed or any session started');
  });
});
