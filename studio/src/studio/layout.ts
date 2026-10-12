import dagre from '@dagrejs/dagre';
import type { GraphModel } from '../graph-model.ts';

export const nodeSize = { width: 216, height: 72 };

/** Top-left positions from a left-to-right dagre layout. Back edges do not take part in ranking. */
export const layout = ({ nodes, edges }: GraphModel) => {
  const g = new dagre.graphlib.Graph()
    .setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 96, edgesep: 16, marginx: 24, marginy: 24 })
    .setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) g.setNode(node.id, { ...nodeSize });
  for (const edge of edges) if (edge.kind !== 'loops-back') g.setEdge(edge.from, edge.to);
  dagre.layout(g);
  return new Map(
    nodes.map(node => {
      const { x, y } = g.node(node.id);
      return [node.id, { x: x - nodeSize.width / 2, y: y - nodeSize.height / 2 }];
    })
  );
};
