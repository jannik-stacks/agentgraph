import { Background, Controls, type Edge, ReactFlow, useNodesInitialized, useReactFlow, useStoreApi } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo } from 'react';
import { type GraphEdge, type GraphModel, retryLoops } from '../graph-model.ts';
import { edgeId, layout, nodeSize } from './layout.ts';
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
  const { boxes, routes } = layout(model, label);
  const nodes: FlowNode[] = model.nodes.map(node => {
    const box = boxes.get(node.id);
    return { id: node.id, type: 'graph', position: box ?? { x: 0, y: 0 }, data: { node } };
  });
  const edges: FlowEdge[] = model.edges.flatMap((edge): FlowEdge[] => {
    const { style, markerEnd } = edgeStyle[edge.kind];
    const text = label(edge);
    const common = {
      id: edgeId(edge),
      source: edge.from,
      target: edge.to,
      focusable: false,
      ...(style && { style: edge.kind === 'fans-out' ? { ...style, strokeWidth: 2 } : style }),
      ...(markerEnd && { markerEnd }),
    } satisfies Partial<Edge>;
    if (edge.from === edge.to) {
      const box = boxes.get(edge.from);
      if (!box) return [];
      return [{ ...common, type: 'loop', data: { box, color: strokeOf(edge), ...(text && { label: text }) } }];
    }
    const route = routes.get(edgeId(edge));
    if (!route) return [];
    return [
      {
        ...common,
        type: 'routed',
        data: {
          points: route.points,
          color: strokeOf(edge),
          ...(text && { label: text }),
          ...(route.label && { labelAt: route.label }),
        },
      },
    ];
  });
  return { nodes, edges };
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
    const inside = left >= margin && top >= margin && left + w * zoom <= width - margin && top + h * zoom <= height - margin;
    if (!inside) void flow.setCenter(nx + w / 2, ny + h / 2, { zoom: Math.max(zoom, 0.7), duration: 400 });
  }, [id, ready, flow, store]);
  return null;
};

export const GraphCanvas = ({
  model,
  selected,
  onSelect,
}: {
  model: GraphModel;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) => {
  const flow = useMemo(() => toFlow(model), [model]);
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
        selected: n.id === selected,
        ...(near && !near.has(n.id) && { style: { opacity: 0.45 } }),
      })),
    [flow, selected, near]
  );
  const edges = useMemo(
    () =>
      near
        ? flow.edges.map(e =>
            e.source === selected || e.target === selected
              ? e
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
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      colorMode="system"
      fitView
      fitViewOptions={{ padding: 0.06 }}
      minZoom={0.2}
    >
      <Background />
      <Controls showInteractive={false} />
      <FocusSelected id={selected} />
    </ReactFlow>
  );
};
