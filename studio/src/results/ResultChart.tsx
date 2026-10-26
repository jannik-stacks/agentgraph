import * as Plot from '@observablehq/plot';
import { useEffect, useRef, useState } from 'react';
import { type CheckField, formatResultValue, readFieldValue, type RunResults } from './result.ts';

type ResultChartEncoding = { x: string; y: CheckField; color?: string | undefined; facet?: string | undefined };

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

  useEffect(() => {
    const el = box.current;
    if (!el || !width) return;
    const measure = fields.find(f => `${f.check} ${f.field}` === x);
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
          kept: run.axes.verdict === 'kept',
        },
      ];
    });
    const along = x === 'time' || x === 'order' || x === 'iteration';
    const kind = measure ? 'scatter' : along ? 'along' : 'strip';
    const bound = y.limit?.maximum ?? y.limit?.minimum;
    const channels = { x: 'x', y: 'y', ...(facet && { fy: 'facet' }) } as const;
    const marks: Plot.Markish[] = [
      Plot.ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.15 }),
      ...(bound === undefined ? [] : [Plot.ruleY([bound], { stroke: '#d97706', strokeDasharray: '4,3' })]),
      kind === 'along' && data.some(d => d.kept)
        ? Plot.line(
            data.filter(d => d.kept),
            { ...channels, stroke: 'color', curve: 'step-after' }
          )
        : kind === 'along'
          ? Plot.lineY(
              data,
              Plot.binX<Plot.LineYOptions>(
                { y: 'median' },
                { ...channels, stroke: 'color', interval: x === 'time' ? 'day' : x === 'order' ? 10 : 1 }
              )
            )
          : kind === 'strip'
            ? Plot.tickY(data, Plot.groupX({ y: 'median' }, { ...channels, stroke: 'color', strokeWidth: 2 }))
            : null,
      Plot.dot(data, {
        ...channels,
        stroke: 'color',
        fill: 'color',
        fillOpacity: d => (d.run.axes.verdict && d.run.axes.verdict !== 'kept' ? 0 : 1),
        r: d => (d.run.axes.verdict === 'screened-out' ? 2 : 3.5),
        href: 'href',
      }),
      Plot.tip(
        data,
        Plot.pointer({
          ...channels,
          title: d =>
            [
              d.run.key,
              `${y.check} ${y.field}: ${formatResultValue(y, d.y)}`,
              ...Object.entries(d.run.axes).map(([k, v]) => `${k}: ${v}`),
            ].join('\n'),
        })
      ),
    ];
    const chart = Plot.plot({
      width,
      ...(!facet && { height: 360 }),
      marginLeft: 56,
      style: { background: 'transparent', color: 'currentColor', fontSize: '11px' },
      x: {
        label: x,
        ...(kind === 'strip' && { type: 'band' as const, padding: 0.3 }),
        ...(x === 'time' && { type: 'utc' as const }),
        ...(x === 'iteration' && { interval: 1, tickFormat: (v: number) => String(v) }),
      },
      y: { label: `${y.check} ${y.field}`, grid: true, tickFormat: (v: number) => formatResultValue(y, v) },
      color: { range: palette, legend: !!color },
      marks,
    });
    el.replaceChildren(chart);
    return () => chart.remove();
  }, [runs, fields, x, y, color, facet, width]);

  return <div ref={box} className="min-w-0 text-zinc-700 dark:text-zinc-300" />;
};

export default ResultChart;
