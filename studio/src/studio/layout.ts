import dagre from '@dagrejs/dagre';
import type { GraphEdge, GraphModel, NodeKind } from '../graph-model.ts';

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
const stackGap = 12;
const laneGap = 56;
const laneCol = nodeSize.width + 28;
const laneRow = nodeSize.height + 36;

const spineKinds = new Set<NodeKind>(['trigger', 'job', 'script']);
const nearKinds = new Set<NodeKind>(['bot', 'skill', 'check']);

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

/** The checks a job retries until they pass, stacked right after it; a check shared by jobs stays with the first. */
export const checkGroups = ({ edges }: GraphModel) => {
  const groups = new Map<string, string[]>();
  const placed = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'loops-back' || placed.has(edge.from)) continue;
    if (!edges.some(e => e.kind === 'gates' && e.from === edge.from && e.to === edge.to)) continue;
    placed.add(edge.from);
    groups.set(edge.to, [...(groups.get(edge.to) ?? []), edge.from]);
  }
  return groups;
};

/** Places nodes in rows below `top`, each near the middle of what it links to, wrapping at `width`. */
const lane = (ids: string[], near: (id: string) => number, left: number, top: number, width: number) => {
  const perRow = Math.max(3, Math.floor(width / laneCol));
  const sorted = ids.map(id => ({ id, at: near(id) })).sort((a, b) => a.at - b.at);
  const boxes = new Map<string, Box>();
  for (let row = 0; row * perRow < sorted.length; row++) {
    const items = sorted.slice(row * perRow, (row + 1) * perRow);
    const xs = items.map(item => Math.max(left, item.at - nodeSize.width / 2));
    for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i]!, xs[i - 1]! + laneCol);
    const right = left + Math.max(width, perRow * laneCol) - nodeSize.width;
    for (let i = xs.length - 1; i >= 0; i--) xs[i] = Math.min(xs[i]!, (xs[i + 1] ?? right + laneCol) - laneCol);
    items.forEach((item, i) => boxes.set(item.id, { x: xs[i]!, y: top + row * laneRow, ...nodeSize }));
  }
  return { boxes, bottom: top + Math.ceil(sorted.length / perRow) * laneRow };
};

/**
 * A left-to-right dagre layout of the pipeline: triggers, jobs and the checks they flow through, with the checks in
 * `groups` stacked right after their job and whatever follows the job placed after the stack. Everything the
 * pipeline uses goes in lanes underneath: bots, skills and loose checks first, then notes, the issue tracker and
 * tools. Routes are kept for the pipeline edges dagre placed.
 */
export const layout = (
  { nodes, edges }: GraphModel,
  label: (edge: GraphEdge) => string | undefined,
  groups: Map<string, string[]>
) => {
  const grouped = new Map([...groups].flatMap(([job, checks]) => checks.map(check => [check, job] as const)));
  const kinds = new Map(nodes.map(node => [node.id, node.kind]));
  const pipeline = (id: string) => spineKinds.has(kinds.get(id)!);
  const flowing = (id: string) =>
    kinds.get(id) === 'check' &&
    edges.some(
      e => e.kind !== 'loops-back' && ((e.from === id && pipeline(e.to)) || (e.to === id && pipeline(e.from)))
    );
  const spine = nodes.filter(node => !grouped.has(node.id) && (pipeline(node.id) || flowing(node.id)));
  const inSpine = new Set(spine.map(node => node.id));
  const loops = new Map<string, string>();
  for (const edge of edges) if (edge.from === edge.to) loops.set(edge.from, label(edge) ?? '');

  const g = new dagre.graphlib.Graph({ multigraph: true })
    .setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 64, edgesep: 14, marginx: 24, marginy: 24 })
    .setDefaultEdgeLabel(() => ({}));
  for (const node of spine) {
    const loop = loops.get(node.id);
    const room = loop !== undefined && !groups.has(node.id);
    g.setNode(node.id, {
      width: room ? Math.max(nodeSize.width, labelWidth(loop)) : nodeSize.width,
      height: nodeSize.height + (room ? loopRoom : 0),
    });
  }
  for (const [job, checks] of groups)
    g.setNode(`group:${job}`, {
      width: nodeSize.width,
      height: checks.length * nodeSize.height + (checks.length - 1) * stackGap + (loops.has(job) ? loopRoom : 0),
    });
  for (const [job] of groups) g.setEdge(job, `group:${job}`, { weight: 4 }, `gate:${job}`);
  const end = (id: string) => (grouped.has(id) ? `group:${grouped.get(id)}` : id);
  for (const edge of edges) {
    if (edge.from === edge.to || edge.kind === 'loops-back') continue;
    if (!(inSpine.has(edge.from) || grouped.has(edge.from)) || !(inSpine.has(edge.to) || grouped.has(edge.to)))
      continue;
    const from = groups.has(edge.from) ? `group:${edge.from}` : end(edge.from);
    const to = end(edge.to);
    if (from === to || from === `group:${to}`) continue;
    const text = label(edge);
    g.setEdge(
      from,
      to,
      { weight: 2, ...(text && { width: labelWidth(text), height: labelHeight, labelpos: 'c' }) },
      edgeId(edge)
    );
  }
  dagre.layout(g);

  const boxes = new Map<string, Box>();
  for (const node of spine) {
    const { x, y, height } = g.node(node.id);
    boxes.set(node.id, { x: x - nodeSize.width / 2, y: y - height / 2, ...nodeSize });
  }
  for (const [job, checks] of groups) {
    const { x, y, height } = g.node(`group:${job}`);
    checks.forEach((check, i) =>
      boxes.set(check, {
        x: x - nodeSize.width / 2,
        y: y - height / 2 + i * (nodeSize.height + stackGap),
        ...nodeSize,
      })
    );
  }

  const graph = g.graph() as { width?: number; height?: number };
  const width = Math.max((graph.width ?? 0) - 48, laneCol * 3);
  const neighbours = (id: string) =>
    edges.flatMap(e => (e.from === id ? [e.to] : e.to === id ? [e.from] : [])).filter(other => other !== id);
  const centre = (id: string) => {
    const xs = neighbours(id).flatMap(other => {
      const box = boxes.get(other);
      return box ? [box.x + box.width / 2] : [];
    });
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 24 + width / 2;
  };
  const rest = nodes.filter(node => !inSpine.has(node.id) && !grouped.has(node.id));
  const first = lane(
    rest.filter(node => nearKinds.has(node.kind)).map(node => node.id),
    centre,
    24,
    (graph.height ?? 0) + laneGap - 24,
    width
  );
  first.boxes.forEach((box, id) => boxes.set(id, box));
  const second = lane(
    rest.filter(node => !nearKinds.has(node.kind)).map(node => node.id),
    centre,
    24,
    first.bottom + laneGap / 2,
    width
  );
  second.boxes.forEach((box, id) => boxes.set(id, box));

  const routes = new Map<string, EdgeRoute>();
  const ports: Port[] = [];
  for (const e of g.edges()) {
    const { points = [], x, y, width: w } = g.edge(e) as { points?: Point[]; x?: number; y?: number; width?: number };
    if (!boxes.has(e.v) || !boxes.has(e.w) || points.length < 2 || !e.name) continue;
    const inner = points.slice(1, -1);
    const out: Port = { node: e.v, toward: inner[0] ?? points.at(-1)!, at: { x: 0, y: 0 } };
    const into: Port = { node: e.w, toward: inner.at(-1) ?? points[0]!, at: { x: 0, y: 0 } };
    ports.push(out, into);
    routes.set(e.name, {
      points: [out.at, ...inner, into.at],
      ...(x !== undefined && y !== undefined && w && { label: { x, y } }),
    });
  }
  spread(ports, boxes);
  return { boxes, routes, main: new Set([...inSpine, ...grouped.keys()]) };
};
