import { scaleLinear, scaleLog } from 'd3-scale';
import { type ReactNode, useId, useState } from 'react';
import { cx, TipBubble, useTip } from '../ui.tsx';

type Dot = {
  key: string;
  x: number;
  y: number;
  xCi?: [number, number];
  yCi?: [number, number];
  label?: string;
  tone: string;
  square?: boolean;
  open?: boolean;
  dim?: boolean;
  tip: ReactNode;
};

const [width, left, right, top, bottom] = [640, 44, 96, 22, 30];

/**
 * A scatter of dots with optional interval crosses, a staircase through `line` and a dashed line at `hLine`. `xTip`,
 * `yTip` and `hTip` explain the axis labels and the dashed line on hover and focus.
 */
export const Scatter = ({
  dots,
  line = [],
  hLine,
  log = false,
  height = 320,
  xLabel,
  yLabel,
  xTip,
  yTip,
  hTip,
  note,
  picked,
  onPick,
}: {
  dots: Dot[];
  line?: { x: number; y: number }[];
  hLine?: number;
  log?: boolean;
  height?: number;
  xLabel: string;
  yLabel: string;
  xTip?: ReactNode;
  yTip?: ReactNode;
  hTip?: ReactNode;
  note?: string | undefined;
  picked?: string | undefined;
  onPick?: (key: string) => void;
}) => {
  const { ref, show, hide } = useTip();
  const [tip, setTip] = useState<ReactNode>(null);
  const id = useId();
  const hint = (content: ReactNode, delay = 100) => {
    const open = (target: Element, wait: number) => {
      setTip(content);
      show(() => target.getBoundingClientRect(), wait);
    };
    return content
      ? {
          'aria-describedby': id,
          onMouseEnter: (e: { currentTarget: Element }) => open(e.currentTarget, delay),
          onFocus: (e: { currentTarget: Element }) => open(e.currentTarget, 0),
          onMouseLeave: hide,
          onBlur: hide,
        }
      : {};
  };
  const xs = dots.flatMap(d => [d.x, ...(d.xCi ?? [])]).filter(x => !log || x > 0);
  const ys = [0, ...(hLine === undefined ? [] : [hLine]), ...dots.flatMap(d => [d.y, ...(d.yCi ?? [])])];
  const [x0, x1] = [Math.min(...xs, log ? Infinity : 0), Math.max(...xs, 0)];
  const x = log
    ? scaleLog()
        .domain(xs.length ? [x0 / 1.4, x1 * 1.4] : [0.01, 1])
        .range([left, width - right])
    : scaleLinear()
        .domain([0, (x1 || 1) * 1.08])
        .nice()
        .range([left, width - right]);
  const y = scaleLinear()
    .domain([Math.min(...ys) - 0.05, Math.max(...ys) + 0.05])
    .nice()
    .range([height - bottom, top]);
  const at = (v: number) => x(log ? Math.max(v, x.domain()[0]!) : v);
  const tick = log ? x.tickFormat(6, '$~g') : (t: number) => `${t}`;
  const xTicks = x.ticks(6).filter(t => tick(t) !== '');
  const stairs = line
    .toSorted((a, b) => a.x - b.x)
    .map((p, i) => `${i ? `H${at(p.x)}V` : `M${at(p.x)},`}${y(p.y)}`)
    .join('');
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
            {tick(t)}
          </text>
        ))}
        <text
          x={width - right}
          y={height - 2}
          textAnchor="end"
          tabIndex={xTip ? 0 : undefined}
          className="fill-zinc-500 outline-none"
          {...hint(xTip)}
        >
          {xLabel}
        </text>
        <text x={4} y={10} tabIndex={yTip ? 0 : undefined} className="fill-zinc-500 outline-none" {...hint(yTip)}>
          {yLabel}
        </text>
        {hLine !== undefined && (
          <g className="text-zinc-400 dark:text-zinc-500">
            <line
              x1={left}
              x2={width - right}
              y1={y(hLine)}
              y2={y(hLine)}
              strokeDasharray="4 3"
              className="stroke-current"
            />
            <text
              x={width - right + 4}
              y={y(hLine)}
              dy="0.32em"
              tabIndex={hTip ? 0 : undefined}
              className="fill-current outline-none"
              {...hint(hTip)}
            >
              human
            </text>
          </g>
        )}
        {stairs && (
          <path
            d={`${stairs}H${width - right}`}
            fill="none"
            className="stroke-zinc-400 dark:stroke-zinc-500"
            strokeWidth={1.5}
          />
        )}
        {note && (
          <text x={width - right} y={top + 4} dy="0.7em" textAnchor="end" className="fill-zinc-400">
            {note}
          </text>
        )}
        {dots.map(d => (
          <g
            key={d.key}
            tabIndex={onPick ? 0 : undefined}
            role={onPick ? 'button' : undefined}
            aria-label={d.label ?? d.key}
            onClick={() => onPick?.(d.key)}
            onKeyDown={e => e.key === 'Enter' && onPick?.(d.key)}
            {...hint(d.tip, 80)}
            className={cx(
              d.tone,
              'outline-none transition-opacity duration-150',
              onPick && 'cursor-pointer',
              d.dim && 'opacity-35 hover:opacity-100'
            )}
          >
            {d.xCi && (
              <line x1={at(d.xCi[0])} x2={at(d.xCi[1])} y1={y(d.y)} y2={y(d.y)} className="stroke-current opacity-30" />
            )}
            {d.yCi && (
              <line x1={at(d.x)} x2={at(d.x)} y1={y(d.yCi[0])} y2={y(d.yCi[1])} className="stroke-current opacity-30" />
            )}
            {d.square ? (
              <rect
                x={at(d.x) - 4.5}
                y={y(d.y) - 4.5}
                width={9}
                height={9}
                strokeWidth={picked === d.key ? 3 : 1.5}
                className={cx('stroke-current', d.open ? 'fill-white dark:fill-zinc-950' : 'fill-current')}
              />
            ) : (
              <circle
                cx={at(d.x)}
                cy={y(d.y)}
                r={5}
                strokeWidth={picked === d.key ? 3 : 1.5}
                className={cx('stroke-current', d.open ? 'fill-white dark:fill-zinc-950' : 'fill-current')}
              />
            )}
            {d.label && (
              <text x={at(d.x) + 8} y={y(d.y)} dy="0.32em" className="fill-current">
                {d.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <TipBubble ref={ref} id={id} tip={tip} />
    </div>
  );
};
