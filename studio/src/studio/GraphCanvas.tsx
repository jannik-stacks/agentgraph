import {
  Background,
  ControlButton,
  Controls,
  type Edge,
  type NodeChange,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type GraphEdge, type GraphModel, retryLoops } from '../graph-model.ts';
import { checkGroups, edgeId, layout, nodeSize, type Point } from './layout.ts';
import { type LoopFlowEdge, LoopEdge, type RoutedFlowEdge, RoutedEdge } from './LoopEdge.tsx';
import { type FlowNode, NodeCard } from './NodeCard.tsx';
import { defaultEdgeLabel, edgeStyle } from './styles.ts';

const nodeTypes = { graph: NodeCard };
const edgeTypes = { routed: RoutedEdge, loop: LoopEdge };

const label = (edge: GraphEdge) => edge.label ?? defaultEdgeLabel[edge.kind];

const strokeOf = (edge: GraphEdge) => String(edgeStyle[edge.kind].style?.stroke ?? '#71717a');

type FlowEdge = RoutedFlowEdge | LoopFlowEdge;

const toFlow = (source: GraphModel) => {
  const model = retryLoops(source);
  const groups = checkGroups(source);
  const { boxes, routes, main: spine } = layout(model, label, groups);
  const main = (id: string) => spine.has(id);
  const nodes: FlowNode[] = model.nodes.map(node => {
    const box = boxes.get(node.id);
    return { id: node.id, type: 'graph', position: box ? { x: box.x, y: box.y } : { x: 0, y: 0 }, data: { node } };
  });
  const edges: FlowEdge[] = model.edges.map((edge): FlowEdge => {
    const { style, markerEnd } = edgeStyle[edge.kind];
    const text = label(edge);
    const faint = !main(edge.from) || !main(edge.to);
    const gate = edge.kind === 'gates' && !!groups.get(edge.to)?.includes(edge.from);
    const color = strokeOf(edge);
    const common = {
      id: edgeId(edge),
      source: gate ? edge.to : edge.from,
      target: gate ? edge.from : edge.to,
      focusable: false,
      ...(style && {
        style: { ...style, ...(edge.kind === 'fans-out' && { strokeWidth: 2 }), ...(faint && { opacity: 0.45 }) },
      }),
      ...(markerEnd && { markerEnd }),
    } satisfies Partial<Edge>;
    if (edge.from === edge.to)
      return {
        ...common,
        type: 'loop',
        data: { checks: groups.get(edge.from) ?? [], color, ...(text && { label: text }) },
      };
    const route = routes.get(edgeId(edge));
    const [from, to] = [boxes.get(edge.from), boxes.get(edge.to)];
    const via = groups.get(edge.from);
    return {
      ...common,
      type: 'routed',
      data: {
        color,
        ...(text && { label: text }),
        ...(faint && { quiet: true }),
        ...(via && main(edge.to) && !via.includes(edge.to) && { via }),
        ...(route &&
          from &&
          to && { points: route.points, at: [from, to], ...(route.label && { labelAt: route.label }) }),
      },
    };
  });
  return { nodes, edges };
};

const storageKey = (graph: string) => `bhm:graph-layout:${import.meta.env.VITE_BHM_HUB ?? 'hub'}:${graph}`;

const isPoint = (value: unknown): value is Point =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Point).x === 'number' &&
  typeof (value as Point).y === 'number';

const load = (key: string): Record<string, Point> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!stored || typeof stored !== 'object') return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, Point] => isPoint(entry[1])));
  } catch {
    return {};
  }
};

const save = (key: string, at: Record<string, Point>) => {
  try {
    if (Object.keys(at).length) localStorage.setItem(key, JSON.stringify(at));
    else localStorage.removeItem(key);
  } catch {}
};

/** Node positions the user dragged to, remembered per hub and graph for the nodes that still exist. */
const useMoved = (key: string, ids: Set<string>) => {
  const [state, setState] = useState(() => ({ key, at: load(key) }));
  if (state.key !== key) setState({ key, at: load(key) });
  const latest = useRef(state.at);
  latest.current = state.at;
  const at = state.key === key ? state.at : {};
  return {
    at,
    moved: Object.keys(at).some(id => ids.has(id)),
    move: (changes: NodeChange<FlowNode>[]) => {
      const moves = changes.flatMap(c => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []));
      if (moves.length) setState(s => ({ ...s, at: { ...s.at, ...Object.fromEntries(moves) } }));
    },
    persist: (dropped: FlowNode[]) => {
      const all = { ...latest.current, ...Object.fromEntries(dropped.map(n => [n.id, n.position])) };
      save(key, Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
    },
    reset: () => {
      setState({ key, at: {} });
      save(key, {});
    },
  };
};

const ResetIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path
      d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const GraphControls = ({ moved, onReset }: { moved: boolean; onReset: () => void }) => {
  const flow = useReactFlow();
  return (
    <Controls showInteractive={false}>
      <ControlButton
        title="Reset layout"
        aria-label="Reset layout"
        disabled={!moved}
        onClick={() => {
          onReset();
          requestAnimationFrame(() => void flow.fitView({ padding: 0.06, duration: 300 }));
        }}
      >
        <ResetIcon />
      </ControlButton>
    </Controls>
  );
};

const margin = 24;

/** Pans the selected node into view when it is outside the visible part of the canvas. */
const FocusSelected = ({ id }: { id: string | null }) => {
  const flow = useReactFlow();
  const store = useStoreApi();
  const ready = useNodesInitialized();
  useEffect(() => {
    const node = id && ready ? flow.getInternalNode(id) : undefined;
    if (!node) return;
    const { width, height } = store.getState();
    const { x, y, zoom } = flow.getViewport();
    const { x: nx, y: ny } = node.internals.positionAbsolute;
    const w = node.measured.width ?? nodeSize.width;
    const h = node.measured.height ?? nodeSize.height;
    const [left, top] = [nx * zoom + x, ny * zoom + y];
    const inside =
      left >= margin && top >= margin && left + w * zoom <= width - margin && top + h * zoom <= height - margin;
    if (!inside) void flow.setCenter(nx + w / 2, ny + h / 2, { zoom: Math.max(zoom, 0.7), duration: 400 });
  }, [id, ready, flow, store]);
  return null;
};

/** The hub graph, draggable; `layoutKey` names the graph whose dragged positions are remembered. */
export const GraphCanvas = ({
  model,
  selected,
  onSelect,
  layoutKey,
}: {
  model: GraphModel;
  selected: string | null;
  onSelect: (id: string | null) => void;
  layoutKey: string;
}) => {
  const flow = useMemo(() => toFlow(model), [model]);
  const ids = useMemo(() => new Set(model.nodes.map(n => n.id)), [model]);
  const moved = useMoved(storageKey(layoutKey), ids);
  const near = useMemo(() => {
    if (!selected) return undefined;
    const ids = new Set([selected]);
    for (const e of flow.edges) if (e.source === selected || e.target === selected) ids.add(e.source).add(e.target);
    return ids;
  }, [flow, selected]);
  const nodes = useMemo(
    () =>
      flow.nodes.map(n => ({
        ...n,
        position: moved.at[n.id] ?? n.position,
        selected: n.id === selected,
        ...(near && !near.has(n.id) && { style: { opacity: 0.45 } }),
      })),
    [flow, selected, near, moved.at]
  );
  const edges = useMemo(
    () =>
      near
        ? flow.edges.map(e =>
            e.source === selected || e.target === selected
              ? ({ ...e, data: { ...e.data!, quiet: false } } as FlowEdge)
              : ({ ...e, data: { ...e.data!, dim: true } } as FlowEdge)
          )
        : flow.edges,
    [flow, selected, near]
  );
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesConnectable={false}
      onNodesChange={moved.move}
      onNodeDragStop={(_, __, dropped) => moved.persist(dropped)}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      colorMode="system"
      fitView
      fitViewOptions={{ padding: 0.06 }}
      minZoom={0.2}
    >
      <Background />
      <GraphControls moved={moved.moved} onReset={moved.reset} />
      <FocusSelected id={selected} />
    </ReactFlow>
  );
};
