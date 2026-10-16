import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { graphOf } from '../src/graph.ts';
import { loadHub } from '../src/hub.ts';

describe('the sandbox example hub', () => {
  it('loads without problems and draws its issue workflow', async () => {
    const hub = await Effect.runPromise(loadHub(join(import.meta.dirname, '..', 'examples', 'sandbox')));
    expect(hub.repo).toBe('acme/sandbox');
    expect(Object.keys(hub.agents).sort()).toEqual(['implementor', 'reviewer', 'triager']);
    const g = graphOf(hub.workflows.issue!, hub.checks);
    expect(g.nodes.map(n => n.step)).toEqual(['implement', 'review', 'merge']);
    expect(g.edges.filter(e => e.kind === 'back').map(e => [e.from, e.to])).toEqual([
      ['review', 'implement'],
      ['merge', 'implement'],
    ]);
  });
});
