import {
  type Edge,
  MarkerType,
  type Node,
  type NodeProps,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAtom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { clock } from '../runs/bits.tsx';
import { useLiveStream } from '../runs/live.ts';
import { phaseWord } from '../runs/model.ts';
import { hubAtom, selectedStepAtom } from '../state.ts';
import { accent, cx, Muted } from '../ui.tsx';
import { layout, stepSize } from './layout.ts';
import { flowsOf, type Step } from './model.ts';
import { type StepState, stepStatesAtom } from './state.ts';
import { StepDetails } from './StepDetails.tsx';

type StepData = { step: Step; state?: StepState | undefined; selected: boolean };
type PillData = { label: string };

const handles = (
  <>
    <Handle type="target" position={Position.Left} />
    <Handle type="source" position={Position.Right} />
  </>
);

/** What a step's latest run says, when it needs attention or finished. */
const stateLine = (state: StepState, tries: number | undefined) => {
  if (state.phase === 'running') return `running${state.startedAt ? ` since ${clock(state.startedAt)}` : ''}`;
  if (state.phase === 'failed' && tries) return `${phaseWord('failed', state.status)}, try ${state.tries} of ${tries}`;
  return phaseWord(state.phase, state.status);
};

/** A step: its name, its bot, its checks and tries, and its latest run when that needs attention. */
const StepCard = ({ data: { step, state, selected } }: NodeProps<Node<StepData>>) => {
  const live = state && state.phase !== 'done';
  const counts = [
    step.checks.length && `${step.checks.length} ${step.checks.length === 1 ? 'check' : 'checks'}`,
    step.tries && `${step.tries} tries`,
  ].filter(Boolean);
  return (
    <div
      style={stepSize}
      className={cx(
        'flex flex-col justify-center rounded-md border bg-white px-3 text-xs dark:bg-zinc-950',
        live ? accent.border : 'border-zinc-300 dark:border-zinc-700',
        state?.phase === 'waiting' || state?.phase === 'queued' ? 'border-dashed' : '',
        selected && 'ring-2 ring-zinc-800 ring-offset-1 dark:ring-zinc-200 dark:ring-offset-zinc-950'
      )}
    >
      {handles}
      <div className="flex items-center gap-2">
        <span className="truncate text-[13px] font-medium">{step.name}</span>
        {state?.phase === 'done' && <span className="ml-auto text-zinc-400">done</span>}
      </div>
      <div className="truncate text-zinc-500">{step.bot ?? 'runs a command'}</div>
      {live ? (
        <div className={cx('truncate', accent.text)}>{stateLine(state, step.tries)}</div>
      ) : (
        counts.length > 0 && <div className="truncate text-[11px] text-zinc-400">{counts.join(', ')}</div>
      )}
    </div>
  );
};

const Pill = ({ data: { label } }: NodeProps<Node<PillData>>) => (
  <div className="rounded-full border border-zinc-300 px-3 py-1 text-[11px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
    {handles}
    {label}
  </div>
);

const nodeTypes = { step: StepCard, pill: Pill };

const arrow = { type: MarkerType.ArrowClosed, color: '#a1a1aa' };

/** The workflows as steps; layout runs when the hub changes, and the cards redraw when a step's run changes status. */
const Canvas = ({ steps, placed }: { steps: Map<string, Step>; placed: ReturnType<typeof layout> }) => {
  const [selected, select] = useAtom(selectedStepAtom);
  const { states } = useAtomValue(stepStatesAtom);
  const nodes = useMemo(
    () =>
      placed.placed.map((p): Node<StepData | PillData> => {
        const step = steps.get(p.id);
        return step
          ? {
              id: p.id,
              type: 'step',
              position: p,
              data: { step, state: states.get(p.id), selected: p.id === selected },
            }
          : { id: p.id, type: 'pill', position: p, data: { label: p.label }, selectable: false };
      }),
    [placed, steps, states, selected]
  );
  const edges = useMemo(
    () =>
      placed.lines.map((line): Edge => ({
        id: line.id,
        source: line.from,
        target: line.to,
        type: 'smoothstep',
        markerEnd: arrow,
        style: { stroke: '#a1a1aa', ...(line.back && { strokeDasharray: '4 4' }) },
        ...(line.back && { label: line.back }),
      })),
    [placed]
  );
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ maxZoom: 1 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => steps.has(node.id) && select(node.id === selected ? null : node.id)}
      onPaneClick={() => select(null)}
    />
  );
};

/** The hub's workflows as a step graph, with the selected step's details beside it. */
export const GraphPage = () => {
  useLiveStream();
  const hub = useAtomValue(hubAtom);
  const selected = useAtomValue(selectedStepAtom);
  const config = 'config' in hub ? hub.config : undefined;
  const { steps, placed } = useMemo(() => {
    const flows = config ? flowsOf(config) : [];
    return { steps: new Map(flows.flatMap(f => f.steps).map(s => [s.id, s])), placed: layout(flows) };
  }, [config]);
  if ('errors' in hub)
    return (
      <div className="space-y-2 p-4">
        <p className="font-medium">The hub does not compile.</p>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {hub.errors.map((error, i) => (
            <li key={i}>
              <span className="font-mono">{error.path}</span>: {error.message}
            </li>
          ))}
        </ul>
      </div>
    );
  if (!steps.size) return <Muted>This hub has no workflows.</Muted>;
  const step = selected ? steps.get(selected) : undefined;
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <ReactFlowProvider>
          <Canvas steps={steps} placed={placed} />
        </ReactFlowProvider>
      </div>
      {step && (
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-zinc-200 dark:border-zinc-800">
          <StepDetails step={step} />
        </aside>
      )}
    </div>
  );
};
