import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeWorkflowGraph } from '../src/graph.ts';
import { loadGraph } from '../src/folder.ts';
import { harnesses } from './fixtures.ts';

describe('the sandbox example graph', () => {
  it('loads without problems, its router dispatches and its triage takes dispatched issues', async () => {
    const graph = await Effect.runPromise(loadGraph(join(import.meta.dirname, '..', 'examples', 'sandbox'), harnesses));
    expect(makeWorkflowGraph(graph.workflows.router!, graph.checks, undefined, graph.agents).nodes[0]).toMatchObject({
      dispatches: true,
    });
    expect(makeWorkflowGraph(graph.workflows.triage!, graph.checks).trigger).toBe('issues, dispatched');
  });
});
