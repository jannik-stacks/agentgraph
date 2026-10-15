import { useMemo } from 'react';
import { cx } from '../../ui.tsx';
import { chartOf, layoutChart, lineHeight, sizes, type State, stateOf } from './chart-model.ts';
import type { ViewProps } from './index.ts';

const gray = { stroke: 'stroke-zinc-400 dark:stroke-zinc-600', text: 'fill-zinc-500 dark:fill-zinc-400' };
const sky = { stroke: 'stroke-sky-600 dark:stroke-sky-400', text: 'fill-sky-600 dark:fill-sky-400' };
const paper = 'fill-white dark:fill-zinc-950';
const ink = 'fill-zinc-900 dark:fill-zinc-100';

const octagon = (r: number) =>
  Array.from({ length: 8 }, (_, i) => {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

const Arrows = () => (
  <defs>
    {Object.entries({ gray, sky }).map(([name, c]) => (
      <marker
        key={name}
        id={`chart-${name}`}
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path d="M0,0 L8,4 L0,8 z" className={c.text} />
      </marker>
    ))}
  </defs>
);

/** One state drawn around its centre: a step box with a tries badge, or a small asking, done or stopped mark. */
const Shape = ({ state, on }: { state: State; on: boolean }) => {
  const c = on ? sky : gray;
  if (state.kind === 'asking')
    return (
      <g>
        <circle r={sizes.asking.width / 2} className={cx(paper, c.stroke)} strokeWidth={on ? 2 : 1} />
        <text textAnchor="middle" dy="4" fontSize="11" className={c.text}>
          ?
        </text>
      </g>
    );
  if (state.kind === 'done')
    return (
      <g>
        <circle r={20} className={cx(paper, c.stroke)} strokeWidth={on ? 2 : 1} />
        <circle r={16} className={cx('fill-none', c.stroke)} />
        <text textAnchor="middle" dy="3.5" fontSize="10" className={c.text}>
          done
        </text>
      </g>
    );
  if (state.kind !== 'step')
    return (
      <g>
        <polygon points={octagon(12.5)} className={cx(paper, c.stroke)} strokeWidth={on ? 2 : 1} />
        <rect x={-3.5} y={-3.5} width={7} height={7} className={on ? sky.text : 'fill-zinc-400 dark:fill-zinc-600'} />
      </g>
    );
  const { node } = state;
  const { width, height } = sizes.step;
  const tries =
    node.run?.current && node.run.tries > 0
      ? `${Math.min(node.run.tries + 1, node.tries)}/${node.tries}`
      : node.tries > 1
        ? String(node.tries)
        : '';
  const badge = Math.max(16, tries.length * 6 + 8);
  const sub = [
    node.checks.length && `${node.checks.length} ${node.checks.length === 1 ? 'check' : 'checks'}`,
    node.each && `each ${node.each.length > 16 ? 'script item' : node.each}`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <g transform={`translate(${-width / 2},${-height / 2})`}>
      <rect
        width={width}
        height={height}
        rx={6}
        className={cx(paper, c.stroke)}
        strokeWidth={on ? 2 : 1}
        strokeDasharray={node.doer === 'human' ? '4 3' : undefined}
      />
      <text x={10} y={18} fontSize="12.5" fontWeight={500} className={ink}>
        {node.step}
      </text>
      <text x={10} y={32} fontSize="11" className={gray.text}>
        {node.doer === 'human' ? 'waits for a human' : node.doer}
      </text>
      {sub && (
        <text x={10} y={45} fontSize="10" className={gray.text}>
          {sub}
        </text>
      )}
      {tries && (
        <g transform={`translate(${width - badge / 2 + 4},-4)`}>
          <rect
            x={-badge / 2}
            y={-8}
            width={badge}
            height={16}
            rx={8}
            className={on && node.run?.tries ? 'fill-sky-600 dark:fill-sky-400' : 'fill-zinc-500 dark:fill-zinc-600'}
          />
          <text textAnchor="middle" dy="3.5" fontSize="10" fontWeight={600} className="fill-white dark:fill-zinc-950">
            {tries}
          </text>
        </g>
      )}
    </g>
  );
};

const legend = [
  ['box', 'a step; dashed when it waits for a human; the badge is its tries'],
  ['?', 'asking a human; the step keeps its session'],
  ['octagon', 'stopped at that step'],
  ['double circle', 'done'],
  ['pass', 'the next step, or done after the last'],
  ['refused, n tries', 'a failing check or a rejected proposal; the same step again'],
  ['exhausted', 'refused with no tries left'],
  ['back', 'a way back, capped by rounds; a human way back has no cap'],
  ['back, rounds out', 'a way back with no rounds left'],
  ['ask, answer', 'the bot asks; the answer resumes the step'],
  ['stop', 'a stop check fails, a human says stop, or the thread closes'],
];

/** The full state chart: every state the engine expands from the steps and every outcome as a labelled move. */
export default function Chart({ graph, run, trail }: ViewProps) {
  const chart = useMemo(() => layoutChart(chartOf(graph)), [graph]);
  const current = run && stateOf(run);
  const last = trail?.at(-1);
  const taken = last && `${stateOf(last.at)}>${current}`;
  return (
    <div className="flex flex-wrap items-start gap-6 p-4">
      <svg
        width={chart.width}
        height={chart.height}
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="max-w-full"
        style={{ height: 'auto' }}
      >
        <Arrows />
        {chart.moves.map(m => {
          const on = `${m.from}>${m.to}` === taken;
          return (
            <path
              key={`${m.from}>${m.to}`}
              d={m.path}
              className={cx('fill-none', on ? sky.stroke : gray.stroke)}
              strokeWidth={on ? 1.75 : 1}
              markerEnd={`url(#chart-${on ? 'sky' : 'gray'})`}
            />
          );
        })}
        {chart.moves.map(m => {
          const on = `${m.from}>${m.to}` === taken;
          const top = m.label.y - ((m.lines.length - 1) * lineHeight) / 2;
          return (
            <g key={`${m.from}>${m.to}`}>
              <rect
                x={m.label.x - m.label.width / 2}
                y={m.label.y - m.label.height / 2}
                width={m.label.width}
                height={m.label.height}
                className={paper}
              />
              <text fontSize="10" textAnchor={m.self ? 'start' : 'middle'} className={gray.text}>
                {m.lines.map((l, i) => {
                  const hit = on && l.outcome === last?.outcome.kind;
                  return (
                    <tspan
                      key={i}
                      x={m.label.x}
                      y={top + i * lineHeight + 3}
                      className={hit ? sky.text : undefined}
                      fontWeight={hit ? 600 : undefined}
                    >
                      {l.text}
                    </tspan>
                  );
                })}
              </text>
            </g>
          );
        })}
        {chart.states.map(s => (
          <g key={s.id} transform={`translate(${s.x},${s.y})`}>
            <Shape state={s} on={s.id === current} />
          </g>
        ))}
      </svg>
      <div className="w-72 space-y-3 text-xs text-zinc-500">
        <p>At most {graph.worst} bot sessions before the run asks a human.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {legend.map(([term, meaning]) => (
            <div key={term} className="contents">
              <dt className="whitespace-nowrap text-zinc-700 dark:text-zinc-300">{term}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
        <p>
          With a run, the state it sits in and the move that brought it there are{' '}
          <span className="text-sky-600 dark:text-sky-400">in this color</span>.
        </p>
      </div>
    </div>
  );
}
