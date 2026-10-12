import { useState } from 'react'
import { Canvas, Edge, type EdgeData, Node, type NodeData } from 'reaflow'
import type { GraphNode } from '../data'
import { borderColor, NODE_H, NODE_W, type VariantProps } from '../theme'

export default function Reaflow({ graph, selectedId, onSelect }: VariantProps) {
  const nodes: NodeData<GraphNode>[] = graph.nodes.map((n) => ({
    id: n.id,
    text: n.mode ? `${n.label} (${n.mode})` : `${n.label} [${n.kind}]`,
    width: NODE_W,
    height: NODE_H,
    data: n,
  }))
  const [edges, setEdges] = useState<EdgeData[]>(() =>
    graph.edges.map((e) => ({ id: e.id, from: e.source, to: e.target, text: e.kind === 'persona' ? 'uses persona' : undefined })),
  )

  return (
    <div className="fill reaflow">
      <div className="toolbar">
        <span>drag from a node onto another to add an edge; click an edge to delete it</span>
      </div>
      <Canvas
        nodes={nodes}
        edges={edges}
        selections={selectedId ? [selectedId] : []}
        direction="RIGHT"
        fit
        minZoom={-0.9}
        onCanvasClick={() => onSelect(null)}
        onNodeLink={(_, from, to) => setEdges((es) => [...es, { id: `${from.id}->${to.id}:${es.length}`, from: from.id, to: to.id }])}
        node={(p) => (
          <Node
            {...p}
            style={{ fill: '#fff', stroke: borderColor((p.properties as NodeData<GraphNode>).data!), strokeWidth: 2 }}
            onClick={(_, data) => onSelect(data.id)}
          />
        )}
        edge={(p) => <Edge {...p} onClick={(_, data) => setEdges((es) => es.filter((e) => e.id !== data.id))} />}
      />
    </div>
  )
}
