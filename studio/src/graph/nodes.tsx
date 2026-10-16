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
import type { Graph } from '../../../core/src/graph.ts';
import type { Run } from '../../../core/src/workflow.ts';
import { selectedStepAtom } from '../state.ts';
import { cx, Tooltip } from '../ui.tsx';
import { backIn, backOut, liftOf, stepSize } from './layout.ts';

type GraphNode = Graph['nodes'][number];
type GraphEdge = Graph['edges'][number];

const paths = {
  bot: (
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
};

/** A small glyph in the current text color. */
export const Glyph = ({ name, className = 'size-3' }: { name: keyof typeof paths; className?: string }) => (
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

/** What a step does, as its left rule color. */
const doerColor = {
  bot: 'border-l-indigo-500',
  script: 'border-l-slate-500',
  human: 'border-l-amber-500',
};
const kindOf = (doer: string) => (doer === 'script' || doer === 'human' ? doer : 'bot');

const hidden = '!pointer-events-none !min-h-0 !min-w-0 !h-px !w-px !border-0 !bg-transparent';

/** The run drawn over one step: how often it came here, and where the run stands when it stands here. */
type Overlay = { visits: number; status?: Run['status'] | undefined; reason?: string | undefined };

type StepData = { node: GraphNode; overlay?: Overlay | undefined; live?: string | undefined; selected: boolean };
export type StepFlowNode = Node<StepData, 'step'>;

const each = (text: string) =>
  text === 'hunks' || text === 'files'
    ? { label: `each ${text.slice(0, -1)}`, tip: `Runs once per ${text.slice(0, -1)}, each in a fresh session.` }
    : { label: 'each item', tip: `Runs once per line that ${text} prints, each in a fresh session.` };

const triesTip = (tries: number) =>
  `${tries === 1 ? 'One try' : `Up to ${tries} tries`}. A failing check sends its findings back into the same session. Out of tries it asks you; an answer gives it one more try, and stop ends the run.`;

/** A round badge floating on a corner of the step, like an app's notification counter. */
const Bubble = ({ tip, className, children }: { tip: string; className: string; children: ReactNode }) => (
  <Tooltip tip={tip} action="Click for the step" focusable className={cx('absolute', className)}>
    <span className="flex h-5 min-w-5 cursor-pointer items-center justify-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold text-white ring-2 ring-white dark:ring-zinc-950">
      {children}
    </span>
  </Tooltip>
);

const Chip = ({ tip, className, children }: { tip: string; className?: string; children: ReactNode }) => (
  <Tooltip tip={tip} action="Click for the step" focusable className="min-w-0">
    <span
      className={cx(
        'flex min-w-0 items-center gap-1 rounded border px-1 text-[10px] leading-4 whitespace-nowrap',
        className ?? 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
      )}
    >
      {children}
    </span>
  </Tooltip>
);

const statusLine = (node: GraphNode, o: Overlay) =>
  o.status === 'asking'
    ? 'asking you'
    : o.status === 'waiting'
      ? 'waiting for you'
      : o.status === 'stopped'
        ? 'stopped'
        : node.run && node.run.tries > 0
          ? `try ${Math.min(node.run.tries + 1, node.tries)} of ${node.tries}`
          : 'working';

/** A step: what it does, its checks and its tries, with the run's position when one is drawn. */
export const StepCard = ({ data: { node, overlay, live, selected } }: NodeProps<StepFlowNode>) => {
  const kind = kindOf(node.doer);
  const here = overlay?.status !== undefined;
  const refused = here && !!node.run && node.run.tries > 0;
  const stops = node.checks.filter(c => c.mode === 'stop');
  const fan = node.each === undefined ? undefined : each(node.each);
  const status = here ? statusLine(node, overlay) : live;
  return (
    <div
      style={stepSize}
      className={cx(
        'relative flex cursor-pointer flex-col justify-center gap-0.5 rounded-md border border-l-4 bg-white px-2.5 text-xs dark:bg-zinc-950',
        doerColor[kind],
        here || live
          ? 'border-y-sky-500 border-r-sky-500 dark:border-y-sky-400 dark:border-r-sky-400'
          : 'border-y-zinc-200 border-r-zinc-200 hover:border-y-zinc-400 hover:border-r-zinc-400 dark:border-y-zinc-700 dark:border-r-zinc-700',
        fan
          ? 'shadow-[3px_3px_0_-1px_var(--color-white),3px_3px_0_0_var(--color-zinc-300),6px_6px_0_-1px_var(--color-white),6px_6px_0_0_var(--color-zinc-300)] dark:shadow-[3px_3px_0_-1px_var(--color-zinc-950),3px_3px_0_0_var(--color-zinc-700),6px_6px_0_-1px_var(--color-zinc-950),6px_6px_0_0_var(--color-zinc-700)]'
          : 'shadow-sm',
        selected && 'ring-2 ring-zinc-800 ring-offset-1 dark:ring-zinc-200 dark:ring-offset-zinc-950'
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
      <Handle
        id="out"
        type="source"
        position={Position.Top}
        isConnectable={false}
        className={hidden}
        style={{ left: `${backOut * 100}%` }}
      />
      <Handle
        id="in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={hidden}
        style={{ left: `${backIn * 100}%` }}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <Glyph name={kind === 'human' ? 'person' : kind} className="size-3.5 text-zinc-500" />
        <span className="truncate text-[13px] font-semibold">{node.step}</span>
      </div>
      {status ? (
        <div className="truncate text-sky-600 dark:text-sky-400">
          {status}
          {overlay?.reason && overlay.status !== 'waiting' && <span className="text-zinc-500">, {overlay.reason}</span>}
        </div>
      ) : (
        <div className="truncate text-zinc-500">{kind === 'human' ? 'waits for you' : node.doer}</div>
      )}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {kind === 'human' && (
          <Chip tip="Waits for you. Approve or merge to go on; request changes to send it back.">
            <Glyph name="hand" />
            you decide
          </Chip>
        )}
        {stops.map(c => (
          <Chip
            key={c.name}
            tip={`If ${c.name} fails, the run stops at once.`}
            className="border-rose-200 text-rose-700 dark:border-rose-900 dark:text-rose-300"
          >
            <Glyph name="stop" />
            {c.name}
          </Chip>
        ))}
        {node.checks.length > 0 && (
          <Chip
            tip={`${node.checks.length} ${node.checks.length === 1 ? 'check runs' : 'checks run'} after each try: ${node.checks.map(c => c.name).join(', ')}.`}
          >
            <Glyph name="checks" />
            {node.checks.length} {node.checks.length === 1 ? 'check' : 'checks'}
          </Chip>
        )}
        {fan && (
          <Chip tip={fan.tip} className="border-teal-200 text-teal-700 dark:border-teal-900 dark:text-teal-300">
            <Glyph name="each" />
            {fan.label}
          </Chip>
        )}
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
      {overlay?.status === 'asking' && (
        <Bubble tip={`Asking you: ${overlay.reason ?? ''}`} className="-top-2.5 -left-2.5 [&>span]:bg-sky-600">
          <Glyph name="hand" />
        </Bubble>
      )}
      {overlay?.status === 'stopped' && (
        <Bubble tip={`Stopped: ${overlay.reason ?? ''}`} className="-top-2.5 -left-2.5 [&>span]:bg-sky-600">
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

/** What starts a workflow, or where it ends. Static. */
export const Pill = ({ data: { label, done, reached } }: NodeProps<PillFlowNode>) => (
  <div
    className={cx(
      'flex h-full items-center justify-center truncate rounded-full border px-3 text-[11px]',
      reached
        ? 'border-sky-500 text-sky-700 dark:text-sky-300'
        : done
          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
          : 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200'
    )}
  >
    <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
    <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    {label}
  </div>
);

export type FrameFlowNode = Node<
  { workflow: string; trigger: string; worst: number; selected: boolean; width: number; height: number },
  'frame'
>;

/** The box around one workflow, titled with its name; the title opens the workflow. */
export const Frame = ({ data: { workflow, trigger, worst, selected, width, height } }: NodeProps<FrameFlowNode>) => {
  const select = useSetAtom(selectedStepAtom);
  return (
    <div
      style={{ width, height }}
      className="pointer-events-none rounded-xl border border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          select(workflow);
        }}
        className={cx(
          'nodrag pointer-events-auto m-1.5 flex items-baseline gap-2 rounded px-1.5 py-0.5 hover:bg-zinc-200/70 dark:hover:bg-zinc-800',
          selected && 'bg-zinc-200/70 dark:bg-zinc-800'
        )}
      >
        <span className="text-[13px] font-semibold">{workflow}</span>
        <span className="text-[11px] text-zinc-500">
          on {trigger}
          {worst > 0 && `, at most ${worst} bot sessions before it asks you`}
        </span>
      </button>
    </div>
  );
};

export type BackFlowEdge = Edge<{ edge: GraphEdge }, 'back'>;

/** A way back, drawn as an arc over the row with a badge naming its rounds; the badge opens the step that sends it. */
export const BackEdge = ({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps<BackFlowEdge>) => {
  const select = useSetAtom(selectedStepAtom);
  const edge = data!.edge;
  const workflow = id.slice(0, id.indexOf('/'));
  const lift = liftOf(sourceX - targetX);
  const path = `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY - lift}, ${targetX} ${targetY - lift}, ${targetX} ${targetY}`;
  const taken = (edge.taken ?? 0) > 0;
  const label =
    edge.rounds === undefined
      ? 'back on changes'
      : taken
        ? `round ${edge.taken} of ${edge.rounds}`
        : `back, ${edge.rounds} ${edge.rounds === 1 ? 'round' : 'rounds'}`;
  const tip =
    edge.rounds === undefined
      ? `Requesting changes on ${edge.from} sends it back to ${edge.to}, as often as you like.`
      : `${edge.from} sends the work back to ${edge.to}${edge.until ? ` until ${edge.until}` : ''}. At most ${edge.rounds} ${edge.rounds === 1 ? 'time' : 'times'}, then it asks you.`;
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd && { markerEnd })}
        style={{ stroke: taken ? '#0284c7' : '#fb923c', strokeWidth: 1.5, strokeDasharray: '6 4' }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${sourceY - lift * 0.75}px)`,
          }}
        >
          <Tooltip tip={tip} action={`Click for ${edge.from}`}>
            <button
              type="button"
              onClick={() => select(`${workflow}/${edge.from}`)}
              className={cx(
                'rounded-full border bg-white px-2 py-px text-[10px] whitespace-nowrap hover:shadow-sm dark:bg-zinc-950',
                taken
                  ? 'border-sky-500 text-sky-700 dark:text-sky-300'
                  : 'border-orange-300 text-orange-700 hover:border-orange-500 dark:border-orange-800 dark:text-orange-300'
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
    <span className="flex shrink-0 justify-center">{mark}</span>
    {children}
  </li>
);

/** What the badges mean. Static. */
export const Legend = () => (
  <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-200 px-4 py-1.5 text-[11px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
    <LegendItem
      mark={
        <span className="flex size-4 items-center justify-center rounded-full bg-zinc-600 text-[9px] font-semibold text-white">
          3
        </span>
      }
    >
      tries; out of tries it asks you
    </LegendItem>
    <LegendItem
      mark={
        <span className="rounded-full border border-orange-300 px-1 text-[9px] text-orange-700 dark:border-orange-800 dark:text-orange-300">
          back
        </span>
      }
    >
      a way back, at most so many rounds
    </LegendItem>
    <LegendItem mark={<Glyph name="stop" className="size-3 text-rose-600" />}>
      a failing stop check ends the run
    </LegendItem>
    <LegendItem mark={<Glyph name="each" className="size-3 text-teal-600" />}>runs once per item</LegendItem>
    <LegendItem mark={<span className="h-3 w-1 rounded-sm bg-indigo-500" />}>a bot works</LegendItem>
    <LegendItem mark={<span className="h-3 w-1 rounded-sm bg-slate-500" />}>a script runs</LegendItem>
    <LegendItem mark={<span className="h-3 w-1 rounded-sm bg-amber-500" />}>waits for you</LegendItem>
    <LegendItem mark={<span className="size-2.5 rounded-full bg-sky-600" />}>the picked run</LegendItem>
    <li className="ml-auto text-zinc-500">Click a step or a badge for details.</li>
  </ul>
);
