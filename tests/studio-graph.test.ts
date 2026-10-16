import { describe, expect, it } from 'vitest';
import { graphOf, type Graph } from '../src/graph.ts';
import type { Workflow } from '../src/workflow.ts';
import { fixture, hubs as fixtureHubs } from './fixtures.ts';
import { studioModule } from './studio.ts';

type Fixture = { workflow: Workflow; checks: Parameters<typeof graphOf>[1] };
type Box = { x: number; y: number; width: number; height: number };
type Row = { workflow: string; frame: Box; nodes: { id: string; kind: string; step?: string; box: Box }[] };

const { layout, liftOf, backOut, backIn } = await studioModule<{
  layout: (graphs: { workflow: string; graph: Graph }[]) => Row[];
  liftOf: (dx: number) => number;
  backOut: number;
  backIn: number;
}>('graph/layout.ts');

const SHOWN = fixtureHubs.map(hub => {
  const { workflows, checks } = fixture(hub);
  return [hub, Object.values(workflows).map(workflow => ({ workflow, checks }))] as const;
});

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Box, b: Box) =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
const graphsOf = (list: readonly Fixture[]) =>
  list.map(f => ({ workflow: f.workflow.name, graph: graphOf(f.workflow, f.checks) }));

describe('studio graph', () => {
  it.each(SHOWN)('%s: places each step once, apart from the others, inside its own row', (_, list) => {
    const rows = layout(graphsOf(list));
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

  it.each(SHOWN)('%s: leaves room above each row for its highest way back', (_, list) => {
    const graphs = graphsOf(list);
    const short = layout(graphs).flatMap((row, i) => {
      const box = (step: string) => row.nodes.find(n => n.step === step)!.box;
      const top = Math.min(...row.nodes.map(n => n.box.y));
      const lift = (from: Box, to: Box) => liftOf(from.x + from.width * backOut - to.x - to.width * backIn);
      return graphs[i]!.graph.edges.flatMap(e =>
        e.kind === 'back' && top - lift(box(e.from), box(e.to)) * 0.75 < row.frame.y
          ? [`${row.workflow} ${e.from}`]
          : []
      );
    });
    expect(short).toEqual([]);
  });
});
