import type { Graph, GraphNode, Mode, NodeKind } from './data'

export const kindColor: Record<NodeKind, string> = {
  trigger: '#6366f1',
  job: '#334155',
  persona: '#0d9488',
}

export const modeColor: Record<Mode, string> = {
  shadow: '#94a3b8',
  warn: '#d97706',
  block: '#dc2626',
}

export const borderColor = (node: GraphNode) => (node.mode ? modeColor[node.mode] : kindColor[node.kind])

export const NODE_W = 180
export const NODE_H = 52

export interface VariantProps {
  graph: Graph
  selectedId: string | null
  onSelect: (id: string | null) => void
}
