import type { Graph } from '../../../src/graph.ts';
import { chipsOf, linesOf } from './chips.ts';

type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

const pillHeight = 28;
const pad = 28;
const header = 36;
const rowGap = 36;
const stepGap = 64;
const endGap = 32;
/** Vertical distance between the lanes of ways back above a row. */
const lane = 26;
/** Horizontal offset between edges sharing a side, so their verticals never overlap. */
const nest = 14;

const stepWidth = 268;
/** The width chips may fill inside a step, past its border and padding. */
export const chipRoom = stepWidth - 22;
/** The trigger label wraps onto two lines past this width. */
const triggerMax = 150;

export type Row = {
  workflow: string;
  frame: Box;
  nodes: { id: string; kind: 'trigger' | 'step' | 'done'; step?: string; box: Box }[];
  backs: { edge: Graph['edges'][number]; points: Point[] }[];
};

/** An edge from a step of one workflow to the trigger of another. */
export type Start = { workflow: string; step: string; target: string };

/**
 * Lays each workflow out on one line, trigger first and done last, and stacks the rows. Ways back run in nested lanes
 * above their row; starts of other workflows run down below the source row, along a gutter left of all rows, and into
 * the target's trigger.
 */
export const layout = (graphs: { workflow: string; graph: Graph }[], starts: Start[]) => {
  const gutter = 16 + nest * starts.length;
  const lines = Math.max(1, ...graphs.flatMap(g => g.graph.nodes.map(n => linesOf(chipsOf(n), chipRoom).length)));
  const stepHeight = 62 + 20 * lines;
  let top = 0;
  const rows = graphs.map(({ workflow, graph }): Row => {
    const backEdges = graph.edges
      .filter(e => e.kind === 'back')
      .map(e => ({ e, span: Math.abs(indexOf(graph, e.from) - indexOf(graph, e.to)) }))
      .toSorted((a, b) => a.span - b.span);
    const above = backEdges.length ? 20 + (backEdges.length - 1) * lane + 16 : 0;
    const stepTop = top + header + above;
    const mid = stepTop + stepHeight / 2;
    let x = gutter + pad;
    const place = (id: string, kind: Row['nodes'][number]['kind'], width: number, height: number, step?: string) => {
      const node = { id, kind, ...(step && { step }), box: { x, y: mid - height / 2, width, height } };
      x += width;
      return node;
    };
    const triggerWidth = Math.min(triggerMax, Math.ceil(18 + graph.trigger.length * 5.9));
    const nodes = [place(`${workflow}:trigger`, 'trigger', triggerWidth, pillHeight)];
    graph.nodes.forEach((n, i) => {
      x += i ? stepGap : endGap;
      nodes.push(place(`${workflow}/${n.step}`, 'step', stepWidth, stepHeight, n.step));
    });
    x += endGap;
    nodes.push(place(`${workflow}:done`, 'done', 64, pillHeight));
    const boxOf = (step: string) => nodes.find(n => n.step === step)!.box;
    const backs = backEdges.map(({ e }, k) => {
      const from = boxOf(e.from);
      const to = boxOf(e.to);
      const y = stepTop - 20 - k * lane;
      const out = from.x + from.width * 0.3 + k * nest;
      const into = to.x + to.width * 0.7 - k * nest;
      return { edge: e, points: [p(out, stepTop), p(out, y), p(into, y), p(into, stepTop - 4)] };
    });
    const frame = { x: gutter, y: top, width: x + pad - gutter, height: header + above + stepHeight + pad };
    top += frame.height + rowGap;
    return { workflow, frame, nodes, backs };
  });
  const routes = starts.map((s, k) => {
    const from = rows.find(r => r.workflow === s.workflow)!;
    const box = from.nodes.find(n => n.step === s.step)!.box;
    const to = rows.find(r => r.workflow === s.target)!.nodes[0]!.box;
    const cx = box.x + box.width / 2;
    const below = from.frame.y + from.frame.height + 12 + (k % 3) * 8;
    const side = gutter - 8 - k * nest;
    const ty = to.y + to.height / 2;
    return { ...s, points: [p(cx, box.y + box.height), p(cx, below), p(side, below), p(side, ty), p(to.x - 4, ty)] };
  });
  return { rows, starts: routes };
};

const p = (x: number, y: number): Point => ({ x, y });
const indexOf = (graph: Graph, step: string) => graph.nodes.findIndex(n => n.step === step);
