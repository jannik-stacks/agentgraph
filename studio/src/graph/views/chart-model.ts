import dagre from '@dagrejs/dagre';
import type { Graph } from '../../../../core/src/graph.ts';
import type { Outcome, Run } from '../../../../core/src/workflow.ts';

export type State =
  | { id: string; kind: 'step'; node: Graph['nodes'][number] }
  | { id: string; kind: 'asking' | 'stopped'; step: string }
  | { id: 'done'; kind: 'done' };

/** One arrow between two states; each line names the outcome that moves along it. */
export type Move = { from: string; to: string; lines: { outcome: Outcome['kind']; text: string }[] };

const stepId = (step: string) => `step:${step}`;
const askId = (step: string) => `asking:${step}`;
const stopId = (step: string) => `stopped:${step}`;

/** The state a run sits in. A stopped run stops at its step's own stop mark. */
export const stateOf = (run: Run) =>
  run.status === 'done'
    ? 'done'
    : run.status === 'stopped'
      ? stopId(run.step)
      : run.status === 'asking'
        ? askId(run.step)
        : stepId(run.step);

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Expands the graph the way the engine moves: every step, its asking and stop marks, done, and every outcome a move. */
export const chartOf = (graph: Graph) => {
  const states: State[] = [];
  const moves = new Map<string, Move>();
  const move = (from: string, to: string, outcome: Outcome['kind'], text: string) => {
    const key = `${from}>${to}`;
    const m = moves.get(key) ?? moves.set(key, { from, to, lines: [] }).get(key)!;
    m.lines.push({ outcome, text });
  };
  graph.nodes.forEach((node, k) => {
    const id = stepId(node.step);
    const waits = node.doer === 'human';
    const next = graph.nodes[k + 1];
    const stop = stopId(node.step);
    states.push({ id, kind: 'step', node }, { id: stop, kind: 'stopped', step: node.step });

    move(id, next ? stepId(next.step) : 'done', 'pass', waits ? 'pass, approved or merged' : 'pass');
    if (!waits && node.tries > 1) move(id, id, 'refused', `refused, ${node.tries} tries`);
    const back = graph.edges.find(e => e.kind === 'back' && e.from === node.step);
    if (back) {
      const r = back.rounds;
      const rounds = r === undefined ? 'no cap' : back.taken ? `round ${back.taken} of ${r}` : `${r} rounds`;
      move(id, stepId(back.to), 'back', waits ? `back, changes requested, ${rounds}` : `back, ${rounds}`);
      if (back.until) move(id, stepId(back.to), 'back', `until ${cut(back.until, 36)}`);
    }
    const guards = node.checks.filter(c => c.mode === 'stop').map(c => c.name);
    move(id, stop, 'stop', waits ? 'stop, closed' : guards.length ? `stop, ${guards.join(', ')} fails` : 'stop');
    if (waits) return;
    const ask = askId(node.step);
    states.push({ id: ask, kind: 'asking', step: node.step });
    move(id, ask, 'ask', 'ask');
    move(id, ask, 'refused', 'exhausted');
    if (back?.rounds !== undefined) move(id, ask, 'back', 'back, rounds out');
    move(ask, id, 'answer', 'answer');
    move(ask, stop, 'stop', 'stop');
  });
  states.push({ id: 'done', kind: 'done' });
  return { states, moves: [...moves.values()] };
};

export const sizes = {
  step: { width: 184, height: 54 },
  asking: { width: 24, height: 24 },
  stopped: { width: 24, height: 24 },
  done: { width: 40, height: 40 },
};

export const lineHeight = 12;
const textWidth = (m: Move) => Math.max(...m.lines.map(l => l.text.length)) * 5.6 + 8;
/** The self loop drawn on a step's right side, and the room it takes. */
export const loop = { reach: 26, gap: 6 };

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

/** Where the line from a box's centre towards `p` leaves the box. */
const clip = (box: Box, p: Point): Point => {
  const dx = p.x - box.x;
  const dy = p.y - box.y;
  const scale = Math.min(box.width / 2 / Math.abs(dx || 1e-9), box.height / 2 / Math.abs(dy || 1e-9), 1);
  return { x: box.x + dx * scale, y: box.y + dy * scale };
};

/** Lays the chart out top to bottom with dagre; self loops sit beside their step and dagre only leaves room. */
export const layoutChart = ({ states, moves }: ReturnType<typeof chartOf>) => {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 26, edgesep: 12, marginx: 16, marginy: 16 });
  const loops = new Map(moves.filter(m => m.from === m.to).map(m => [m.from, m]));
  const extra = (id: string) => {
    const m = loops.get(id);
    return m ? loop.reach + loop.gap + textWidth(m) : 0;
  };
  for (const s of states) g.setNode(s.id, { ...sizes[s.kind], width: sizes[s.kind].width + extra(s.id) });
  for (const m of moves)
    if (m.from !== m.to)
      g.setEdge(m.from, m.to, { width: textWidth(m), height: m.lines.length * lineHeight + 4, labelpos: 'c' });
  dagre.layout(g);
  const { width = 0, height = 0 } = g.graph();
  const boxes = new Map(
    states.map(s => {
      const { x, y } = g.node(s.id) as Point;
      return [s.id, { x: x - extra(s.id) / 2, y, ...sizes[s.kind] }];
    })
  );
  return {
    width,
    height,
    states: states.map(s => ({ ...s, ...boxes.get(s.id)! })),
    moves: moves.map(m => {
      const from = boxes.get(m.from)!;
      if (m.from === m.to) {
        const x = from.x + from.width / 2;
        return {
          ...m,
          self: true,
          points: [],
          label: { x: x + loop.reach + loop.gap, y: from.y, width: 0, height: 0 },
          path: `M${x},${from.y - 9}C${x + loop.reach},${from.y - 22} ${x + loop.reach},${from.y + 22} ${x + 1},${from.y + 9}`,
        };
      }
      const e = g.edge(m.from, m.to) as { points: Point[]; x: number; y: number };
      const inner = e.points.slice(1, -1);
      const points = [
        clip(from, inner[0] ?? e.points.at(-1)!),
        ...inner,
        clip(boxes.get(m.to)!, inner.at(-1) ?? e.points[0]!),
      ];
      return {
        ...m,
        self: false,
        points,
        label: { x: e.x, y: e.y, width: textWidth(m), height: m.lines.length * lineHeight },
        path: spline(points),
      };
    }),
  };
};

/** A smooth path through the points, the B-spline dagre's points are meant for. */
const spline = (points: Point[]) => {
  const [first, ...rest] = points;
  if (!first) return '';
  let d = `M${first.x},${first.y}`;
  let [a, b] = [first, rest[0] ?? first];
  if (rest.length === 1) return `${d}L${b.x},${b.y}`;
  d += `L${(5 * a.x + b.x) / 6},${(5 * a.y + b.y) / 6}`;
  for (const p of [...rest.slice(1), rest.at(-1)!]) {
    d += `C${(2 * a.x + b.x) / 3},${(2 * a.y + b.y) / 3} ${(a.x + 2 * b.x) / 3},${(a.y + 2 * b.y) / 3} ${(a.x + 4 * b.x + p.x) / 6},${(a.y + 4 * b.y + p.y) / 6}`;
    [a, b] = [b, p];
  }
  return `${d}L${b.x},${b.y}`;
};
