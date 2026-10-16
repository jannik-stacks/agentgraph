import { describe, expect, it } from 'vitest';
import { graphOf } from '../src/graph.ts';
import { begin, type Run } from '../src/workflow.ts';
import { fixture, hubs } from './fixtures.ts';

describe('graphOf', () => {
  it.each(hubs)(
    'draws every workflow of the %s fixture with one node per step and a next edge between each pair',
    hub => {
      const { workflows, checks } = fixture(hub);
      for (const w of Object.values(workflows)) {
        const g = graphOf(w, checks);
        expect(g.nodes.map(n => n.step)).toEqual(w.steps.map(s => s.name));
        expect(g.edges.filter(e => e.kind === 'next')).toHaveLength(w.steps.length - 1);
        expect(g.edges.filter(e => e.kind === 'back')).toHaveLength(w.steps.filter(s => s.back).length);
      }
    }
  );

  it('counts the worst case of the user loop as 29 sessions', () => {
    const { workflows, checks } = fixture('loop');
    const g = graphOf(workflows.align!, checks);
    expect(g.worst).toBe(29);
    expect(g.edges.find(e => e.kind === 'back')).toEqual({
      from: 'align',
      to: 'write',
      kind: 'back',
      until: 'the docs describe what the code does, and the code does what the docs promise',
      rounds: 3,
    });
  });

  it('leaves a wait step out of the worst case and its way back uncapped', () => {
    const { workflows, checks } = fixture('acme-app');
    const g = graphOf(workflows.issue!, checks);
    // triage 1, then implement 4 tries and review 1 try, each visited 3 times (1 + 2 rounds)
    expect(g.worst).toBe(1 + 3 * 4 + 3 * 1);
    expect(g.edges.find(e => e.from === 'merge')).toEqual({ from: 'merge', to: 'implement', kind: 'back' });
  });

  it('names the trigger, the doer, the checks with their modes and kinds, the tries and the fan-out', () => {
    const { workflows, checks } = fixture('acme-app');
    const g = graphOf(workflows.issue!, checks);
    expect(g.trigger).toBe('/bothub comment');
    const [triage, implement, review, merge] = g.nodes;
    expect(triage).toEqual({ step: 'triage', doer: 'triager / triage', checks: [], tries: 1 });
    expect(implement!.checks[0]).toEqual({ name: 'safety', mode: 'stop' });
    expect(implement!.checks.find(c => c.name === 'docs-tone')).toEqual({
      name: 'docs-tone',
      mode: 'warn',
      agent: 'reviewer',
    });
    expect(review).toMatchObject({ doer: 'reviewer / review-hunk', each: 'hunks' });
    expect(merge!.doer).toBe('human');
    expect(graphOf(workflows.merge!, checks).nodes[0]!.doer).toBe('script');
    expect(graphOf(fixture('bothub').workflows.retro!, {}).nodes[0]!.each).toBe(
      'node "$BOTHUB_HUB/scripts/retro-items.mjs"'
    );
  });

  it('draws a run over the graph: the current step, its tries, what was visited and the rounds taken', () => {
    const { workflows, checks } = fixture('acme-app');
    const w = workflows.issue!;
    const run: Run = {
      ...begin(w, { id: 'r1', issue: 7, started: 'now' }),
      step: 'implement',
      tries: 2,
      rounds: { review: 1 },
    };
    const g = graphOf(w, checks, run);
    expect(g.nodes.map(n => n.run)).toEqual([
      { tries: 0, current: false, visited: true },
      { tries: 2, current: true, visited: true },
      { tries: 0, current: false, visited: true },
      { tries: 0, current: false, visited: false },
    ]);
    expect(g.edges.find(e => e.from === 'review' && e.kind === 'back')!.taken).toBe(1);
    expect(g.edges.find(e => e.from === 'merge')!.taken).toBe(0);
  });

  it('marks every step visited once the run is done', () => {
    const { workflows, checks } = fixture('clarinet');
    const w = workflows.issue!;
    const run: Run = { ...begin(w, { id: 'r1', issue: 7, started: 'now' }), step: 'review', status: 'done' };
    expect(graphOf(w, checks, run).nodes.every(n => n.run?.visited)).toBe(true);
  });
});
