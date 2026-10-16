import dagre from '@dagrejs/dagre';
import type { Graph } from '../../../src/graph.ts';

export type Box = { x: number; y: number; width: number; height: number };

export const stepSize = { width: 224, height: 80 };
const pillSize = { width: 150, height: 28 };
const doneSize = { width: 64, height: 28 };
const pad = 28;
const header = 36;
const gap = 36;

/** How high a way back arcs over its row, so arcs into the same step nest. */
export const liftOf = (dx: number) => 40 + Math.abs(dx) * 0.12;

/** The x where a way back leaves its step and where it lands, both on the top side. */
export const backOut = 0.3;
export const backIn = 0.7;

export type Row = {
  workflow: string;
  frame: Box;
  nodes: { id: string; kind: 'trigger' | 'step' | 'done'; step?: string; box: Box }[];
};

/**
 * Lays each workflow out left to right with dagre, trigger first and done last, and stacks the rows. Each row leaves
 * room above for the arcs of its ways back.
 */
export const layout = (graphs: { workflow: string; graph: Graph }[]): Row[] => {
  let top = 0;
  return graphs.map(({ workflow, graph }) => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 64 });
    g.setDefaultEdgeLabel(() => ({}));
    const id = (step: string) => `${workflow}/${step}`;
    const trigger = `${workflow}:trigger`;
    const done = `${workflow}:done`;
    g.setNode(trigger, { ...pillSize });
    for (const n of graph.nodes) g.setNode(id(n.step), { ...stepSize });
    g.setNode(done, { ...doneSize });
    const chain = [trigger, ...graph.nodes.map(n => id(n.step)), done];
    chain.slice(1).forEach((to, i) => g.setEdge(chain[i]!, to));
    dagre.layout(g);

    const boxOf = (key: string): Box => {
      const { x, y, width, height } = g.node(key);
      return { x: x - width / 2, y: y - height / 2, width, height };
    };
    const raw = chain.map(key => ({ key, box: boxOf(key) }));
    const arcs = graph.edges
      .filter(e => e.kind === 'back')
      .map(e => {
        const from = boxOf(id(e.from));
        const to = boxOf(id(e.to));
        return liftOf(from.x + from.width * backOut - (to.x + to.width * backIn)) * 0.75 + 16;
      });
    const minY = Math.min(...raw.map(r => r.box.y));
    const above = Math.max(0, ...arcs);
    const dy = top + header + above - minY;
    const nodes = raw.map(({ key, box }, i): Row['nodes'][number] => ({
      id: key,
      kind: i === 0 ? 'trigger' : i === raw.length - 1 ? 'done' : 'step',
      ...(i > 0 && i < raw.length - 1 && { step: graph.nodes[i - 1]!.step }),
      box: { ...box, x: box.x + pad, y: box.y + dy },
    }));
    const width = Math.max(...nodes.map(n => n.box.x + n.box.width)) + pad;
    const height = Math.max(...nodes.map(n => n.box.y + n.box.height)) + pad - top;
    const frame = { x: 0, y: top, width, height };
    top += height + gap;
    return { workflow, frame, nodes };
  });
};
