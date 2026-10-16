import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { graphOf, type Graph } from '../core/src/graph.ts';
import type { Workflow } from '../core/src/workflow.ts';
import { fixture, hubs as coreHubs } from '../core/tests/fixtures.ts';
import { backOf, compile, stepOrder, type Config } from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { studioModule } from './studio.ts';

type Fixture = { id: string; workflow: Workflow; checks: Parameters<typeof graphOf>[1] };
type Box = { x: number; y: number; width: number; height: number };
type Row = { workflow: string; frame: Box; nodes: { id: string; kind: string; step?: string; box: Box }[] };

const { fixturesOf } = await studioModule<{ fixturesOf: (config: Config) => Fixture[] }>('graph/model.ts');
const { layout, liftOf, backOut, backIn } = await studioModule<{
  layout: (graphs: { workflow: string; graph: Graph }[]) => Row[];
  liftOf: (dx: number) => number;
  backOut: number;
  backIn: number;
}>('graph/layout.ts');

const examples = join(import.meta.dirname, '..', 'examples');
const isCore = (dir: string) =>
  /^repo:/m.test(existsSync(join(dir, 'hub.yaml')) ? readFileSync(join(dir, 'hub.yaml'), 'utf8') : '');
const V1_HUBS = await Promise.all(
  readdirSync(examples)
    .filter(
      name =>
        !isCore(join(examples, name)) && ['bots', 'workflows'].some(entry => existsSync(join(examples, name, entry)))
    )
    .map(async name => {
      const compiled = compile(await readHub(join(examples, name)));
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
      return [name, compiled.config] as const;
    })
);

const V1_WORKFLOWS = V1_HUBS.flatMap(([hub, config]) =>
  fixturesOf(config).map(f => [`${hub} ${f.workflow.name}`, config.workflows[f.workflow.name]!, f] as const)
);

const SHOWN = [
  ...V1_HUBS.map(([name, config]) => [name, fixturesOf(config)] as const),
  ...coreHubs.map(hub => {
    const { workflows, checks } = fixture(hub);
    return [hub, Object.values(workflows).map(workflow => ({ workflow, checks }))] as const;
  }),
];

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Box, b: Box) =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
const graphsOf = (list: readonly Pick<Fixture, 'workflow' | 'checks'>[]) =>
  list.map(f => ({ workflow: f.workflow.name, graph: graphOf(f.workflow, f.checks) }));

describe('studio graph', () => {
  it.each(V1_WORKFLOWS)('%s: becomes a core workflow with its steps in order and its waits going back', (_, w, f) => {
    const order = stepOrder(w).order;
    expect({
      order: f.workflow.steps.map(s => s.name),
      waits: f.workflow.steps.map(s => 'wait' in s.does),
      back: f.workflow.steps.map(s => s.back?.to),
      nodes: graphOf(f.workflow, f.checks).nodes.length,
    }).toEqual({
      order,
      waits: order.map(name => w.steps[name]!.wait !== undefined),
      back: order.map(name => (w.steps[name]!.wait ? backOf(w, name) : undefined)),
      nodes: order.length,
    });
  });

  it.each(V1_HUBS)('%s: keeps each check mode, log as warn, and tells script checks from judged ones', (_, config) => {
    const [first] = fixturesOf(config);
    expect(first?.checks).toEqual(
      Object.fromEntries(
        Object.entries(config.checks).map(([name, c]) => [
          name,
          { mode: c.mode === 'log' ? 'warn' : c.mode, ...(c.type !== 'script' && { judge: c.type }) },
        ])
      )
    );
  });

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
