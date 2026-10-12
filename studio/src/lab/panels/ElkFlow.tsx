import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { cx } from '../../ui.tsx';
import type { ChartState } from '../chart.ts';
import { initialSuffix, type LaidEdge, layout, type Point } from '../elk-layout.ts';
import type { PanelProps } from '../panel.ts';

type StateNode = Node<{ state: ChartState | undefined; selected: boolean }, 'state'>;
type RoutedEdge = Edge<{ edge: LaidEdge }, 'routed'>;

const hidden = '!pointer-events-none !min-h-0 !min-w-0 !h-px !w-px !border-0 !bg-transparent';

const StateBox = ({ data, width, height }: NodeProps<StateNode>) => {
  const { state, selected } = data;
  const handles = (
    <>
      <Handle type="target" position={Position.Left} className={hidden} />
      <Handle type="source" position={Position.Right} className={hidden} />
    </>
  );
  if (!state) return <div className="h-3 w-3 rounded-full bg-zinc-900 dark:bg-zinc-100">{handles}</div>;
  const container = state.children.length > 0;
  return (
    <div
      style={{ width, height }}
      className={cx(
        'rounded-lg border px-2.5 py-1.5 text-[11px] leading-[15px]',
        container
          ? 'border-zinc-300 dark:border-zinc-700'
          : 'border-zinc-400 bg-white dark:border-zinc-500 dark:bg-zinc-900',
        state.type === 'parallel' && 'border-dashed',
        state.type === 'final' && 'border-[3px] border-double',
        selected && 'ring-2 ring-sky-500'
      )}
    >
      {handles}
      <div className="font-medium text-zinc-900 dark:text-zinc-100">
        {state.label}
        {state.type === 'parallel' && <span className="ml-1 font-normal text-zinc-400">parallel</span>}
      </div>
      {state.notes.map(note => (
        <div key={note} className="truncate text-zinc-500">
          {note}
        </div>
      ))}
    </div>
  );
};

const path = (points: Point[]) => points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');

const Routed = ({ data, markerEnd }: EdgeProps<RoutedEdge>) => {
  if (!data) return null;
  const { points, label, labelAt, loop } = data.edge;
  return (
    <>
      <BaseEdge
        path={path(points)}
        {...(markerEnd && { markerEnd })}
        style={{ stroke: loop ? '#d97706' : '#71717a' }}
      />
      {label && labelAt && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(${labelAt.x}px, ${labelAt.y}px)` }}
            className="nodrag nopan pointer-events-none absolute whitespace-nowrap rounded bg-white/90 px-1 text-[10px] leading-4 text-zinc-600 dark:bg-zinc-950/90 dark:text-zinc-300"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

const nodeTypes = { state: StateBox };
const edgeTypes = { routed: Routed };

export default function ElkFlow({ chart, selected, onSelect }: PanelProps) {
  const [laid, setLaid] = useState<Awaited<ReturnType<typeof layout>>>();
  useEffect(() => {
    let live = true;
    void layout(chart, 'DOWN').then(result => live && setLaid(result));
    return () => {
      live = false;
    };
  }, [chart]);
  const flow = useMemo(() => {
    if (!laid) return;
    const nodes: StateNode[] = laid.states.map(s => ({
      id: s.id,
      type: 'state',
      position: { x: s.x, y: s.y },
      width: s.width,
      height: s.height,
      ...(s.parent && { parentId: s.parent }),
      selectable: !s.id.endsWith(initialSuffix),
      data: { state: s.state, selected: s.id === selected },
    }));
    const edges: RoutedEdge[] = laid.edges.map(e => {
      const source = chart.edges.find(c => c.id === e.id);
      return {
        id: e.id,
        type: 'routed',
        source: source?.from ?? e.id.replace(/#initial$/, '') + initialSuffix,
        target: source?.to ?? chart.states.get(e.id.replace(/#initial$/, ''))?.initial ?? '',
        zIndex: 1000,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        data: { edge: e },
      };
    });
    return { nodes, edges };
  }, [laid, chart, selected]);
  if (!flow) return <p className="p-4 text-zinc-500">Laying out with ELK.</p>;
  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.1}
      fitView
      onNodeClick={(_, node) => !node.id.endsWith(initialSuffix) && onSelect(node.id)}
      onPaneClick={() => onSelect(undefined)}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
