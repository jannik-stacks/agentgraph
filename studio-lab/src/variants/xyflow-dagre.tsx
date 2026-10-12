import dagre from '@dagrejs/dagre'
import type { Graph } from '../data'
import { NODE_H, NODE_W, type VariantProps } from '../theme'
import { type Positions, XyflowCanvas } from './xyflow-shared'

async function layout(graph: Graph): Promise<Positions> {
  const g = new dagre.graphlib.Graph().setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 80 }).setDefaultEdgeLabel(() => ({}))
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of graph.edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  return new Map(graph.nodes.map((n) => {
    const { x, y } = g.node(n.id)
    return [n.id, { x: x - NODE_W / 2, y: y - NODE_H / 2 }]
  }))
}

export default function XyflowDagre(props: VariantProps) {
  return <XyflowCanvas {...props} layout={layout} />
}
