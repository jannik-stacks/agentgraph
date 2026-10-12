import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { cx } from '../ui.tsx';
import { type Box, loopDepth, type Point } from './layout.ts';

export type RouteData = { points: Point[]; label?: string; labelAt?: Point; color: string; dim?: boolean };
export type LoopData = { box: Box; label?: string; color: string; dim?: boolean };
export type RoutedFlowEdge = Edge<RouteData, 'routed'>;
export type LoopFlowEdge = Edge<LoopData, 'loop'>;

/** A smooth curve through every point, leaving and entering the nodes horizontally. */
const curve = (points: Point[]) => {
  const [start, ...rest] = points;
  if (!start) return '';
  let d = `M ${start.x} ${start.y}`;
  for (let i = 0; i < rest.length; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const half = (p2.x - p1.x) / 2;
    const c1 = i === 0 ? { x: p1.x + half, y: p1.y } : { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 =
      i === rest.length - 1 ? { x: p2.x - half, y: p2.y } : { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
  }
  return d;
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

/** An edge drawn along the route the layout found, with its label where the layout reserved space for it. */
export const RoutedEdge = ({ data, style, markerEnd }: EdgeProps<RoutedFlowEdge>) => {
  if (!data) return null;
  const s = faded(style, data.dim);
  return (
    <>
      <BaseEdge path={curve(data.points)} {...(s && { style: s })} {...(markerEnd && { markerEnd })} />
      {data.label && data.labelAt && <Label at={data.labelAt} text={data.label} color={data.color} dim={data.dim} />}
    </>
  );
};

const radius = 10;

/** A self-loop under its node: leaves the bottom edge on the right, returns on the left, label on the loop. */
export const LoopEdge = ({ data, style, markerEnd }: EdgeProps<LoopFlowEdge>) => {
  if (!data) return null;
  const { x, y, width, height } = data.box;
  const bottom = y + height;
  const [from, to] = [x + width * 0.78, x + width * 0.22];
  const low = bottom + loopDepth;
  const path = [
    `M ${from} ${bottom}`,
    `L ${from} ${low - radius}`,
    `Q ${from} ${low}, ${from - radius} ${low}`,
    `L ${to + radius} ${low}`,
    `Q ${to} ${low}, ${to} ${low - radius}`,
    `L ${to} ${bottom + 2}`,
  ].join(' ');
  const s = faded(style, data.dim);
  return (
    <>
      <BaseEdge path={path} {...(s && { style: s })} {...(markerEnd && { markerEnd })} />
      {data.label && <Label at={{ x: x + width / 2, y: low + 14 }} text={data.label} color={data.color} dim={data.dim} />}
    </>
  );
};
