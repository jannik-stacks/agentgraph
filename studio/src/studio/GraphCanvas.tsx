import { Background, Controls, type Edge, ReactFlow, useNodesInitialized, useReactFlow, useStoreApi } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo } from 'react';
import type { GraphModel } from '../graph-model.ts';
import { layout, nodeSize } from './layout.ts';
import { LoopEdge } from './LoopEdge.tsx';
import { type FlowNode, NodeCard } from './NodeCard.tsx';
import { defaultEdgeLabel, edgeStyle } from './styles.ts';

const nodeTypes = { graph: NodeCard };
const edgeTypes = { loop: LoopEdge };

const toFlow = (model: GraphModel) => {
  const positions = layout(model);
  const nodes: FlowNode[] = model.nodes.map(node => ({
    id: node.id,
    type: 'graph',
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: { node },
  }));
  const below = (from: string, to: string) => {
    const [a, b] = [positions.get(from), positions.get(to)];
    if (!a || !b) return 0;
    const [left, right] = [Math.min(a.x, b.x), Math.max(a.x, b.x) + nodeSize.width];
    const spanned = [...positions.values()].filter(p => p.x + nodeSize.width >= left && p.x <= right);
    return Math.max(...spanned.map(p => p.y + nodeSize.height));
  };
  const edges: Edge[] = model.edges.map(edge => {
    const label = edge.label ?? defaultEdgeLabel[edge.kind];
    return {
      ...(edge.kind === 'loops-back' && { data: { below: below(edge.from, edge.to) } }),
      id: `${edge.kind}:${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      focusable: false,
      ...edgeStyle[edge.kind],
      ...(label && { label }),
    };
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
              : {
                  ...e,
                  style: { ...e.style, opacity: 0.2 },
                  labelStyle: { ...e.labelStyle, opacity: 0.3 },
                  labelBgStyle: { ...e.labelBgStyle, opacity: 0.3 },
                }
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
      minZoom={0.2}
    >
      <Background />
      <Controls showInteractive={false} />
      <FocusSelected id={selected} />
    </ReactFlow>
  );
};
