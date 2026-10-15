import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { Graph } from '../../../../core/src/graph.ts';
import { cx } from '../../ui.tsx';
import type { ViewProps } from './index.ts';

type Node = Graph['nodes'][number];
type Edge = Graph['edges'][number];

const BOX = 320;
const LANE = 200;
const SHOWN = 6;
const accentText = 'text-sky-600 dark:text-sky-400';
const accentBorder = 'border-sky-600 dark:border-sky-400';

const paths = {
  script: <path d="m5 8 4 4-4 4M12 17h7" />,
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 13v1M15 13v1" />
    </>
  ),
  stop: (
    <>
      <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z" fill="currentColor" />
      <path d="M8 12h8" stroke="white" />
    </>
  ),
  hand: (
    <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
  ),
  retry: <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5" />,
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21v-1a6 6 0 0 1 12 0v1" />
    </>
  ),
  tick: <path d="m5 12 5 5 9-10" />,
};

/** A small glyph in the current text color, labelled when `title` is given. */
const Glyph = ({
  name,
  title,
  className = 'size-3',
}: {
  name: keyof typeof paths;
  title?: string;
  className?: string;
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={cx('shrink-0', className)}
    {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
  >
    {title && <title>{title}</title>}
    {paths[name]}
  </svg>
);

const cut = (text: string, max = 40) =>
  text.length > max
    ? `${text
        .slice(0, max)
        .replace(/\s+\S*$/, '')
        .replace(/[,;:]$/, '')}…`
    : text;

const eachText = (each: string) =>
  each === 'hunks' || each === 'files'
    ? `one session per ${each.slice(0, -1)}`
    : `one session per line of ${/([\w.-]+)["']?\s*$/.exec(each)?.[1] ?? each}`;

/** The arrow a pass takes to the next box: a straight line down. */
const Down = ({ taken }: { taken: boolean }) => (
  <div
    className={cx('flex h-7 flex-col items-center', taken ? accentText : 'text-zinc-300 dark:text-zinc-700')}
    style={{ width: BOX }}
  >
    <div className="w-px flex-1 bg-current" />
    <svg viewBox="0 0 10 6" className="h-1.5 w-2.5 fill-current">
      <path d="M0 0h10L5 6z" />
    </svg>
  </div>
);

const Pill = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div style={{ width: BOX }} className="flex justify-center">
    <div
      className={cx(
        'flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-[11px]',
        className ?? 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
      )}
    >
      {children}
    </div>
  </div>
);

/** The tries counter on the box corner: the allowed tries at rest, the try in progress once one was refused. */
const Tries = ({ node, asking }: { node: Node; asking: boolean }) => {
  const refused = !!node.run?.current && node.run.tries > 0;
  const text = refused
    ? `${asking ? node.tries : Math.min(node.run!.tries + 1, node.tries)}/${node.tries}`
    : `${node.tries}`;
  return (
    <span
      title={
        refused ? `try ${text.replace('/', ' of ')}` : `${node.tries} ${node.tries === 1 ? 'try' : 'tries'} per visit`
      }
      className={cx(
        'absolute -top-2.5 -right-2.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold text-white ring-2 ring-white dark:ring-zinc-950',
        refused ? 'bg-sky-600 dark:bg-sky-500' : 'bg-zinc-500 dark:bg-zinc-600'
      )}
    >
      {text}
    </span>
  );
};

const Chips = ({ checks }: { checks: Node['checks'] }) => {
  const [open, setOpen] = useState(false);
  const shown = open ? checks : checks.slice(0, SHOWN);
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {shown.map(c => (
        <span
          key={c.name}
          title={`${c.name}: ${c.kind === 'bot' ? 'a bot judges it' : 'a script runs it'}, ${c.mode}`}
          className={cx(
            'flex items-center gap-1 rounded border px-1.5 py-px text-[10px] leading-4',
            c.mode === 'block' || c.mode === 'stop'
              ? 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300'
              : 'border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-500'
          )}
        >
          <Glyph name={c.mode === 'stop' ? 'stop' : c.kind} className="size-2.5" />
          {c.name}
        </span>
      ))}
      {checks.length > SHOWN && (
        <button
          onClick={() => setOpen(!open)}
          className="rounded px-1.5 py-px text-[10px] leading-4 text-zinc-500 underline-offset-2 hover:underline"
        >
          {open ? 'fewer' : `+${checks.length - SHOWN} more`}
        </button>
      )}
    </div>
  );
};

const Box = ({ node, run, ref }: { node: Node; run: ViewProps['run']; ref: (el: HTMLDivElement | null) => void }) => {
  const human = node.doer === 'human';
  const current = !!node.run?.current && run?.status !== 'done';
  const asking = current && run?.status === 'asking';
  const waiting = current && run?.status === 'waiting';
  const stopped = current && run?.status === 'stopped';
  const refused = current && run?.status === 'running' && node.run!.tries > 0;
  return (
    <div ref={ref} className="relative" style={{ width: BOX }}>
      {node.each && (
        <>
          <div className="absolute inset-0 translate-x-2 translate-y-2 rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
          <div className="absolute inset-0 translate-x-1 translate-y-1 rounded-md border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950" />
        </>
      )}
      <div
        className={cx(
          'relative rounded-md border bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-900',
          human && 'border-dashed bg-white dark:bg-zinc-950',
          current ? cx('border-2', accentBorder) : 'border-zinc-300 dark:border-zinc-700',
          node.run?.visited && !current && 'border-l-2 border-l-sky-600 dark:border-l-sky-400'
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{node.step}</span>
          <span className={cx('ml-auto flex items-center gap-1.5', accentText)}>
            {refused && <Glyph name="retry" title={`refused, retrying: ${run?.carry ?? ''}`} className="size-3.5" />}
            {(asking || waiting) && <Glyph name="hand" title={run?.reason ?? 'waits for a human'} className="size-4" />}
            {stopped && <Glyph name="stop" title={run?.reason ?? 'stopped'} className="size-4" />}
          </span>
        </div>
        <div className={cx('flex items-center gap-1', waiting ? accentText : 'text-zinc-500')}>
          {human && <Glyph name="person" />}
          <span className="truncate">{waiting ? 'waiting for a human' : human ? 'waits for a human' : node.doer}</span>
        </div>
        {node.each && <div className="text-[11px] text-zinc-400">{eachText(node.each)}</div>}
        {(asking || stopped) && <div className={cx('truncate', accentText)}>{run?.reason}</div>}
        {node.checks.length > 0 && <Chips checks={node.checks} />}
        {!human && (node.checks.length > 0 || node.tries > 1) && <Tries node={node} asking={asking} />}
      </div>
    </div>
  );
};

/** Nested ways back each take a lane one step further out; the shortest span sits closest to the boxes. */
const lanesOf = (graph: Graph) => {
  const at = (step: string) => graph.nodes.findIndex(n => n.step === step);
  const back = graph.edges.filter(e => e.kind === 'back');
  const sorted = [...back].sort((a, b) => at(a.from) - at(a.to) - (at(b.from) - at(b.to)));
  return sorted.map((e, lane) => ({ edge: e, lane, from: at(e.from), to: at(e.to) }));
};

const roundsText = (e: Edge, waits: boolean) => {
  if (e.rounds === undefined) return waits ? 'as often as a human asks' : 'no cap';
  return e.taken !== undefined ? `${e.taken} of ${e.rounds} rounds` : `${e.rounds} rounds`;
};

/** Steps top to bottom, the pass arrow straight down, every way back a lane on the right. */
export const Column = ({ graph, run }: ViewProps) => {
  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const frame = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<{ top: number; height: number }[]>([]);
  useLayoutEffect(() => {
    const measure = () => {
      const top = frame.current?.getBoundingClientRect().top ?? 0;
      setRects(
        boxes.current.slice(0, graph.nodes.length).map(el => {
          const r = el?.getBoundingClientRect();
          return { top: (r?.top ?? 0) - top, height: r?.height ?? 0 };
        })
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of boxes.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [graph]);

  const lanes = lanesOf(graph);
  const done = run?.status === 'done';
  const stopped = run?.status === 'stopped';
  const width = BOX + (lanes.length ? 28 + lanes.length * LANE : 16);
  const height = rects.length ? Math.max(...rects.map(r => r.top + r.height)) : 0;

  return (
    <div className="px-8 py-6">
      <p className="mb-5 text-xs text-zinc-500">
        at most {graph.worst} {graph.worst === 1 ? 'session' : 'sessions'} before it asks a human
      </p>
      <div ref={frame} className="relative" style={{ width }}>
        <Pill>{graph.trigger}</Pill>
        <Down taken={!!run} />
        {graph.nodes.map((node, k) => (
          <div key={node.step}>
            <Box node={node} run={run} ref={el => void (boxes.current[k] = el)} />
            <Down taken={k + 1 < graph.nodes.length ? !!graph.nodes[k + 1]!.run?.visited : done} />
          </div>
        ))}
        <Pill
          {...((done || stopped) && {
            className: cx('border', accentBorder, accentText),
          })}
        >
          {done && <Glyph name="tick" />}
          {stopped && <Glyph name="stop" />}
          {stopped ? 'stopped' : 'end'}
        </Pill>
        {rects.length === graph.nodes.length && (
          <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={width} height={height}>
            {lanes.map(({ edge, lane, from, to }) => {
              const a = rects[from]!;
              const b = rects[to]!;
              const y1 = a.top + a.height * (from === to ? 0.7 : 0.5);
              const y2 = b.top + Math.min(b.height * (from === to ? 0.3 : 0.5), 22);
              const x = BOX + 28 + lane * LANE;
              const r = 8;
              const taken = (edge.taken ?? 0) > 0;
              return (
                <path
                  key={`${edge.from}-${edge.to}`}
                  d={`M${BOX + (graph.nodes[from]!.each ? 8 : 0)} ${y1}H${x - r}q${r} 0 ${r} ${-r}V${y2 + r}q0 ${-r} ${-r} ${-r}H${BOX + 6}`}
                  fill="none"
                  strokeWidth={taken ? 1.75 : 1.25}
                  className={taken ? 'stroke-sky-600 dark:stroke-sky-400' : 'stroke-zinc-400 dark:stroke-zinc-600'}
                  strokeDasharray={graph.nodes[from]!.doer === 'human' ? '4 3' : undefined}
                  markerEnd={`url(#column-head-${taken ? 'on' : 'off'})`}
                />
              );
            })}
            <defs>
              {(['on', 'off'] as const).map(k => (
                <marker
                  key={k}
                  id={`column-head-${k}`}
                  viewBox="0 0 6 6"
                  refX="5"
                  refY="3"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path
                    d="M0 0L6 3L0 6z"
                    className={k === 'on' ? 'fill-sky-600 dark:fill-sky-400' : 'fill-zinc-400 dark:fill-zinc-600'}
                  />
                </marker>
              ))}
            </defs>
          </svg>
        )}
        {rects.length === graph.nodes.length &&
          lanes.map(({ edge, lane, from, to }) => {
            const a = rects[from]!;
            const b = rects[to]!;
            const waits = graph.nodes[from]!.doer === 'human';
            const taken = (edge.taken ?? 0) > 0;
            return (
              <div
                key={`${edge.from}-${edge.to}`}
                className="absolute text-[11px] leading-4"
                style={{ left: BOX + 36 + lane * LANE, top: (b.top + a.top + a.height) / 2 - 16, width: LANE - 20 }}
              >
                <div className={cx('font-medium', taken ? accentText : 'text-zinc-600 dark:text-zinc-400')}>
                  back to {edge.to}, {roundsText(edge, waits)}
                </div>
                <div className="text-zinc-500" title={edge.until}>
                  {edge.until ? `until ${cut(edge.until)}` : waits ? 'on changes requested' : ''}
                </div>
              </div>
            );
          })}
      </div>
      <Legend />
    </div>
  );
};

const Legend = () => (
  <div className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
    <span className="flex items-center gap-1">
      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-500 px-1 text-[9px] font-semibold text-white">
        3
      </span>
      tries per visit
    </span>
    <span className="flex items-center gap-1">
      <Glyph name="script" /> script check
    </span>
    <span className="flex items-center gap-1">
      <Glyph name="bot" /> bot check
    </span>
    <span className="flex items-center gap-1">
      <Glyph name="stop" /> stop check, ends the run
    </span>
    <span className="flex items-center gap-1">
      <span className="h-3 w-5 rounded-sm border border-dashed border-zinc-400" /> warn or log, does not block
    </span>
    <span className="flex items-center gap-1">
      <Glyph name="hand" /> asks a human
    </span>
    <span className="flex items-center gap-1">
      <Glyph name="retry" /> refused, retrying
    </span>
  </div>
);
