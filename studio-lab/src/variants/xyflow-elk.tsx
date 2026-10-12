import ELK from 'elkjs/lib/elk.bundled.js'
import type { Graph } from '../data'
import { NODE_H, NODE_W, type VariantProps } from '../theme'
import { type Positions, XyflowCanvas } from './xyflow-shared'

const elk = new ELK()

async function layout(graph: Graph): Promise<Positions> {
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '24',
      'elk.portConstraints': 'FIXED_SIDE',
    },
    children: graph.nodes.map((n) => ({
      id: n.id,
      width: NODE_W,
      height: NODE_H,
      ports: [
        { id: `${n.id}:in`, layoutOptions: { 'elk.port.side': 'WEST' } },
        { id: `${n.id}:out`, layoutOptions: { 'elk.port.side': 'EAST' } },
      ],
    })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [`${e.source}:out`], targets: [`${e.target}:in`] })),
  })
  return new Map((result.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))
}

export default function XyflowElk(props: VariantProps) {
  return <XyflowCanvas {...props} layout={layout} />
}
