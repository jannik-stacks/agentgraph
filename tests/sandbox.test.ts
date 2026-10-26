import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeWorkflowGraph } from '../src/graph.ts';
import { loadGraph } from '../src/folder.ts';
import { harnesses } from './fixtures.ts';

describe('the sandbox example graph', () => {
  it('loads without problems and draws its issue workflow', async () => {
    const graph = await Effect.runPromise(loadGraph(join(import.meta.dirname, '..', 'examples', 'sandbox'), harnesses));
    expect(graph.repo).toBe('acme/sandbox');
    expect(Object.keys(graph.agents).sort()).toEqual([
      'claude-reviewer',
      'implementor',
      'reviewer',
      'router',
      'scout',
      'triager',
    ]);
    expect(makeWorkflowGraph(graph.workflows.router!, graph.checks, undefined, graph.agents).nodes[0]).toMatchObject({
      dispatches: true,
    });
    expect(makeWorkflowGraph(graph.workflows.triage!, graph.checks).trigger).toBe('issues, dispatched');
    expect(graph.workflows.issue!.on).toEqual({ issues: { label: 'agent:ready' } });
    const g = makeWorkflowGraph(graph.workflows.issue!, graph.checks);
    expect(g.nodes.map(n => n.step)).toEqual(['implement', 'review', 'merge']);
    expect(g.edges.filter(e => e.kind === 'back').map(e => [e.from, e.to])).toEqual([
      ['review', 'implement'],
      ['merge', 'implement'],
    ]);
  });

  it('has a Claude Code reviewer and an opencode reviewer judge each try of crosscheck side by side', async () => {
    const graph = await Effect.runPromise(loadGraph(join(import.meta.dirname, '..', 'examples', 'sandbox'), harnesses));
    expect(graph.workflows.crosscheck!.steps[0]!.checks.map(c => graph.checks[c]!.agent)).toEqual([
      undefined,
      undefined,
      'claude-reviewer',
      'reviewer',
    ]);
    expect([graph.agents['claude-reviewer']!.harness, graph.agents.reviewer!.harness]).toEqual(['claude', 'opencode']);
  });
});
