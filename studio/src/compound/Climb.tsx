import { scaleLinear } from 'd3-scale';
import { type ReactNode, useState } from 'react';
import { cx, TipBubble, useTip } from '../ui.tsx';

export type Dot = {
  key: string;
  x: number;
  y: number;
  tone: string;
  shape: 'kept' | 'discarded' | 'small' | 'diamond' | 'mean';
  ci?: [number, number];
  tip: ReactNode;
};
export type Line = { key: string; tone: string; points: { x: number; y: number }[]; thin?: boolean };
export type Band = { key: string; tone: string; points: { x: number; lo: number; hi: number }[] };

const [width, left, right, top, bottom] = [640, 40, 56, 24, 30];

const stairs = (points: { x: number; y: number }[], x: (v: number) => number, y: (v: number) => number) =>
  points.map((p, i) => `${i ? `H${x(p.x)}V` : `M${x(p.x)},`}${y(p.y)}`).join('');

/** Score over iterations or spend: dots per candidate, running-best staircases, bands, and level lines. */
export const Climb = ({
  dots,
  lines = [],
  bands = [],
  levels = [],
  xLabel,
  yLabel,
  xTick = (t: number) => `${t}`,
  integerX = false,
  height = 300,
  picked,
  onPick,
}: {
  dots: Dot[];
  lines?: Line[];
  bands?: Band[];
  levels?: { y: number; label: string }[];
  xLabel: string;
  yLabel: string;
  xTick?: ((t: number) => string) | undefined;
  integerX?: boolean;
  height?: number;
  picked?: string | undefined;
  onPick?: ((key: string) => void) | undefined;
}) => {
  const { ref, show, hide } = useTip();
  const [tip, setTip] = useState<ReactNode>(null);
  const xs = [...dots.map(d => d.x), ...lines.flatMap(l => l.points.map(p => p.x))];
  const ys = [
    ...levels.map(l => l.y),
    ...dots.flatMap(d => [d.y, ...(d.ci ?? [])]),
    ...lines.flatMap(l => l.points.map(p => p.y)),
    ...bands.flatMap(b => b.points.flatMap(p => [p.lo, p.hi])),
  ];
  const x = scaleLinear()
    .domain(integerX ? [Math.min(0, ...xs) - 0.5, Math.max(1, ...xs) + 0.5] : [0, Math.max(...xs, 0) * 1.04 || 1])
    .range([left, width - right]);
  if (!integerX) x.nice();
  const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
  const pad = (hi - lo) * 0.06 || 0.04;
  const y = scaleLinear()
    .domain([lo < 0 ? lo - pad : Math.max(0, lo - pad), hi + pad])
    .nice()
    .range([height - bottom, top]);
  const xTicks = integerX ? x.ticks(Math.min(12, xs.length)).filter(Number.isInteger) : x.ticks(6);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full text-[10px]" role="img" aria-label={yLabel}>
        {y.ticks(6).map(t => (
          <g key={t} className="text-zinc-400 dark:text-zinc-500">
            <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className="stroke-zinc-100 dark:stroke-zinc-900" />
            <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-current tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {xTicks.map(t => (
          <text
            key={t}
            x={x(t)}
            y={height - bottom + 14}
            textAnchor="middle"
            className="fill-zinc-400 tabular-nums dark:fill-zinc-500"
          >
            {xTick(t)}
          </text>
        ))}
        <text x={width - right} y={height - 2} textAnchor="end" className="fill-zinc-500">
          {xLabel}
        </text>
        <text x={4} y={10} className="fill-zinc-500">
          {yLabel}
        </text>
        {levels.map(l => (
          <g key={l.label} className="text-zinc-400 dark:text-zinc-500">
            <line
              x1={left}
              x2={width - right}
              y1={y(l.y)}
              y2={y(l.y)}
              strokeDasharray="5 3"
              className="stroke-current"
            />
            <text x={width - right + 4} y={y(l.y)} dy="0.32em" className="fill-current">
              {l.label}
            </text>
          </g>
        ))}
        {bands.map(b => (
          <path
            key={b.key}
            d={`${stairs(
              b.points.map(p => ({ x: p.x, y: p.hi })),
              x,
              y
            )}${b.points
              .toReversed()
              .map(
                (p, i, all) =>
                  `${i ? `V${y(p.lo)}H${x(p.x)}` : `L${x(p.x)},${y(p.lo)}`}${i === all.length - 1 ? 'Z' : ''}`
              )
              .join('')}`}
            className={cx(b.tone, 'fill-current opacity-10')}
          />
        ))}
        {lines.map(l => (
          <path
            key={l.key}
            d={stairs(l.points, x, y)}
            fill="none"
            strokeWidth={l.thin ? 1 : 1.75}
            strokeDasharray={l.thin ? '1 2' : undefined}
            className={cx(l.tone, 'stroke-current', l.thin && 'opacity-60')}
          />
        ))}
        {dots.map(d => {
          const [cx_, cy] = [x(d.x), y(d.y)];
          const ring = picked === d.key ? 3 : 1.5;
          return (
            <g
              key={d.key}
              tabIndex={onPick ? 0 : undefined}
              role={onPick ? 'button' : undefined}
              aria-label={d.key}
              onClick={() => onPick?.(d.key)}
              onKeyDown={e => e.key === 'Enter' && onPick?.(d.key)}
              onMouseEnter={e => {
                const target = e.currentTarget;
                setTip(d.tip);
                show(() => target.getBoundingClientRect(), 60);
              }}
              onMouseLeave={hide}
              className={cx(
                d.shape === 'small' ? 'text-zinc-400 dark:text-zinc-600' : d.tone,
                'outline-none transition-opacity duration-150',
                onPick && 'cursor-pointer',
                d.shape === 'discarded' && 'opacity-45 hover:opacity-100'
              )}
            >
              {d.ci && <line x1={cx_} x2={cx_} y1={y(d.ci[0])} y2={y(d.ci[1])} className="stroke-current opacity-40" />}
              {d.shape === 'diamond' ? (
                <path
                  d={`M${cx_},${cy - 6}L${cx_ + 6},${cy}L${cx_},${cy + 6}L${cx_ - 6},${cy}Z`}
                  strokeWidth={ring}
                  className="fill-white stroke-current dark:fill-zinc-950"
                />
              ) : (
                <circle
                  cx={cx_}
                  cy={cy}
                  r={d.shape === 'small' ? 2.5 : d.shape === 'mean' ? 3 : 4.5}
                  strokeWidth={d.shape === 'small' ? 1 : ring}
                  className={cx(
                    'stroke-current',
                    d.shape === 'discarded' ? 'fill-white dark:fill-zinc-950' : 'fill-current'
                  )}
                />
              )}
            </g>
          );
        })}
      </svg>
      <TipBubble ref={ref} tip={tip} />
    </div>
  );
};

/** Stacked bars per x; the first part solid, later parts lighter. */
export const Bars = ({
  bars,
  xLabel,
  yLabel,
  height = 110,
}: {
  bars: { key: string; x: number; slot: number; slots: number; tone: string; parts: number[]; tip: ReactNode }[];
  xLabel: string;
  yLabel: string;
  height?: number;
}) => {
  const { ref, show, hide } = useTip();
  const [tip, setTip] = useState<ReactNode>(null);
  const xs = bars.map(b => b.x);
  const x = scaleLinear()
    .domain([Math.min(0, ...xs) - 0.5, Math.max(1, ...xs) + 0.5])
    .range([left, width - right]);
  const y = scaleLinear()
    .domain([0, Math.max(...bars.map(b => b.parts.reduce((a, v) => a + v, 0)), 0) || 1])
    .nice()
    .range([height - bottom, top]);
  const band = x(1) - x(0);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full text-[10px]" role="img" aria-label={yLabel}>
        {y.ticks(3).map(t => (
          <g key={t} className="text-zinc-400 dark:text-zinc-500">
            <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className="stroke-zinc-100 dark:stroke-zinc-900" />
            <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-current tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {[...new Set(xs)].map(t => (
          <text
            key={t}
            x={x(t)}
            y={height - bottom + 14}
            textAnchor="middle"
            className="fill-zinc-400 tabular-nums dark:fill-zinc-500"
          >
            {t}
          </text>
        ))}
        <text x={width - right} y={height - 2} textAnchor="end" className="fill-zinc-500">
          {xLabel}
        </text>
        <text x={4} y={10} className="fill-zinc-500">
          {yLabel}
        </text>
        {bars.map(b => {
          const w = (band * 0.7) / b.slots;
          const x0 = x(b.x) - band * 0.35 + b.slot * w;
          let base = 0;
          return (
            <g
              key={b.key}
              className={cx(b.tone, 'transition-opacity duration-150 hover:opacity-70')}
              onMouseEnter={e => {
                const target = e.currentTarget;
                setTip(b.tip);
                show(() => target.getBoundingClientRect(), 60);
              }}
              onMouseLeave={hide}
            >
              {b.parts.map((v, i) => {
                const [from, to] = [base, (base += v)];
                return (
                  <rect
                    key={i}
                    x={x0 + 0.5}
                    y={y(to)}
                    width={Math.max(1, w - 1)}
                    height={Math.max(0, y(from) - y(to))}
                    className={cx('fill-current', i > 0 && 'opacity-40')}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <TipBubble ref={ref} tip={tip} />
    </div>
  );
};
