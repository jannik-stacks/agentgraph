import dagre from '@dagrejs/dagre';
import type { GraphEdge, GraphModel } from '../graph-model.ts';

export const nodeSize = { width: 232, height: 72 };

export type Point = { x: number; y: number };
export type Box = Point & { width: number; height: number };
export type EdgeRoute = { points: Point[]; label?: Point };

const labelHeight = 18;
const charWidth = 6.2;
export const labelWidth = (text: string) => Math.ceil(text.length * charWidth) + 18;

export const edgeId = (edge: GraphEdge) => `${edge.kind}:${edge.from}->${edge.to}`;

/** Room kept under a node for its self-loop and the loop's label. */
export const loopDepth = 18;
const loopRoom = loopDepth + labelHeight + 12;

type Port = { node: string; toward: Point; at: Point };

/** Spreads the ports on each side of a node evenly along that side, in the order of where their edges come from. */
const spread = (ports: Port[], boxes: Map<string, Box>) => {
  const sides = new Map<string, Port[]>();
  for (const port of ports) {
    const box = boxes.get(port.node)!;
    const key = `${port.node}:${port.toward.x < box.x + box.width / 2 ? 'left' : 'right'}`;
    sides.set(key, [...(sides.get(key) ?? []), port]);
  }
  for (const [key, group] of sides) {
    const box = boxes.get(group[0]!.node)!;
    const x = key.endsWith(':left') ? box.x : box.x + box.width;
    const step = Math.min(14, box.height / (group.length + 1));
    const start = box.y + box.height / 2 - (step * (group.length - 1)) / 2;
    group
      .sort((a, b) => a.toward.y - b.toward.y)
      .forEach((port, i) => Object.assign(port.at, { x, y: start + i * step }));
  }
};

/**
 * A left-to-right dagre layout: node boxes, and for every edge the route dagre found with the label space it
 * reserved. Self-loops are left out of ranking and get room underneath their node instead.
 */
export const layout = ({ nodes, edges }: GraphModel, label: (edge: GraphEdge) => string | undefined) => {
  const g = new dagre.graphlib.Graph({ multigraph: true })
    .setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 56, edgesep: 14, marginx: 24, marginy: 24 })
    .setDefaultEdgeLabel(() => ({}));
  const loops = new Map<string, string>();
  for (const edge of edges) {
    const text = label(edge);
    if (edge.from === edge.to) loops.set(edge.from, text ?? '');
  }
  for (const node of nodes) {
    const loop = loops.get(node.id);
    g.setNode(node.id, {
      width: loop === undefined ? nodeSize.width : Math.max(nodeSize.width, labelWidth(loop)),
      height: nodeSize.height + (loop === undefined ? 0 : loopRoom),
    });
  }
  for (const edge of edges) {
    if (edge.from === edge.to || edge.kind === 'loops-back') continue;
    const text = label(edge);
    g.setEdge(
      edge.from,
      edge.to,
      text ? { width: labelWidth(text), height: labelHeight, labelpos: 'c' } : {},
      edgeId(edge)
    );
  }
  dagre.layout(g);
  const boxes = new Map<string, Box>(
    nodes.map(node => {
      const { x, y, height } = g.node(node.id);
      return [node.id, { x: x - nodeSize.width / 2, y: y - height / 2, ...nodeSize }];
    })
  );
  const routes = new Map<string, EdgeRoute>();
  const ports: Port[] = [];
  for (const e of g.edges()) {
    const { points = [], x, y, width } = g.edge(e) as { points?: Point[]; x?: number; y?: number; width?: number };
    if (!boxes.has(e.v) || !boxes.has(e.w) || points.length < 2 || !e.name) continue;
    const inner = points.slice(1, -1);
    const out: Port = { node: e.v, toward: inner[0] ?? points.at(-1)!, at: { x: 0, y: 0 } };
    const into: Port = { node: e.w, toward: inner.at(-1) ?? points[0]!, at: { x: 0, y: 0 } };
    ports.push(out, into);
    routes.set(e.name, {
      points: [out.at, ...inner, into.at],
      ...(x !== undefined && y !== undefined && width && { label: { x, y } }),
    });
  }
  spread(ports, boxes);
  return { boxes, routes };
};
