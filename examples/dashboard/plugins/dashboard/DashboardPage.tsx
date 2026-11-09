import { scaleBand, scaleLinear } from 'd3-scale';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { usePluginData, Button, Loading, Muted } from '@jannik-stacks/agi/studio';
import { DashboardData } from './data.ts';

type DashboardWidget = (typeof DashboardData.Type)['widgets'][number];

const tones: Record<string, string> = {
  running: 'text-sky-600 dark:text-sky-400',
  waiting: 'text-amber-600 dark:text-amber-400',
  done: 'text-emerald-600 dark:text-emerald-400',
  stopped: 'text-zinc-400 dark:text-zinc-500',
  pass: 'text-emerald-600 dark:text-emerald-400',
  fail: 'text-rose-600 dark:text-rose-400',
  input: 'text-sky-600 dark:text-sky-400',
  output: 'text-violet-600 dark:text-violet-400',
  USD: 'text-sky-600 dark:text-sky-400',
};
const readTone = (series: string) => tones[series] ?? 'text-zinc-500 dark:text-zinc-400';

const formatValue = (source: DashboardWidget['source'], value: number, compact = Math.abs(value) >= 10_000) =>
  value.toLocaleString(undefined, {
    ...(source === 'cost' && { style: 'currency', currency: 'USD' }),
    ...(compact
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : { maximumFractionDigits: source === 'cost' ? 2 : 0 }),
  });

const readUnique = (rows: DashboardWidget['rows'], key: 'day' | 'series') => [...new Set(rows.map(row => row[key]))];

const sumRows = (rows: DashboardWidget['rows']) => rows.reduce((sum, row) => sum + row.value, 0);

const useEasedNumber = (target: number) => {
  const [shown, setShown] = useState(0);
  const current = useRef(0);
  useEffect(() => {
    const [origin, start] = [current.current, performance.now()];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = requestAnimationFrame(function step(now) {
      const progress = reduced ? 1 : Math.min(1, (now - start) / 700);
      current.current = origin + (target - origin) * (1 - (1 - progress) ** 3);
      setShown(current.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
};

const EasedValue = ({
  source,
  value,
  className,
}: {
  source: DashboardWidget['source'];
  value: number;
  className: string;
}) => (
  <strong className={`font-semibold tabular-nums ${className}`} title={value.toLocaleString()}>
    {formatValue(source, useEasedNumber(value))}
  </strong>
);

const SeriesTotal = ({
  source,
  series,
  value,
}: {
  source: DashboardWidget['source'];
  series: string;
  value: number;
}) => (
  <li className="flex items-baseline gap-1.5">
    <span className={`size-2 self-center rounded-full bg-current ${readTone(series)}`} />
    <EasedValue source={source} value={value} className="text-lg" />
    <span className="text-zinc-500">{series}</span>
  </li>
);

const [chartWidth, left, top, bottom] = [600, 48, 8, 20];
const motion = 'duration-700 ease-out';

const DayChart = ({
  rows,
  source,
  kind,
  height,
}: {
  rows: DashboardWidget['rows'];
  source: DashboardWidget['source'];
  kind: 'bar' | 'line';
  height: number;
}) => {
  const days = readUnique(rows, 'day');
  const series = readUnique(rows, 'series');
  const x = scaleBand().domain(days).range([left, chartWidth]).padding(0.2);
  const y = scaleLinear()
    .domain([0, Math.max(...rows.map(row => row.value)) || 1])
    .nice(4)
    .range([height - bottom, top]);
  const group = scaleBand().domain(series).range([0, x.bandwidth()]).padding(0.15);
  const center = (day: string) => x(day)! + x.bandwidth() / 2;
  const every = Math.ceil(days.length / 7);
  return (
    <svg viewBox={`0 0 ${chartWidth} ${height}`} className="w-full overflow-visible text-[10px]" aria-hidden>
      {y.ticks(4).map(tick => (
        <g key={tick} className="text-zinc-400 dark:text-zinc-500">
          <line
            x1={left}
            x2={chartWidth}
            y1={y(tick)}
            y2={y(tick)}
            className="stroke-zinc-100 dark:stroke-zinc-800/70"
          />
          <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-current tabular-nums">
            {formatValue(source, tick, true)}
          </text>
        </g>
      ))}
      {days.map((day, i) =>
        i % every === (days.length - 1) % every ? (
          <text
            key={day}
            x={center(day)}
            y={height - 4}
            textAnchor="middle"
            className="fill-zinc-400 dark:fill-zinc-500"
          >
            {new Date(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
          </text>
        ) : null
      )}
      {series.map(name => {
        const own = rows.filter(row => row.series === name);
        const points = own.map(row => [center(row.day), y(row.value)]);
        const line = `M${points.join('L')}`;
        return (
          <g key={name} className={readTone(name)}>
            {kind === 'bar' ? (
              own.map(row => (
                <rect
                  key={row.day}
                  x={x(row.day)! + group(name)!}
                  y={top}
                  width={group.bandwidth()}
                  height={height - bottom - top}
                  style={{ '--bar': row.value / y.domain()[1]! } as CSSProperties}
                  className={`origin-bottom fill-current transition-[scale] [transform-box:fill-box] [scale:1_var(--bar)] starting:[scale:1_0] ${motion}`}
                />
              ))
            ) : (
              <>
                <path
                  d={`${line}L${points.at(-1)![0]},${y(0)}L${points[0]![0]},${y(0)}Z`}
                  className={`fill-current opacity-10 transition-[d,opacity] starting:opacity-0 ${motion}`}
                />
                <path
                  d={line}
                  pathLength={1}
                  className={`fill-none stroke-current stroke-2 transition-[d,stroke-dashoffset] [stroke-dasharray:1] [stroke-linejoin:round] starting:[stroke-dashoffset:1] ${motion}`}
                />
              </>
            )}
          </g>
        );
      })}
      <line x1={left} x2={chartWidth} y1={y(0)} y2={y(0)} className="stroke-zinc-300 dark:stroke-zinc-700" />
      {days.map(day => (
        <rect
          key={day}
          x={x(day)! - (x.step() - x.bandwidth()) / 2}
          y={top}
          width={x.step()}
          height={height - bottom - top}
          className="fill-transparent transition-colors hover:fill-zinc-500/10"
        >
          <title>
            {[
              day,
              ...rows
                .filter(row => row.day === day)
                .map(row => `${row.series} ${formatValue(source, row.value, false)}`),
            ].join('\n')}
          </title>
        </rect>
      ))}
    </svg>
  );
};

const DayTable = ({ widget }: { widget: DashboardWidget }) => (
  <table className="w-full text-xs tabular-nums">
    <caption className="sr-only">{widget.title}, UTC days</caption>
    <thead className="text-zinc-500">
      <tr>
        <th scope="col" className="py-1 text-left font-medium">
          Day
        </th>
        {readUnique(widget.rows, 'series').map(series => (
          <th key={series} scope="col" className="py-1 text-right font-medium">
            {series}
          </th>
        ))}
      </tr>
    </thead>
    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
      {readUnique(widget.rows, 'day').map(day => (
        <tr key={day}>
          <td className="py-1">{day}</td>
          {widget.rows
            .filter(row => row.day === day)
            .map(row => (
              <td key={row.series} className="py-1 text-right">
                {formatValue(widget.source, row.value, false)}
              </td>
            ))}
        </tr>
      ))}
    </tbody>
  </table>
);

const WidgetCard = ({ widget }: { widget: DashboardWidget }) => {
  const totals = readUnique(widget.rows, 'series').map(name => {
    const own = widget.rows.filter(row => row.series === name);
    return { name, own, value: sumRows(own) };
  });
  return (
    <section className="agi-in min-w-0 space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <header>
        <h2 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{widget.title}</h2>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          {widget.source === 'runs'
            ? 'Current state by start day'
            : widget.source === 'checks'
              ? 'All check attempts by check day'
              : 'Reported usage by event day'}
        </p>
      </header>
      {widget.type === 'counter' ? (
        <>
          <EasedValue source={widget.source} value={sumRows(widget.rows)} className="block text-3xl" />
          <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            {totals.map(({ name, value }) => (
              <div
                key={name}
                title={`${name} ${value.toLocaleString()}`}
                style={{ flexGrow: value }}
                className={`basis-0 bg-current transition-[flex-grow] ${motion} ${readTone(name)}`}
              />
            ))}
          </div>
        </>
      ) : null}
      {widget.type === 'line' ? null : (
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {totals.map(({ name, value }) => (
            <SeriesTotal key={name} source={widget.source} series={name} value={value} />
          ))}
        </ul>
      )}
      {widget.type === 'counter' ? (
        <DayChart
          rows={readUnique(widget.rows, 'day').map(day => ({
            day,
            series: widget.source,
            value: sumRows(widget.rows.filter(row => row.day === day)),
          }))}
          source={widget.source}
          kind="bar"
          height={90}
        />
      ) : null}
      {widget.type === 'bar' ? <DayChart rows={widget.rows} source={widget.source} kind="bar" height={180} /> : null}
      {widget.type === 'line'
        ? totals.map(({ name, own, value }) => (
            <div key={name} className="space-y-1">
              <ul>
                <SeriesTotal source={widget.source} series={name} value={value} />
              </ul>
              <DayChart rows={own} source={widget.source} kind="line" height={110} />
            </div>
          ))
        : null}
      {widget.type === 'table' ? <DayTable widget={widget} /> : null}
      {widget.type === 'bar' || widget.type === 'line' ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Daily values
          </summary>
          <div className="mt-2 max-h-80 overflow-auto">
            <DayTable widget={widget} />
          </div>
        </details>
      ) : null}
      {widget.skipped ? (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          Skipped {widget.skipped}: {widget.why}.
        </p>
      ) : null}
    </section>
  );
};

const DashboardPage = () => {
  const { value, failure, retry } = usePluginData('dashboard', DashboardData);
  if (!value)
    return failure ? (
      <Muted>
        {failure} <Button onClick={retry}>Retry</Button>
      </Muted>
    ) : (
      <Loading />
    );
  return (
    <main className="h-full space-y-4 overflow-auto p-6">
      <header>
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <p className="text-xs text-zinc-500">
          Live snapshot, last read {new Date(value.at).toLocaleString()}. Days use UTC.
        </p>
      </header>
      {failure ? (
        <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
          Could not refresh. Showing earlier data. {failure} <Button onClick={retry}>Retry</Button>
        </p>
      ) : null}
      {!value.widgets.length ? <Muted>No widgets configured in plugins.dashboard.widgets.</Muted> : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] items-start gap-4">
        {value.widgets.map((widget, index) => (
          <WidgetCard key={index} widget={widget} />
        ))}
      </div>
    </main>
  );
};

export default DashboardPage;
