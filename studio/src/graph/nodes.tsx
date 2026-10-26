import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  type Node,
  type NodeProps,
  Position,
} from '@xyflow/react';
import { useSetAtom } from 'jotai';
import type { ReactNode } from 'react';
import type { Graph } from '../../../src/graph.ts';
import type { Run } from '../../../src/workflow.ts';
import { statusTip } from '../runs/rows.tsx';
import { selectedStepAtom } from '../state.ts';
import { accent, cx, TipBubble, Tooltip, useTip } from '../ui.tsx';
import { type Chip, type ChipKind, getStepDoerKind, makeStepChips, splitStepChips } from './chips.ts';
import { chipRoom, type CanvasPoint } from './layout.ts';

type GraphNode = Graph['nodes'][number];
type GraphEdge = Graph['edges'][number];

const paths = {
  agent: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 13v1M15 13v1" />
    </>
  ),
  script: <path d="m5 8 4 4-4 4M12 17h7" />,
  stop: (
    <>
      <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z" fill="currentColor" />
      <path d="M8 12h8" stroke="white" />
    </>
  ),
  hand: (
    <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21v-1a6 6 0 0 1 12 0v1" />
    </>
  ),
  each: <path d="M7 4h13v13M4 7h13v13H4z" />,
  checks: <path d="m4 7 2 2 4-4M4 17l2 2 4-4M14 7h6M14 17h6" />,
  tick: <path d="m5 12 5 5 9-10" />,
  traces: <path d="M4 6h16M4 12h10M4 18h13" />,
  aside: <path d="M4 5h16v11H9l-5 4z" />,
  writes: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
};

/** A small glyph in the current text color. */
const Glyph = ({ name, className = 'size-3' }: { name: keyof typeof paths; className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={cx('shrink-0', className)}
  >
    {paths[name]}
  </svg>
);

/** The ring around the selected step, the one the side panel shows. */
const ring = 'ring-2 ring-zinc-900 ring-offset-2 ring-offset-zinc-50 dark:ring-zinc-100 dark:ring-offset-zinc-900';

const handle = '!pointer-events-none !min-h-0 !min-w-0 !h-px !w-px !border-0 !bg-transparent';
/** Where arrows end: a few pixels short of the node, so the head never touches its border. */
const arrival = { left: -5 };

/** The run drawn over one step: how often it came here, and the run itself while it stands here. */
type Overlay = { visits: number; here?: Run | undefined };

type StepData = {
  node: GraphNode;
  overlay?: Overlay | undefined;
  live?: Record<string, number> | undefined;
  hidden: ReadonlySet<string>;
  selected: boolean;
};
export type StepFlowNode = Node<StepData, 'step'>;

const triesTip = (tries: number) =>
  `${tries === 1 ? 'One try' : `Up to ${tries} tries`}. A failing check sends its findings back into the same session. Out of tries it asks you; an answer gives it one more try, and stop ends the run.`;

/** A round badge on a corner of the step. */
const Bubble = ({ tip, className, children }: { tip: string; className: string; children: ReactNode }) => (
  <Tooltip tip={tip} action="Click for the step" focusable className={cx('absolute', className)}>
    <span className="flex h-5 min-w-5 cursor-pointer items-center justify-center gap-0.5 rounded-full px-1.5 font-mono text-[10px] font-semibold tabular-nums text-white ring-2 ring-white dark:ring-zinc-950">
      {children}
    </span>
  </Tooltip>
);

const chipKinds: Record<ChipKind, { look: string; tip: string }> = {
  who: {
    look: 'rounded-sm border border-current/20 bg-current/10 px-1 font-medium',
    tip: 'Who runs the step: the model alias, or you.',
  },
  checks: {
    look: 'rounded-sm border border-current/30 px-1',
    tip: 'What gates the step: its checks, and how many an agent judges.',
  },
  writes: {
    look: 'rounded-sm bg-current/10 px-1 opacity-85',
    tip: 'What its agent may write to GitHub.',
  },
  how: { look: 'opacity-70', tip: 'How it runs: once per item, reading traces, answering asides.' },
};

const ChipLabel = ({ kind, glyph, label, className }: Omit<Chip, 'tip'> & { className?: string }) => (
  <span
    className={cx(
      'flex items-center gap-1 font-mono text-[10px] leading-4 whitespace-nowrap',
      chipKinds[kind].look,
      className
    )}
  >
    {glyph && <Glyph name={glyph} />}
    {label}
  </span>
);

const StepChip = ({ tip, ...chip }: Chip) => (
  <Tooltip tip={tip} action="Click for the step" focusable className="shrink-0">
    <ChipLabel {...chip} />
  </Tooltip>
);

const shineTiming = (id: string) => {
  const h = [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return {
    '--shine-duration': `${2.2 + (h % 2000) / 1000}s`,
    '--shine-delay': `${-((h >>> 11) % 4000) / 1000}s`,
  } as React.CSSProperties;
};

const statusLine = (node: GraphNode, run: Run) =>
  run.status === 'waiting' && run.reason !== undefined
    ? 'asking you'
    : run.status === 'waiting'
      ? 'waiting for you'
      : run.status === 'stopped'
        ? 'stopped'
        : node.run && node.run.tries > 0
          ? `try ${Math.min(node.run.tries + 1, node.tries)} of ${node.tries}`
          : 'working';

/** A step: what it does, its checks and its tries, with the run's position when one is drawn. */
export const StepCard = ({ id, data: { node, overlay, live, hidden, selected } }: NodeProps<StepFlowNode>) => {
  const kind = getStepDoerKind(node.doer);
  const here = overlay?.here;
  const refused = !!here && !!node.run && node.run.tries > 0;
  const running = here ? here.status === 'running' : !!live?.running;
  const status = here
    ? statusLine(node, here)
    : live &&
      Object.entries(live)
        .map(([status, n]) => `${n} ${status}`)
        .join(', ');
  const { title, rows } = splitStepChips(makeStepChips(node, hidden), chipRoom);
  return (
    <div
      className={cx(
        'relative isolate flex size-full cursor-pointer flex-col gap-0.5 rounded-md border px-2.5 pt-3 text-xs transition-shadow',
        here || live
          ? cx(accent.border, accent.tint, 'text-sky-900 dark:text-sky-100')
          : 'border-zinc-200 bg-white text-zinc-700 dark:text-zinc-300 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700',
        node.each !== undefined
          ? 'shadow-[3px_3px_0_-1px_var(--color-white),3px_3px_0_0_var(--color-zinc-200),6px_6px_0_-1px_var(--color-white),6px_6px_0_0_var(--color-zinc-200)] dark:shadow-[3px_3px_0_-1px_var(--color-zinc-950),3px_3px_0_0_var(--color-zinc-800),6px_6px_0_-1px_var(--color-zinc-950),6px_6px_0_0_var(--color-zinc-800)]'
          : 'shadow-xs',
        selected && ring
      )}
    >
      {running && <span className="agi-shine" style={shineTiming(id)} />}
      <Handle type="target" position={Position.Left} isConnectable={false} className={handle} style={arrival} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={handle} />
      <div className="flex min-w-0 items-center gap-1.5">
        <Glyph name={kind === 'human' ? 'person' : kind} className="size-3.5 opacity-60" />
        <span className="truncate text-[13px] font-semibold">{node.step}</span>
        {title && (
          <span className="ml-auto">
            <StepChip {...title} />
          </span>
        )}
      </div>
      {status ? (
        <Tooltip
          tip={
            here
              ? statusTip(here)
              : `${status}. Click the step for its runs; hover a run's status for what it waits for.`
          }
          className="block"
        >
          <div className="mb-1 truncate text-sky-600 dark:text-sky-400">
            {status}
            {here?.reason && here.status !== 'waiting' && <span className="opacity-70">, {here.reason}</span>}
          </div>
        </Tooltip>
      ) : (
        <div className="mb-1 truncate opacity-70">{kind === 'human' ? 'waits for you' : node.doer}</div>
      )}
      <div className="flex flex-col gap-0.5">
        {rows.map((line, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {line.map((chip, j) => (
              <StepChip key={j} {...chip} />
            ))}
          </div>
        ))}
      </div>
      {kind !== 'human' && (node.tries > 1 || node.checks.length > 0) && (
        <Bubble
          tip={
            refused
              ? `Try ${Math.min(node.run!.tries + 1, node.tries)} of ${node.tries}; the last try failed its checks.`
              : triesTip(node.tries)
          }
          className={cx('-top-2.5 -right-2.5', refused ? '[&>span]:bg-sky-600' : '[&>span]:bg-zinc-600')}
        >
          {refused ? `${Math.min(node.run!.tries + 1, node.tries)}/${node.tries}` : node.tries}
        </Bubble>
      )}
      {here?.status === 'waiting' && here.reason !== undefined && (
        <Bubble tip={`Asking you: ${here.reason}`} className="-top-2.5 -left-2.5 [&>span]:bg-sky-600">
          <Glyph name="hand" />
        </Bubble>
      )}
      {here?.status === 'stopped' && (
        <Bubble tip={`Stopped: ${here.reason ?? ''}`} className="-top-2.5 -left-2.5 [&>span]:bg-sky-600">
          <Glyph name="stop" />
        </Bubble>
      )}
      {overlay && overlay.visits > 0 && !here && (
        <Bubble
          tip={overlay.visits === 1 ? 'The run passed here once.' : `The run came here ${overlay.visits} times.`}
          className="-right-2.5 -bottom-2.5 [&>span]:bg-sky-600"
        >
          {overlay.visits === 1 ? <Glyph name="tick" /> : `${overlay.visits}x`}
        </Bubble>
      )}
    </div>
  );
};

export type PillFlowNode = Node<{ label: string; done?: boolean; reached?: boolean }, 'pill'>;

/** Where a workflow starts, a dot after its trigger, or where it ends, a ringed dot; drawn as a state machine would. */
export const Pill = ({ data: { label, done, reached } }: NodeProps<PillFlowNode>) => (
  <div
    className={cx(
      'flex h-full items-center gap-1.5 text-[11px]',
      done ? 'justify-start' : 'justify-end',
      reached ? accent.text : 'text-zinc-500'
    )}
  >
    <Handle type="target" position={Position.Left} isConnectable={false} className={handle} style={arrival} />
    <Handle type="source" position={Position.Right} isConnectable={false} className={handle} />
    <Tooltip
      tip={done ? 'The run is done once its last step passes.' : `A run starts here, on ${label}.`}
      className="items-center gap-1.5"
    >
      {done ? (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-current">
          <span className="size-2 rounded-full bg-current" />
        </span>
      ) : (
        <span className="line-clamp-2 text-right leading-3.5 text-balance">{label}</span>
      )}
      {done ? <span>done</span> : <span className="size-3 shrink-0 rounded-full bg-current" />}
    </Tooltip>
  </div>
);

export type FrameFlowNode = Node<{ workflow: string; trigger: string; worst: number; selected: boolean }, 'frame'>;

/** The box around one workflow, titled with its name; the title opens the workflow. */
export const Frame = ({ data: { workflow, trigger, worst, selected } }: NodeProps<FrameFlowNode>) => {
  const select = useSetAtom(selectedStepAtom);
  return (
    <div className="pointer-events-none size-full rounded-xl border border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40">
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          select(workflow);
        }}
        className={cx(
          'nodrag pointer-events-auto m-1.5 flex items-baseline gap-2 rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-200/70 dark:hover:bg-zinc-800',
          selected && 'bg-zinc-200/70 dark:bg-zinc-800'
        )}
      >
        <span className="text-[13px] font-semibold">{workflow}</span>
        <span className="text-[11px] text-zinc-500">
          on {trigger}
          {worst > 0 && `, at most ${worst} agent sessions before it asks you`}
        </span>
      </button>
    </div>
  );
};

export type RouteFlowEdge = Edge<{ points: CanvasPoint[]; tip?: string; back?: GraphEdge }, 'route'>;

/** An orthogonal polyline through `points` with rounded corners. */
const pathOf = (points: CanvasPoint[], radius = 8) =>
  points
    .map((p, i) => {
      const before = points[i - 1];
      const after = points[i + 1];
      if (!before) return `M ${p.x} ${p.y}`;
      if (!after) return `L ${p.x} ${p.y}`;
      const r = Math.min(
        radius,
        Math.hypot(p.x - before.x, p.y - before.y) / 2,
        Math.hypot(after.x - p.x, after.y - p.y) / 2
      );
      const toward = (q: CanvasPoint) => {
        const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        return `${p.x + ((q.x - p.x) / d) * r} ${p.y + ((q.y - p.y) / d) * r}`;
      };
      return `L ${toward(before)} Q ${p.x} ${p.y} ${toward(after)}`;
    })
    .join(' ');

/** An edge laid out ahead of time; a way back also carries a badge naming its rounds, which opens the step that sends it. */
export const RouteEdge = ({ id, markerEnd, style, data }: EdgeProps<RouteFlowEdge>) => {
  const select = useSetAtom(selectedStepAtom);
  const { ref, show, hide } = useTip();
  const { points, back } = data!;
  const d = pathOf(points);
  const taken = (back?.taken ?? 0) > 0;
  const tip = back
    ? back.rounds === undefined
      ? `Requesting changes on ${back.from} sends it back to ${back.to}, as often as you like.`
      : `${back.from} sends the work back to ${back.to}${back.until ? ` until ${back.until}` : ''}. At most ${back.rounds} ${back.rounds === 1 ? 'time' : 'times'}, then it asks you.`
    : data!.tip;
  const path = (
    <>
      <BaseEdge path={d} {...(markerEnd && { markerEnd })} {...(style && { style })} />
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ pointerEvents: 'stroke' }}
        onMouseEnter={e => {
          const { clientX, clientY } = e;
          show(() => new DOMRect(clientX, clientY, 0, 0), 100);
        }}
        onMouseLeave={hide}
      />
      <EdgeLabelRenderer>
        <TipBubble ref={ref} tip={tip} />
      </EdgeLabelRenderer>
    </>
  );
  if (!back) return path;
  const workflow = id.slice(0, id.indexOf('/'));
  const label =
    back.rounds === undefined
      ? 'back on changes'
      : taken
        ? `round ${back.taken} of ${back.rounds}`
        : `back, ${back.rounds} ${back.rounds === 1 ? 'round' : 'rounds'}`;
  const [, a, b] = points;
  return (
    <>
      {path}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{ transform: `translate(-50%, -50%) translate(${(a!.x + b!.x) / 2}px, ${a!.y}px)` }}
        >
          <Tooltip tip={tip} action={`Click for ${back.from}`}>
            <button
              type="button"
              onClick={() => select(`${workflow}/${back.from}`)}
              className={cx(
                'rounded-full border bg-white px-2 py-px text-[10px] whitespace-nowrap transition-[border-color,box-shadow] duration-300 hover:shadow-sm dark:bg-zinc-950',
                taken
                  ? cx(accent.border, accent.text)
                  : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600'
              )}
            >
              {label}
            </button>
          </Tooltip>
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

const LegendItem = ({ mark, children }: { mark: ReactNode; children: ReactNode }) => (
  <li className="flex items-center gap-1.5">
    {mark}
    {children}
  </li>
);

/** What the badges mean, short of what the graph says by itself. */
export const Legend = ({ hidden, onToggle }: { hidden: ReadonlySet<string>; onToggle: (kind: ChipKind) => void }) => (
  <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1 text-[11px] text-zinc-500">
    <LegendItem
      mark={
        <span className="flex size-3.5 items-center justify-center rounded-full bg-zinc-600 text-[8px] font-semibold text-white">
          3
        </span>
      }
    >
      tries
    </LegendItem>
    <LegendItem
      mark={
        <svg width="16" height="2" aria-hidden className="text-zinc-400">
          <line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeDasharray="4 3" />
        </svg>
      }
    >
      not the main path
    </LegendItem>
    {(Object.keys(chipKinds) as ChipKind[]).map(kind => (
      <li key={kind}>
        <Tooltip tip={chipKinds[kind].tip} action={hidden.has(kind) ? 'Click to show' : 'Click to hide'}>
          <button type="button" aria-pressed={!hidden.has(kind)} onClick={() => onToggle(kind)}>
            <ChipLabel
              kind={kind}
              label={kind}
              className={cx('transition-opacity', hidden.has(kind) && 'line-through opacity-40')}
            />
          </button>
        </Tooltip>
      </li>
    ))}
    <LegendItem mark={<span className={cx('size-3 rounded-sm border', accent.border, accent.tint)} />}>
      a run is here
    </LegendItem>
    <LegendItem mark={<span className={cx('size-2.5 rounded-sm border border-zinc-200 dark:border-zinc-800', ring)} />}>
      selected
    </LegendItem>
    <li className="ml-auto">Click a step for its checks and runs.</li>
  </ul>
);
