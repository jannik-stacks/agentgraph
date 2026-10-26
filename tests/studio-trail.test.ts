import { describe, expect, it } from 'vitest';
import { studioModule } from './studio.ts';

type Opened = { kind: 'check' | 'agent'; name: string };
type Verdict = { run: string; at: string; pass: boolean; findings?: string; items: number; failed: number };
type Uses = { steps: { name: string; path: string }[]; checks: { name: string; path?: string }[] };
const { splitSelection, findCheckVerdicts, findAgentUses } = await studioModule<{
  splitSelection: (selected: string | null) => { workflow?: string; step?: string; trail: Opened[] };
  findCheckVerdicts: (runs: unknown[], fixture: string, step: string, check: string) => Verdict[];
  findAgentUses: (fixtures: unknown[], agent: string) => Uses;
}>('graph/trail.ts');

describe('splitSelection', () => {
  it('reads the step and what was opened from it, in order', () => {
    expect(splitSelection('issue/implement/check:review/agent:auditor')).toEqual({
      workflow: 'issue',
      step: 'implement',
      trail: [
        { kind: 'check', name: 'review' },
        { kind: 'agent', name: 'auditor' },
      ],
    });
    expect(splitSelection('issue').trail).toEqual([]);
    expect(splitSelection(null)).toEqual({ trail: [] });
  });
});

describe('findCheckVerdicts', () => {
  const line = (at: string, check: string, pass: boolean, item?: string) => ({
    at,
    step: 'implement',
    check: { check, pass, ms: 1, ...(item ? {} : { findings: `${check} at ${at}` }) },
    ...(item && { item }),
  });
  const run = (id: string, fixture: string, trace: unknown[]) => ({ fixture, run: { id, issue: 7 }, trace });

  it('folds item lines into one verdict per time it ran, newest first, in the one fixture', () => {
    const verdicts = findCheckVerdicts(
      [
        run('a', 'hub/issue', [
          line('1', 'review', true),
          line('2', 'review', false, 'x'),
          line('2', 'review', true, 'y'),
          line('2', 'other', false),
        ]),
        run('b', 'hub/plan', [line('3', 'review', false)]),
      ],
      'hub/issue',
      'implement',
      'review'
    );
    expect(verdicts.map(v => [v.at, v.pass, v.items, v.failed])).toEqual([
      ['2', false, 2, 1],
      ['1', true, 0, 0],
    ]);
  });
});

describe('findAgentUses', () => {
  it('lists the steps an agent runs and the checks it judges, opened at the first step with that check', () => {
    const steps = [
      { name: 'implement', does: { agent: 'coder' }, checks: ['review'] },
      { name: 'merge', does: { wait: true }, checks: [] },
    ];
    const checks = { review: { agent: 'auditor' }, late: { agent: 'auditor' }, lint: {} };
    const fixtures = [
      { workflow: { name: 'issue', steps, checks: ['late'] }, checks },
      { workflow: { name: 'plan', steps: [], checks: [] }, checks },
    ];
    expect(findAgentUses(fixtures, 'coder').steps).toEqual([
      { name: 'implement', workflow: 'issue', path: 'issue/implement' },
    ]);
    expect(findAgentUses(fixtures, 'auditor')).toEqual({
      steps: [],
      checks: [
        { name: 'review', path: 'issue/implement/check:review' },
        { name: 'late', path: undefined },
      ],
    });
  });
});
