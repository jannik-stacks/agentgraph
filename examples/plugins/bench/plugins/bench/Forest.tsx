import { scaleLinear } from 'd3-scale';
import { Fragment, type ReactNode } from 'react';
import { atLink, cx, Tooltip } from '@jannik-stacks/agi/studio';
import { getMean } from '../../../../../src/stats.ts';
import type { BenchRow } from './data.ts';
import {
  formatLabel,
  formatMinutes,
  formatUsd,
  getQualitySpread,
  getRowKey,
  roughBelow,
  type summarise,
} from '../../../../../bench/score.ts';

type Point = ReturnType<typeof summarise>[number];

export const BenchRunLink = ({
  row,
  children,
  className,
}: {
  row: BenchRow;
  children: ReactNode;
  className?: string;
}) => (
  <a
    href={`${row.instance ? `/${row.instance}` : ''}${atLink(row.run, undefined, row.instance === undefined ? row.data : undefined)}`}
    className={className}
  >
    {children}
  </a>
);

const [width, height, pad] = [280, 20, 14];
const fmt = (v: number) => v.toFixed(2);
const formatSpan = ([lo, hi]: readonly [number, number]) => `${fmt(lo)} to ${fmt(hi)}`;

const heads: [string, string][] = [
  ['cases', 'Cases with at least one scored run.'],
  ['hidden tests', 'Share of runs whose hidden tests pass.'],
  ['cost per run', 'Mean list-price cost of a run, plus or minus one standard deviation.'],
  ['time', 'Mean wall time of a run.'],
];

export const Forest = ({
  points,
  keys,
  weighting,
  tone,
  rowCost,
  picked,
  onPick,
}: {
  points: Point[];
  keys: string[];
  weighting: string;
  tone: (p: Point) => string;
  rowCost: (row: Point['perCase'][number]['row']) => number;
  picked: string | null;
  onPick: (key: string | null) => void;
}) => {
  const spreads = new Map(points.map(p => [p.key, getQualitySpread(p.perCase)]));
  const all = points.flatMap(p => [...spreads.get(p.key)!.runs.range, ...p.yCi]);
  const x = scaleLinear()
    .domain([Math.min(0, ...all), Math.max(1.1, ...all)])
    .nice()
    .range([pad, width - pad]);
  const sets = [...Map.groupBy(points, p => p.labels.set ?? '')].toSorted(([a], [b]) => a.localeCompare(b));
  const span = keys.length + 1 + heads.length;
  const cell = 'py-1 pr-3 text-right tabular-nums';
  return (
    <table className="w-full max-w-5xl text-left text-xs whitespace-nowrap">
      <thead className="text-zinc-500">
        <tr className="border-b border-zinc-200 dark:border-zinc-800">
          {keys.map(k => (
            <th key={k} className="py-1 pr-3 align-bottom font-medium">
              {k}
            </th>
          ))}
          <th className="py-1 pr-3 font-medium">
            <Tooltip
              tip={`Each faint dot is one case's mean over its repeats, the solid mark the mean over cases, with the weights picked on the left. The shaded band spans the middle half of the cases and the tall tick marks their median. The hairline below spans every run, with a short tick at the run median. The bar is a 95 percent interval, shown from ${roughBelow} cases on. The dashed line is the human, at 1.`}
            >
              <span>quality ({weighting})</span>
            </Tooltip>
            <svg width={width} height={14} className="block overflow-visible text-[10px]">
              {x.ticks(5).map(t => (
                <text key={t} x={x(t)} y={10} textAnchor="middle" className="fill-zinc-400 dark:fill-zinc-500">
                  {x.tickFormat(5)(t)}
                </text>
              ))}
            </svg>
          </th>
          {heads.map(([h, tip]) => (
            <th key={h} className="py-1 pr-3 text-right align-bottom font-medium">
              <Tooltip tip={tip}>
                <span>{h}</span>
              </Tooltip>
            </th>
          ))}
        </tr>
      </thead>
      {sets.map(([set, ps]) => (
        <tbody key={set}>
          <tr>
            <th colSpan={span} className="pt-3 pb-1 font-medium text-zinc-500">
              {set || 'no set'}
            </th>
          </tr>
          {ps
            .toSorted((a, b) => b.y - a.y)
            .map(p => {
              const tested = p.perCase.filter(s => s.row.hidden !== undefined);
              const costs = p.perCase.map(s => rowCost(s.row));
              const mean = getMean(costs);
              const sd = Math.sqrt(getMean(costs.map(c => (c - mean) ** 2)));
              const open = p.key === picked;
              const { caseMeans, cases, runs } = spreads.get(p.key)!;
              return (
                <Fragment key={p.key}>
                  <tr
                    onClick={() => onPick(open ? null : p.key)}
                    className={cx(
                      'cursor-pointer border-b border-zinc-100 transition-colors duration-150 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900',
                      open && 'bg-zinc-100 dark:bg-zinc-800'
                    )}
                  >
                    {keys.map(k => (
                      <td key={k} className="py-1 pr-3 font-mono">
                        {formatLabel(p.labels[k])}
                      </td>
                    ))}
                    <td className="py-1 pr-3">
                      <Tooltip
                        tip={[
                          `mean over cases ${fmt(p.y)}`,
                          `${p.n} cases: median ${fmt(cases.median)}, middle half ${formatSpan(cases.middle)}, range ${formatSpan(cases.range)}`,
                          `${p.repeats} runs: median ${fmt(runs.median)}, range ${formatSpan(runs.range)}`,
                        ].join('\n')}
                      >
                        <svg width={width} height={height} className={cx('block', tone(p))}>
                          <line
                            x1={x(1)}
                            x2={x(1)}
                            y1={0}
                            y2={height}
                            strokeDasharray="3 2"
                            className="stroke-zinc-400 dark:stroke-zinc-500"
                          />
                          <rect
                            x={x(cases.middle[0])}
                            y={height / 2 - 3}
                            width={x(cases.middle[1]) - x(cases.middle[0])}
                            height={6}
                            className="fill-current opacity-20"
                          />
                          <line
                            x1={x(cases.median)}
                            x2={x(cases.median)}
                            y1={2}
                            y2={height - 4}
                            strokeWidth={1.5}
                            className="stroke-current"
                          />
                          <line
                            x1={x(runs.range[0])}
                            x2={x(runs.range[1])}
                            y1={height - 1}
                            y2={height - 1}
                            className="stroke-current opacity-40"
                          />
                          <line
                            x1={x(runs.median)}
                            x2={x(runs.median)}
                            y1={height - 4}
                            y2={height}
                            className="stroke-current"
                          />
                          {caseMeans.map((m, i) => (
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
                      </Tooltip>
                    </td>
                    <td className={cell}>{p.n}</td>
                    <td className={cell}>
                      {tested.length
                        ? `${Math.round((100 * tested.filter(s => s.row.hidden).length) / tested.length)}%`
                        : ''}
                    </td>
                    <td className={cell}>
                      {formatUsd(mean)} ± {formatUsd(sd)}
                    </td>
                    <td className={cell}>{formatMinutes(p.minutes)}</td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={span} className="pb-2 pl-4">
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
        {['case', 'repeat', 'quality', 'hidden tests', 'judges', 'cost', 'time', 'trace'].map(h => (
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
            formatUsd(row.usd),
            formatMinutes(row.minutes),
            <BenchRunLink
              key={row.run}
              row={row}
              className="underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              run
            </BenchRunLink>,
          ];
          return (
            <tr key={getRowKey(row)} className="text-zinc-600 dark:text-zinc-400">
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
