import * as Plot from '@observablehq/plot';
import { useEffect, useRef, useState } from 'react';
import { type CheckField, formatResultValue, readFieldValue, type RunResults } from './result.ts';

type ResultChartEncoding = { x: string; y: CheckField; color?: string | undefined; facet?: string | undefined };

const formatFieldLabel = (f: CheckField) => `${f.check} ${f.field}${f.unit ? ` (${f.unit})` : ''}`;

const palette = ['#52525b', '#0284c7', '#7c3aed', '#d97706', '#059669', '#e11d48', '#0891b2', '#65a30d'];

const ResultChart = ({
  runs,
  fields,
  encoding: { x, y, color, facet },
}: {
  runs: RunResults[];
  fields: CheckField[];
  encoding: ResultChartEncoding;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const seen = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const measure = fields.find(f => `${f.check} ${f.field}` === x);
  const along = x === 'time' || x === 'order' || x === 'iteration';
  const kind = measure ? 'scatter' : along ? 'along' : 'strip';
  const bound = y.limit?.maximum ?? y.limit?.minimum;
  const staircase = kind === 'along' && runs.some(r => r.axes.kept === 'kept');

  useEffect(() => {
    const el = box.current;
    if (!el || !width) return;
    const order = runs.toSorted((a, b) => a.at.localeCompare(b.at));
    const data = order.flatMap((run, i) => {
      const v = readFieldValue(run, y);
      if (typeof v !== 'number') return [];
      const at =
        x === 'time' ? new Date(run.at) : x === 'order' ? i : measure ? readFieldValue(run, measure) : run.axes[x];
      if (at === undefined || (x === 'iteration' && Number.isNaN(Number(at)))) return [];
      return [
        {
          run,
          x: x === 'iteration' ? Number(at) : at,
          y: v,
          color: color ? (run.axes[color] ?? 'none') : 'all',
          facet: facet ? (run.axes[facet] ?? 'none') : undefined,
          href: run.href,
          kept: run.axes.kept === 'kept',
        },
      ];
    });
    if (along) data.sort((a, b) => Number(a.x) - Number(b.x));
    const showX = (d: (typeof data)[number]) =>
      x === 'time' ? undefined : `${x}: ${measure ? formatResultValue(measure, d.x) : d.x}`;
    const channels = { x: 'x', y: 'y', ...(facet && { fy: 'facet' }) } as const;
    const marks: Plot.Markish[] = [
      Plot.ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.15 }),
      ...(bound === undefined ? [] : [Plot.ruleY([bound], { stroke: '#d97706', strokeDasharray: '4,3' })]),
      staircase
        ? Plot.line(
            data.filter(d => d.kept),
            { ...channels, stroke: 'color', z: d => d.run.axes.tune, curve: 'step-after' }
          )
        : kind === 'along'
          ? Plot.lineY(data, Plot.windowY({ k: 5, reduce: 'median' }, { ...channels, stroke: 'color' }))
          : kind === 'strip'
            ? Plot.tickY(data, Plot.groupX({ y: 'median' }, { ...channels, stroke: 'color', strokeWidth: 2 }))
            : null,
      Plot.dot(data, {
        ...channels,
        stroke: 'color',
        fill: 'color',
        fillOpacity: d => (d.run.axes.kept === 'not kept' ? 0 : 1),
        r: 3.5,
        href: 'href',
      }),
      Plot.tip(
        data,
        Plot.pointer({
          ...channels,
          title: d =>
            [
              d.run.key,
              `${y.check} ${y.field}: ${[...new Set([formatResultValue(y, d.y), String(d.y)])].join(', exactly ')}`,
              showX(d),
              d.run.at.slice(0, 16).replace('T', ' '),
              ...Object.entries(d.run.axes)
                .filter(([k]) => k !== x)
                .map(([k, v]) => `${k}: ${v}`),
            ]
              .filter(Boolean)
              .join('\n'),
        })
      ),
    ];
    const chart = Plot.plot({
      width,
      ...(!facet && { height: Math.max(320, Math.round(window.innerHeight * 0.65)) }),
      marginLeft: 56,
      style: { background: 'transparent', color: 'currentColor', fontSize: '11px' },
      x: {
        label: measure ? formatFieldLabel(measure) : x === 'time' ? 'date' : x === 'order' ? 'run order' : x,
        ...(kind === 'strip' && { type: 'band' as const, padding: 0.3 }),
        ...(x === 'time' && { type: 'utc' as const }),
        ...((x === 'iteration' || x === 'order') && { interval: 1, tickFormat: (v: number) => String(v) }),
      },
      y: { label: formatFieldLabel(y), grid: true, tickFormat: (v: number) => formatResultValue(y, v) },
      color: { range: palette, legend: !!color },
      marks,
    });
    el.replaceChildren(chart);
    return () => chart.remove();
  }, [runs, measure, along, kind, staircase, bound, x, y, color, facet, width]);

  return (
    <div className="min-w-0 space-y-1 text-zinc-700 dark:text-zinc-300">
      <div ref={box} />
      <p className="text-xs text-zinc-500">
        {[
          'each dot is one run',
          staircase && 'hollow dots were not kept, the line steps through the kept ones',
          kind === 'along' && !staircase && 'the line is the median of every five runs in a row',
          kind === 'strip' && 'the tick is the median',
          bound !== undefined && 'the dashed line is the limit',
        ]
          .filter(Boolean)
          .join(', ')}
      </p>
    </div>
  );
};

export default ResultChart;
