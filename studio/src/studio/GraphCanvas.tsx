import { Background, Controls, type Edge, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
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
  const nodes = useMemo(() => flow.nodes.map(n => ({ ...n, selected: n.id === selected })), [flow, selected]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={flow.edges}
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
    </ReactFlow>
  );
};
