import { describe, expect, it } from 'vitest';
import type { Trace } from '../core/src/store.ts';
import type { Run } from '../core/src/workflow.ts';
import { studioModule } from './studio.ts';

type Row = { at?: string; children?: Row[]; raw?: unknown; open?: boolean };
type CoreRun = { fixture: string; repo: string; run: Run; trace: Trace[] };
Object.assign(globalThis, { location: new URL('http://localhost/runs') });
const { runRow } = await studioModule<{ runRow: (r: CoreRun, open?: boolean) => Row }>('runs/rows.tsx');

const at = '2026-10-16T05:00:00.000Z';
const run: Run = {
  id: 'issue-1',
  issue: 1,
  started: at,
  workflow: 'issue',
  step: 'review',
  status: 'running',
  tries: 0,
  rounds: {},
  usd: 0.1,
} as Run;
const trace = [
  { at, step: 'implement', event: { type: 'start', session: 's1', model: 'smart' } },
  { at, step: 'implement', event: { type: 'text', text: 'done' } },
  { at, step: 'implement', session: { id: 's1', resumed: false, ended: 'stop', usd: 0.1 } },
  { at, step: 'implement', check: { check: 'tests', pass: true, ms: 5 } },
  {
    at,
    step: 'implement',
    outcome: { kind: 'pass' },
    run: { step: 'review', status: 'running', tries: 0, rounds: {} },
  },
  { at, step: 'review', saved: { step: 'review' } },
  { at, step: 'review', event: { type: 'start', session: 's2', model: 'smart' } },
] as Trace[];

describe('a run as rows', () => {
  const row = runRow({ fixture: 'sk/issue', repo: 'o/r', run, trace }, true);

  it('opens to its visits, each holding its sessions and the other lines, with run.json as raw', () => {
    expect(row.raw).toBe(run);
    expect(row.children?.map(v => v.children?.length)).toEqual([3, 2]);
    expect(row.children?.[0]?.children?.[0]?.children?.map(c => c.raw)).toEqual(trace.slice(0, 3));
  });

  it('keeps the running session open and every trace line inspectable as raw', () => {
    const [, review] = row.children!;
    expect(review?.children?.[1]?.open).toBe(true);
    expect(row.children?.[0]?.children?.slice(1).map(c => c.raw)).toEqual(trace.slice(3, 5));
  });
});
