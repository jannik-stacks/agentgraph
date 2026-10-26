import { describe, expect, it } from 'vitest';
import { makeWorkflowGraph, type WorkflowGraph } from '../src/graph.ts';
import type { Workflow } from '../src/workflow.ts';
import { fixture, hubs as fixtureHubs } from './fixtures.ts';
import { studioModule } from './studio.ts';

type Fixture = { workflow: Workflow; checks: Parameters<typeof makeWorkflowGraph>[1] };
type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Row = {
  workflow: string;
  frame: Box;
  nodes: { id: string; kind: string; step?: string; box: Box }[];
  backs: { points: Point[] }[];
};

const { layout } = await studioModule<{
  layout: (graphs: { workflow: string; graph: WorkflowGraph }[], starts: [], hidden: Set<string>) => { rows: Row[] };
}>('graph/layout.ts');
type Chip = { kind: string; glyph?: string; label: string; tip: string };
const { makeStepChips, splitStepChips } = await studioModule<{
  makeStepChips: (node: WorkflowGraph['nodes'][number], hidden: Set<string>) => Chip[];
  splitStepChips: (chips: Chip[], width: number) => { title?: Chip; rows: Chip[][] };
}>('graph/chips.ts');

const SHOWN = fixtureHubs.map(hub => {
  const { workflows, checks } = fixture(hub);
  return [hub, Object.values(workflows).map(workflow => ({ workflow, checks }))] as const;
});

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Box, b: Box) =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
/** Whether the axis-parallel segment from `a` to `b` passes through the inside of `box`. */
const crosses = (a: Point, b: Point, box: Box) =>
  Math.max(a.x, b.x) > box.x &&
  Math.min(a.x, b.x) < box.x + box.width &&
  Math.max(a.y, b.y) > box.y &&
  Math.min(a.y, b.y) < box.y + box.height;
const makeGraphs = (list: readonly Fixture[]) =>
  list.map(f => ({ workflow: f.workflow.name, graph: makeWorkflowGraph(f.workflow, f.checks) }));

describe('studio graph', () => {
  it.each(SHOWN)('%s: places each step once, apart from the others, inside its own row', (_, list) => {
    const { rows } = layout(makeGraphs(list), [], new Set());
    const boxes = rows.flatMap(r => r.nodes);
    expect(
      boxes.flatMap((a, i) => boxes.slice(i + 1).flatMap(b => (overlaps(a.box, b.box) ? [`${a.id} ${b.id}`] : [])))
    ).toEqual([]);
    expect(rows.flatMap(r => r.nodes.filter(n => !inside(n.box, r.frame)).map(n => n.id))).toEqual([]);
    expect(
      rows.slice(1).flatMap((r, i) => (r.frame.y > rows[i]!.frame.y + rows[i]!.frame.height ? [] : [r.workflow]))
    ).toEqual([]);
    expect(rows.map(r => r.nodes.flatMap(n => n.step ?? []))).toEqual(list.map(f => f.workflow.steps.map(s => s.name)));
  });

  it.each(SHOWN)('%s: routes each way back inside its row without crossing a node', (_, list) => {
    const { rows } = layout(makeGraphs(list), [], new Set());
    const bad = rows.flatMap(row =>
      row.backs.flatMap(({ points }) =>
        points.flatMap((p, i) => {
          const q = points[i + 1];
          return [
            ...(p.y < row.frame.y ? [`${row.workflow} leaves its row`] : []),
            ...(q ? row.nodes.filter(n => crosses(p, q, n.box)).map(n => `${row.workflow} crosses ${n.id}`) : []),
          ];
        })
      )
    );
    expect(bad).toEqual([]);
  });

  it('wraps chips into at most three lines, folding the rest into a last chip that lists them', () => {
    const chips = Array.from({ length: 12 }, (_, i) => ({ kind: 'how', label: `chip number ${i}`, tip: `tip ${i}` }));
    const width = 200;
    const lines = splitStepChips(chips, width).rows;
    expect(lines).toHaveLength(3);
    const more = lines[2]!.at(-1)!;
    const shown = lines.flat().length - 1;
    expect(more.label).toBe(`+${12 - shown} more`);
    expect(more.tip).toContain('chip number 11');
    expect(
      splitStepChips(chips.slice(0, 2), width)
        .rows.flat()
        .map(c => c.label)
    ).toEqual(['chip number 0', 'chip number 1']);
  });

  it('shows one chip with the GitHub writes of an agent step, naming the agent file that sets them', () => {
    const { workflows, checks } = fixture('kit');
    const agents = {
      triager: { returns: ['back' as const] },
      implementor: { returns: ['comment' as const, 'push' as const, 'pull_request' as const] },
    };
    const nodes = makeWorkflowGraph(workflows.issue!, checks, undefined, agents).nodes;
    const writes = (step: string) =>
      makeStepChips(
        nodes.find(n => n.step === step)!,
        new Set()
      ).filter(c => c.glyph === 'writes');
    expect(writes('implement')).toEqual([
      {
        kind: 'writes',
        glyph: 'writes',
        label: 'comment push pr',
        tip: 'implementor can write to GitHub: comment, push, pull_request. The engine refuses anything else. Set by returns in agents/implementor.md.',
      },
    ]);
    expect([...writes('triage'), ...writes('review'), ...writes('merge')]).toEqual([]);
  });
});
