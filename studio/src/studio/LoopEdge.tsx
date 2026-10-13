import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  type InternalNode,
  Position,
  useStore,
} from '@xyflow/react';
import type { CSSProperties } from 'react';
import { cx } from '../ui.tsx';
import { type Box, loopDepth, nodeSize, type Point } from './layout.ts';

export type RouteData = {
  points?: Point[];
  at?: [Point, Point];
  via?: string[];
  label?: string;
  quiet?: boolean;
  labelAt?: Point;
  color: string;
  dim?: boolean;
};
export type LoopData = { checks: string[]; label?: string; color: string; dim?: boolean };
export type RoutedFlowEdge = Edge<RouteData, 'routed'>;
export type LoopFlowEdge = Edge<LoopData, 'loop'>;

const sameNodes = (a: (InternalNode | undefined)[], b: (InternalNode | undefined)[]) =>
  a.length === b.length && a.every((node, i) => node === b[i]);

const boxOf = (node: InternalNode | undefined): Box | undefined =>
  node && {
    ...node.internals.positionAbsolute,
    width: node.measured.width ?? nodeSize.width,
    height: node.measured.height ?? nodeSize.height,
  };

/** The current boxes of the given nodes, following them as they are dragged. */
const useBoxes = (ids: string[]) => useStore(s => ids.map(id => s.nodeLookup.get(id)), sameNodes).map(boxOf);

const union = (boxes: (Box | undefined)[]): Box | undefined => {
  const present = boxes.filter((box): box is Box => !!box);
  if (!present.length) return;
  const x = Math.min(...present.map(b => b.x));
  const y = Math.min(...present.map(b => b.y));
  return {
    x,
    y,
    width: Math.max(...present.map(b => b.x + b.width)) - x,
    height: Math.max(...present.map(b => b.y + b.height)) - y,
  };
};

const anchor = (box: Box, side: Position): Point =>
  side === Position.Left
    ? { x: box.x, y: box.y + box.height / 2 }
    : side === Position.Right
      ? { x: box.x + box.width, y: box.y + box.height / 2 }
      : side === Position.Top
        ? { x: box.x + box.width / 2, y: box.y }
        : { x: box.x + box.width / 2, y: box.y + box.height };

const corner = 8;

/** A right-angled path with rounded corners between the facing sides of two boxes. */
const between = (s: Box, t: Box) => {
  const dx = t.x - (s.x + s.width);
  const dy = t.y - (s.y + s.height);
  const up = s.y - (t.y + t.height);
  const [from, to] =
    dx >= 24 && dx * 2 >= Math.max(dy, up)
      ? [Position.Right, Position.Left]
      : dy > 0
        ? [Position.Bottom, Position.Top]
        : up > 0
          ? [Position.Top, Position.Bottom]
          : dx > -8
            ? [Position.Right, Position.Left]
            : [Position.Left, Position.Right];
  const a = anchor(s, from);
  const b = anchor(t, to);
  const [path, x, y] = getSmoothStepPath({
    sourceX: a.x,
    sourceY: a.y,
    sourcePosition: from,
    targetX: b.x,
    targetY: b.y,
    targetPosition: to,
    borderRadius: corner,
  });
  return { path, label: { x, y } };
};

/** Turns each step between two points into horizontal, vertical, horizontal runs that turn halfway across. */
const elbows = (points: Point[]) =>
  points.flatMap((p, i) => {
    const prev = points[i - 1];
    if (!prev || Math.abs(prev.y - p.y) < 0.5) return [p];
    const x = (prev.x + p.x) / 2;
    return [{ x, y: prev.y }, { x, y: p.y }, p];
  });

const toward = (from: Point, to: Point, by: number) => {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) * by) / length, y: from.y + ((to.y - from.y) * by) / length };
};

/** A right-angled path through every point with rounded corners, leaving and entering the nodes horizontally. */
const orthogonal = (points: Point[]) => {
  const runs = elbows(points);
  const [start] = runs;
  if (!start) return '';
  let d = `M ${start.x} ${start.y}`;
  for (let i = 1; i < runs.length - 1; i++) {
    const [prev, at, next] = [runs[i - 1]!, runs[i]!, runs[i + 1]!];
    const r = Math.min(
      corner,
      Math.hypot(at.x - prev.x, at.y - prev.y) / 2,
      Math.hypot(next.x - at.x, next.y - at.y) / 2
    );
    const [a, b] = [toward(at, prev, r), toward(at, next, r)];
    d += ` L ${a.x} ${a.y} Q ${at.x} ${at.y}, ${b.x} ${b.y}`;
  }
  const end = runs.at(-1)!;
  return `${d} L ${end.x} ${end.y}`;
};

const Label = ({ at, text, color, dim }: { at: Point; text: string; color: string; dim?: boolean | undefined }) => (
  <EdgeLabelRenderer>
    <div
      style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)`, borderColor: color }}
      className={cx(
        'nodrag nopan pointer-events-none absolute whitespace-nowrap rounded-full border bg-white px-2 text-[11px] leading-4 text-zinc-700 shadow-sm dark:bg-zinc-950 dark:text-zinc-200',
        dim && 'opacity-30'
      )}
    >
      {text}
    </div>
  </EdgeLabelRenderer>
);

const faded = (style: CSSProperties | undefined, dim: boolean | undefined) =>
  dim ? { ...style, opacity: 0.18 } : style;

const still = (box: Box | undefined, at: Point | undefined) =>
  !!box && !!at && Math.abs(box.x - at.x) < 0.5 && Math.abs(box.y - at.y) < 0.5;

/** Joins the right sides of a stack of boxes on one vertical line and leads from its middle on to `to`. */
const merge = (stack: Box[], to: Box) => {
  const x = Math.max(...stack.map(b => b.x + b.width)) + 16;
  const ys = stack.map(b => b.y + b.height / 2);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const onward = between({ x: x - 1, y: mid, width: 1, height: 0 }, to);
  const ticks = stack.map((b, i) => `M ${b.x + b.width} ${ys[i]} L ${x} ${ys[i]}`).join(' ');
  return { path: `${ticks} M ${x} ${Math.min(...ys)} L ${x} ${Math.max(...ys)} ${onward.path}`, label: onward.label };
};

/**
 * An edge along the route the layout found, in right angles, while both ends stay where the layout put them,
 * otherwise a right-angled path between the nodes. With `via`, the edge gathers that stack of nodes and leads from it instead of its source.
 */
export const RoutedEdge = ({ source, target, data, style, markerEnd }: EdgeProps<RoutedFlowEdge>) => {
  const via = data?.via ?? [];
  const [from, to, ...rest] = useBoxes([source, target, ...via]);
  if (!data || !from || !to) return null;
  const stack = rest.filter((box): box is Box => !!box);
  const placed = !stack.length && data.points && still(from, data.at?.[0]) && still(to, data.at?.[1]);
  const free = placed ? undefined : stack.length ? merge(stack, to) : between(from, to);
  const s = faded(style, data.dim);
  const at = placed ? data.labelAt : free?.label;
  return (
    <>
      <BaseEdge
        path={free?.path ?? orthogonal(data.points!)}
        {...(s && { style: s })}
        {...(markerEnd && { markerEnd })}
      />
      {data.label && !data.quiet && at && <Label at={at} text={data.label} color={data.color} dim={data.dim} />}
    </>
  );
};

const radius = 10;

/**
 * A retry loop: from under the job's checks back up into the job, or a loop under the job itself when it has no
 * checks beside it.
 */
export const LoopEdge = ({ source, data, style, markerEnd }: EdgeProps<LoopFlowEdge>) => {
  const [job, ...checks] = useBoxes([source, ...(data?.checks ?? [])]);
  if (!data || !job) return null;
  const stack = union(checks);
  const from = stack ? stack.x + stack.width / 2 : job.x + job.width * 0.78;
  const to = stack ? job.x + job.width / 2 : job.x + job.width * 0.22;
  const start = stack ? stack.y + stack.height : job.y + job.height;
  const end = job.y + job.height;
  const low = Math.max(start, end) + loopDepth;
  const r = Math.min(radius, Math.abs(from - to) / 2);
  const dir = Math.sign(to - from) || -1;
  const path = [
    `M ${from} ${start}`,
    `L ${from} ${low - r}`,
    `Q ${from} ${low}, ${from + dir * r} ${low}`,
    `L ${to - dir * r} ${low}`,
    `Q ${to} ${low}, ${to} ${low - r}`,
    `L ${to} ${end + 2}`,
  ].join(' ');
  const s = faded(style, data.dim);
  return (
    <>
      <BaseEdge path={path} {...(s && { style: s })} {...(markerEnd && { markerEnd })} />
      {data.label && (
        <Label at={{ x: (from + to) / 2, y: low + 14 }} text={data.label} color={data.color} dim={data.dim} />
      )}
    </>
  );
};
