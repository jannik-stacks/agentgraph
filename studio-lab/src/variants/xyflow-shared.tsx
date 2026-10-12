import {
  addEdge,
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useState } from 'react'
import type { Graph, GraphNode } from '../data'
import { borderColor, kindColor, modeColor, type VariantProps } from '../theme'

export type Positions = Map<string, { x: number; y: number }>
export type FlowNode = Node<{ node: GraphNode }, 'graph'>

function GraphNodeView({ data: { node }, selected }: NodeProps<FlowNode>) {
  return (
    <div className={`node${selected ? ' selected' : ''}`} style={{ borderColor: borderColor(node) }}>
      <Handle type="target" position={Position.Left} />
      <div className="meta">
        <span className="badge" style={{ background: kindColor[node.kind] }}>{node.kind}</span>
        {node.mode && <span className="badge" style={{ background: modeColor[node.mode] }}>{node.mode}</span>}
        {node.matrix && <span>matrix</span>}
      </div>
      <div className="label">{node.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { graph: GraphNodeView }

const toEdges = (graph: Graph): Edge[] =>
  graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.kind === 'persona' ? 'uses persona' : undefined,
    animated: e.kind === 'triggers',
    style: e.kind === 'persona' ? { strokeDasharray: '4 3' } : undefined,
  }))

export function XyflowCanvas({ graph, selectedId, onSelect, layout }: VariantProps & { layout: (graph: Graph) => Promise<Positions> }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState(toEdges(graph))
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let live = true
    void layout(graph).then((positions) => {
      if (!live) return
      setNodes(graph.nodes.map((node) => ({ id: node.id, type: 'graph', position: positions.get(node.id) ?? { x: 0, y: 0 }, data: { node } })))
      setReady(true)
    })
    return () => void (live = false)
  }, [graph, layout, setNodes])

  useEffect(() => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === selectedId }))), [selectedId, setNodes])

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, label: 'added' }, es)), [setEdges])

  return (
    <div className="fill">
      <div className="toolbar">
        <span>drag handles to add an edge; select an edge + Backspace to delete</span>
      </div>
      {ready && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => onSelect(n.id)}
          onPaneClick={() => onSelect(null)}
          fitView
          minZoom={0.1}
        >
          <Background />
          <MiniMap pannable zoomable nodeColor={(n: FlowNode) => borderColor(n.data.node)} />
          <Controls />
        </ReactFlow>
      )}
    </div>
  )
}
