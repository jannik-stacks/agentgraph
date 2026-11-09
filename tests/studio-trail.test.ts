import { describe, expect, it } from 'vitest';
import { findCheckVerdicts } from '../src/trace.ts';
import type { CheckEntry } from '../src/types.ts';
import { studioModule } from './studio.ts';

type Opened = { kind: 'check' | 'agent'; name: string };
type Uses = { steps: { name: string; path: string }[]; checks: { name: string; path?: string }[] };
const { splitSelection, findAgentUses } = await studioModule<{
  splitSelection: (selected: string | null) => { workflow?: string; step?: string; trail: Opened[] };
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

const run = (id: string, checks: unknown[]) => ({ run: { id, issue: 7 }, checks: checks as CheckEntry[] });

describe('findCheckVerdicts', () => {
  const line = (at: string, check: string, pass: boolean, item?: string) => ({
    at,
    step: 'implement',
    check: { check, pass, ms: 1, ...(item ? {} : { findings: `${check} at ${at}` }) },
    ...(item && { item }),
  });

  it('preserves an empty check and its reason for the skip count', () => {
    const empty = {
      ...line('1', 'review', true),
      check: { check: 'review', pass: true, empty: true, findings: 'no files', ms: 0 },
    };
    expect(findCheckVerdicts([run('a', [empty])], 'implement', 'review')).toEqual([
      expect.objectContaining({ empty: true, findings: 'no files' }),
    ]);
  });

  it('folds item lines into one verdict per time it ran, newest first, across runs', () => {
    const verdicts = findCheckVerdicts(
      [
        run('a', [
          line('1', 'review', true),
          line('2', 'review', false, 'x'),
          line('2', 'review', true, 'y'),
          line('2', 'other', false),
        ]),
        run('b', [line('3', 'review', false)]),
      ],
      'implement',
      'review'
    );
    expect(verdicts.map(v => [v.at, v.pass, v.items, v.failed])).toEqual([
      ['3', false, 0, 0],
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

describe('a live run trail', async () => {
  const engine = await import('../src/workflow.ts');
  const { makeWorkflowGraph } = await import('../src/graph.ts');
  const { fixture } = await import('./fixtures.ts');
  const { simulate } = await studioModule<{
    simulate: (w: unknown, next: () => unknown, e: unknown) => { trace: unknown[]; run: { reason?: string } };
  }>('graph/scenarios.ts');
  const { makeRunTrail, makeWorkflowRunVisits, makeRunStory } = await studioModule<{
    makeRunTrail: (trace: unknown[]) => unknown[];
    makeWorkflowRunVisits: (
      graph: unknown,
      trail: unknown[],
      run: unknown
    ) => { visits: { node: { step: string }; outOfRounds?: boolean }[] };
    makeRunStory: (visits: unknown) => string;
  }>('graph/visits.ts');
  const workflow = fixture('kit').workflows.issue!;
  const graph = makeWorkflowGraph(workflow, {});
  const pass = { kind: 'pass' };
  const back = { kind: 'back', why: 'a hunk needs a change' };
  const replay = (outcomes: object[]) => {
    const queue = [...outcomes];
    const { trace, run } = simulate(workflow, () => queue.shift(), engine);
    return {
      run,
      marked: makeWorkflowRunVisits(graph, makeRunTrail(trace), run).visits.flatMap(v =>
        v.outOfRounds ? [v.node.step] : []
      ),
    };
  };
  const twice = [pass, pass, back, pass, back, pass];

  it('marks no way back as out of rounds when the run stopped for another reason', () => {
    const { run, marked } = replay([...twice, { kind: 'stop', why: 'Spent $5.29, over the budget' }]);
    expect(run.reason).toBeDefined();
    expect(marked).toEqual([]);
  });

  it('marks the way back that found no round left', () => {
    const { marked } = replay([...twice, back]);
    expect(marked).toEqual(['review']);
  });

  it('takes a way back as out of rounds only when its own trace line says the run then asked', () => {
    const queue = [pass, pass, back, pass];
    const { trace, run } = simulate(workflow, () => queue.shift(), engine) as {
      trace: { outcome: { kind: string }; run: { rounds: Record<string, number> } }[];
      run: object;
    };
    const unmoved = trace.map(line =>
      line.outcome.kind === 'back' ? { ...line, run: { ...line.run, rounds: {} } } : line
    );
    const visits = makeWorkflowRunVisits(graph, makeRunTrail(unmoved), run).visits;
    expect(visits.flatMap(v => (v.outOfRounds ? [v.node.step] : []))).toEqual([]);
  });

  const marks = (outcomes: object[], reason: string | undefined) => {
    const queue = [...outcomes];
    const { trace, run } = simulate(workflow, () => queue.shift(), engine) as { trace: unknown[]; run: object };
    const now = { ...run, reason };
    return makeWorkflowRunVisits(graph, makeRunTrail(trace), now).visits.flatMap(v =>
      v.outOfRounds ? [v.node.step] : []
    );
  };

  it('reads the last way back from its own line, not from a reason the run was given later', () => {
    expect(marks([pass, pass, back], 'rebase conflict')).toEqual([]);
    expect(marks([...twice, back], undefined)).toEqual(['review']);
  });

  it('keeps a run whose steps left the graph, naming them in its story', () => {
    const queue = [pass, pass, back];
    const { trace, run } = simulate(workflow, () => queue.shift(), engine) as {
      trace: { step: string }[];
      run: object;
    };
    const renamed = trace.map(line => (line.step === 'triage' ? { ...line, step: 'retired' } : line));
    const visits = makeWorkflowRunVisits(graph, makeRunTrail(renamed), { ...run, step: 'vanished' });
    expect(visits.visits.map(v => v.node.step)).toEqual(['implement', 'review']);
    expect(makeRunStory(visits)).toMatch(/\. Steps retired, vanished are not in the current graph\.$/);
  });

  it('names the step a run was sent back to even when the graph no longer has it', () => {
    const queue = [pass, pass, back, pass, pass, pass];
    const { trace, run } = simulate(workflow, () => queue.shift(), engine) as {
      trace: { step: string }[];
      run: object;
    };
    const renamed = trace.map(line => (line.step === 'implement' ? { ...line, step: 'retired' } : line));
    const story = makeRunStory(makeWorkflowRunVisits(graph, makeRunTrail(renamed), run));
    expect(story).toMatch(/sent it back to retired, review passed, merge passed, done\. Step retired is not/);
  });
});
