import dagre from '@dagrejs/dagre';
import type { GraphEdge, GraphModel, NodeKind } from '../graph-model.ts';

export const nodeSize = { width: 232, height: 72 };

/** The size of a stack node, as wide as a step and shorter. */
export const stackSize = { width: nodeSize.width, height: 48 };

export type Point = { x: number; y: number };
export type Box = Point & { width: number; height: number };
export type EdgeRoute = { points: Point[]; label?: Point };

const labelHeight = 18;
const charWidth = 6.2;
export const labelWidth = (text: string) => Math.ceil(text.length * charWidth) + 18;

export const edgeId = (edge: GraphEdge) => `${edge.kind}:${edge.from}->${edge.to}`;

/** Room kept under a node for its self-loop and the loop's label. */
export const loopDepth = 18;
export const loopRoom = loopDepth + labelHeight + 12;
const stackGap = 12;
const laneGap = 56;
const laneCol = nodeSize.width + 28;
const laneRow = nodeSize.height + 36;

const spineKinds = new Set<NodeKind>(['trigger', 'job', 'script']);
const castKinds = new Set<NodeKind>(['bot', 'skill']);

/** The size of a bot or skill node, small enough for a pair to sit under the step that casts them. */
export const castSize = { width: 112, height: 34 };
const castGap = nodeSize.width - 2 * castSize.width;

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Places each unplaced bot and skill under the first placed step that casts it, side by side in the step's column,
 * starting at `top` and moving down a row where another pair is in the way. Returns the bottom of what it placed.
 */
const beneath = (ids: string[], edges: GraphEdge[], boxes: Map<string, Box>, top: number) => {
  const casters = new Map<string, string[]>();
  for (const id of ids) {
    if (boxes.has(id)) continue;
    const by = edges
      .filter(e => e.to === id && e.from !== id && boxes.has(e.from))
      .map(e => e.from)
      .sort((a, b) => boxes.get(a)!.x - boxes.get(b)!.x || boxes.get(a)!.y - boxes.get(b)!.y)[0];
    if (by) casters.set(by, [...(casters.get(by) ?? []), id]);
  }
  const placed: Box[] = [];
  let bottom = top;
  for (const [caster, cast] of [...casters].sort(([a], [b]) => boxes.get(a)!.x - boxes.get(b)!.x))
    cast.forEach((id, i) => {
      let box = { x: boxes.get(caster)!.x + (i % 2) * (castSize.width + castGap), y: top + stackGap, ...castSize };
      while (placed.some(other => overlap(other, box))) box = { ...box, y: box.y + castSize.height + stackGap };
      placed.push(box);
      boxes.set(id, box);
      bottom = Math.max(bottom, box.y + box.height);
    });
  return bottom;
};

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
 * The checks a job retries until they pass, stacked right after it in the order of the model's nodes; a check shared
 * by jobs stays with the first.
 */
export const checkGroups = ({ nodes, edges }: GraphModel) => {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const groups = new Map<string, string[]>();
  const placed = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'loops-back' || placed.has(edge.from)) continue;
    if (!edges.some(e => e.kind === 'gates' && e.from === edge.from && e.to === edge.to)) continue;
    placed.add(edge.from);
    groups.set(edge.to, [...(groups.get(edge.to) ?? []), edge.from]);
  }
  for (const checks of groups.values()) checks.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
  return groups;
};

/** Places nodes in rows below `top`, each near the middle of what it links to, wrapping at `width`. */
const lane = (
  ids: string[],
  near: (id: string) => number,
  size: (id: string) => typeof nodeSize,
  left: number,
  top: number,
  width: number
) => {
  const perRow = Math.max(3, Math.floor(width / laneCol));
  const sorted = ids.map(id => ({ id, at: near(id) })).sort((a, b) => a.at - b.at);
  const boxes = new Map<string, Box>();
  for (let row = 0; row * perRow < sorted.length; row++) {
    const items = sorted.slice(row * perRow, (row + 1) * perRow);
    const xs = items.map(item => Math.max(left, item.at - nodeSize.width / 2));
    for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i]!, xs[i - 1]! + laneCol);
    const right = left + Math.max(width, perRow * laneCol) - nodeSize.width;
    for (let i = xs.length - 1; i >= 0; i--) xs[i] = Math.min(xs[i]!, (xs[i + 1] ?? right + laneCol) - laneCol);
    items.forEach((item, i) => boxes.set(item.id, { x: xs[i]!, y: top + row * laneRow, ...size(item.id) }));
  }
  return { boxes, bottom: top + Math.ceil(sorted.length / perRow) * laneRow };
};

/** The room a workflow frame keeps around its members, and the height of its title row. */
export const frame = { pad: 14, title: 28 };
const clusterGap = 24;

/**
 * A left-to-right dagre layout of the pipeline: triggers, jobs and the checks they flow through, with the checks in
 * `groups` stacked right after their job and whatever follows the job placed after the stack. The pipeline of each
 * workflow `clusterOf` names is laid out on its own and the workflows are stacked top to bottom, leaving room for a
 * frame around each. Underneath, each step's bot and skill sit in its column, then loose checks with theirs, then
 * bots and skills nothing casts. Routes are kept for the pipeline edges dagre placed.
 */
export const layout = (
  { nodes, edges }: GraphModel,
  label: (edge: GraphEdge) => string | undefined,
  groups: Map<string, string[]>,
  clusterOf: (id: string) => string | undefined = () => undefined
) => {
  const grouped = new Map([...groups].flatMap(([job, checks]) => checks.map(check => [check, job] as const)));
  const kinds = new Map(nodes.map(node => [node.id, node.kind]));
  const stacks = new Set(nodes.filter(node => node.stack).map(node => node.id));
  const size = (id: string) => (stacks.has(id) ? stackSize : nodeSize);
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

  const clusters = new Map<string, string[]>();
  const cluster = (id: string) => clusterOf(grouped.get(id) ?? id) ?? '';
  for (const id of [...inSpine, ...grouped.keys()])
    clusters.set(cluster(id), [...(clusters.get(cluster(id)) ?? []), id]);
  const end = (id: string) => (grouped.has(id) ? `group:${grouped.get(id)}` : id);

  const boxes = new Map<string, Box>();
  const laid: { g: InstanceType<typeof dagre.graphlib.Graph>; dx: number; dy: number }[] = [];
  let top = 24;
  let width = laneCol * 3;
  for (const [name, members] of [...clusters].sort(([a], [b]) => Number(!a) - Number(!b))) {
    const inside = new Set(members);
    const g = new dagre.graphlib.Graph({ multigraph: true })
      .setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 64, edgesep: 14, marginx: 0, marginy: 0 })
      .setDefaultEdgeLabel(() => ({}));
    for (const id of members.filter(id => inSpine.has(id))) {
      const loop = loops.get(id);
      const room = loop !== undefined && !groups.has(id);
      g.setNode(id, {
        width: room ? Math.max(nodeSize.width, labelWidth(loop)) : nodeSize.width,
        height: size(id).height + (room ? loopRoom : 0),
      });
    }
    for (const [job, checks] of groups) {
      if (!inside.has(job)) continue;
      g.setNode(`group:${job}`, {
        width: nodeSize.width,
        height:
          checks.reduce((sum, check) => sum + size(check).height, 0) +
          (checks.length - 1) * stackGap +
          (loops.has(job) ? loopRoom : 0),
      });
      g.setEdge(job, `group:${job}`, { weight: 4 }, `gate:${job}`);
    }
    for (const edge of edges) {
      if (edge.from === edge.to || edge.kind === 'loops-back') continue;
      if (!inside.has(edge.from) || !inside.has(edge.to)) continue;
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
    const [dx, dy] = name ? [24 + frame.pad, top + frame.title + frame.pad] : [24, top];
    laid.push({ g, dx, dy });
    for (const id of members.filter(id => inSpine.has(id))) {
      const { x, y, height } = g.node(id);
      boxes.set(id, { x: dx + x - nodeSize.width / 2, y: dy + y - height / 2, ...size(id) });
    }
    for (const [job, checks] of groups) {
      if (!inside.has(job)) continue;
      const { x, y, height } = g.node(`group:${job}`);
      let at = dy + y - height / 2;
      for (const check of checks) {
        boxes.set(check, { x: dx + x - nodeSize.width / 2, y: at, ...size(check) });
        at += size(check).height + stackGap;
      }
    }
    const graph = g.graph() as { width?: number; height?: number };
    width = Math.max(width, graph.width ?? 0);
    top = dy + (graph.height ?? 0) + (name ? frame.pad : 0) + clusterGap;
  }

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
  const casts = rest.filter(node => castKinds.has(node.kind)).map(node => node.id);
  const castTop = top - clusterGap + laneGap / 2;
  const underSpine = beneath(casts, edges, boxes, castTop);
  const loose = lane(
    rest.filter(node => !castKinds.has(node.kind)).map(node => node.id),
    centre,
    size,
    24,
    underSpine + (underSpine > castTop ? laneGap : 0),
    width
  );
  loose.boxes.forEach((box, id) => boxes.set(id, box));
  const underLoose = beneath(casts, edges, boxes, loose.bottom);
  let x = 24;
  for (const id of casts.filter(id => !boxes.has(id))) {
    boxes.set(id, { x, y: underLoose + stackGap, ...castSize });
    x += castSize.width + castGap;
  }

  const routes = new Map<string, EdgeRoute>();
  const ports: Port[] = [];
  for (const { g, dx, dy } of laid)
    for (const e of g.edges()) {
      const edge = g.edge(e) as { points?: Point[]; x?: number; y?: number; width?: number };
      const points = (edge.points ?? []).map(p => ({ x: p.x + dx, y: p.y + dy }));
      if (!boxes.has(e.v) || !boxes.has(e.w) || points.length < 2 || !e.name) continue;
      const inner = points.slice(1, -1);
      const out: Port = { node: e.v, toward: inner[0] ?? points.at(-1)!, at: { x: 0, y: 0 } };
      const into: Port = { node: e.w, toward: inner.at(-1) ?? points[0]!, at: { x: 0, y: 0 } };
      ports.push(out, into);
      routes.set(e.name, {
        points: [out.at, ...inner, into.at],
        ...(edge.x !== undefined &&
          edge.y !== undefined &&
          edge.width && { label: { x: edge.x + dx, y: edge.y + dy } }),
      });
    }
  spread(ports, boxes);
  clusters.delete('');
  return { boxes, routes, main: new Set([...inSpine, ...grouped.keys()]), clusters };
};
