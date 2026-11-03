import { scaleLinear } from 'd3-scale';
import { Fragment, type ReactNode } from 'react';
import { getMean } from '../../../src/stats.ts';
import { cx, Link, Tooltip } from '../ui.tsx';
import { roughBelow, splitBy, type summarise } from './score.ts';

type Point = ReturnType<typeof summarise>[number];

const [width, height, pad] = [320, 20, 14];
const fmt = (v: number) => v.toFixed(2);

export const Forest = ({
  points,
  label,
  tone,
  usd,
  picked,
  onPick,
}: {
  points: Point[];
  label: (p: Point) => string;
  tone: (p: Point) => string;
  usd: (p: Point) => number;
  picked: string | null;
  onPick: (key: string | null) => void;
}) => {
  const means = (p: Point) => [...splitBy(p.perCase, s => s.row.case).values()].map(ss => getMean(ss.map(s => s.y)));
  const all = points.flatMap(p => [...means(p), ...p.yCi]);
  const x = scaleLinear()
    .domain([Math.min(0, ...all), Math.max(1.1, ...all)])
    .nice()
    .range([pad, width - pad]);
  const sets = [...splitBy(points, p => p.labels.set ?? '')].toSorted(([a], [b]) => a.localeCompare(b));
  const cell = 'py-1 pr-3 text-right tabular-nums';
  return (
    <table className="w-full max-w-5xl text-left text-xs whitespace-nowrap">
      <thead className="text-zinc-500">
        <tr className="border-b border-zinc-200 dark:border-zinc-800">
          <th className="py-1 pr-3 font-medium">point</th>
          <th className="py-1 pr-3 font-medium">
            <Tooltip
              tip={`Each faint dot is one case's mean quality, the solid one the point's mean. The bar is a 95 percent interval, shown from ${roughBelow} cases on. The dashed line is the human.`}
            >
              <svg width={width} height={14} className="block overflow-visible text-[10px]">
                {x.ticks(5).map(t => (
                  <text key={t} x={x(t)} y={10} textAnchor="middle" className="fill-zinc-400 dark:fill-zinc-500">
                    {x.tickFormat(5)(t)}
                  </text>
                ))}
              </svg>
            </Tooltip>
          </th>
          {['cases', 'hidden pass', 'usd per run', 'minutes'].map(h => (
            <th key={h} className="py-1 pr-3 text-right font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      {sets.map(([set, ps]) => (
        <tbody key={set}>
          <tr>
            <th colSpan={6} className="pt-3 pb-1 font-medium text-zinc-500">
              {set || 'no set'}
            </th>
          </tr>
          {ps
            .toSorted((a, b) => b.y - a.y)
            .map(p => {
              const tested = p.perCase.filter(s => s.row.hidden !== undefined);
              const open = p.key === picked;
              return (
                <Fragment key={p.key}>
                  <tr
                    onClick={() => onPick(open ? null : p.key)}
                    className={cx(
                      'cursor-pointer border-b border-zinc-100 transition-colors duration-150 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900',
                      open && 'bg-zinc-100 dark:bg-zinc-800'
                    )}
                  >
                    <td className="py-1 pr-3 font-mono">{label(p)}</td>
                    <td className="py-1 pr-3">
                      <svg width={width} height={height} className={cx('block', tone(p))}>
                        <line
                          x1={x(1)}
                          x2={x(1)}
                          y1={0}
                          y2={height}
                          strokeDasharray="3 2"
                          className="stroke-zinc-400 dark:stroke-zinc-500"
                        />
                        {means(p).map((m, i) => (
                          <circle key={i} cx={x(m)} cy={height / 2} r={2.5} className="fill-current opacity-30" />
                        ))}
                        {p.n >= roughBelow && (
                          <line
                            x1={x(p.yCi[0])}
                            x2={x(p.yCi[1])}
                            y1={height / 2}
                            y2={height / 2}
                            strokeWidth={2}
                            className="stroke-current opacity-60"
                          />
                        )}
                        {p.labels.arm === 'floor' ? (
                          <rect x={x(p.y) - 4.5} y={height / 2 - 4.5} width={9} height={9} className="fill-current" />
                        ) : (
                          <circle cx={x(p.y)} cy={height / 2} r={5} className="fill-current" />
                        )}
                      </svg>
                    </td>
                    <td className={cell}>{p.n}</td>
                    <td className={cell}>
                      {tested.length ? `${tested.filter(s => s.row.hidden).length}/${tested.length}` : ''}
                    </td>
                    <td className={cell}>${usd(p).toFixed(3)}</td>
                    <td className={cell}>{p.minutes.toFixed(1)}</td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={6} className="pb-2 pl-4">
                        <Runs point={p} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
        </tbody>
      ))}
    </table>
  );
};

const Runs = ({ point }: { point: Point }) => (
  <table className="text-xs whitespace-nowrap tabular-nums">
    <thead className="text-zinc-500">
      <tr>
        {['case', 'repeat', 'quality', 'hidden', 'judges', 'usd', 'minutes', 'trace'].map(h => (
          <th key={h} className="py-0.5 pr-3 text-left font-medium">
            {h}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {point.perCase
        .toSorted((a, b) => a.row.case.localeCompare(b.row.case) || a.row.repeat - b.row.repeat)
        .map(({ row, y }) => {
          const cells: ReactNode[] = [
            row.case,
            row.repeat,
            fmt(y),
            row.infra ? `infra: ${row.infra}` : row.hidden === undefined ? '' : row.hidden ? 'pass' : 'fail',
            Object.entries(row.vsHuman)
              .map(([j, v]) => `${j} ${fmt(v)}`)
              .join(', '),
            `$${row.usd.toFixed(3)}`,
            row.minutes.toFixed(1),
            row.runs?.map((id, i) => (
              <Link
                key={id}
                href={`/runs/${encodeURIComponent(id)}?data=${encodeURIComponent(row.data!)}`}
                className="mr-2 underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                {row.runs!.length > 1 ? `run ${i + 1}` : 'run'}
              </Link>
            )),
          ];
          return (
            <tr key={`${row.case}/${row.repeat}`} className="text-zinc-600 dark:text-zinc-400">
              {cells.map((c, i) => (
                <td key={i} className="py-0.5 pr-3">
                  {c}
                </td>
              ))}
            </tr>
          );
        })}
    </tbody>
  </table>
);
