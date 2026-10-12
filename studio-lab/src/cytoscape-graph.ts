import cytoscape, { type Core } from 'cytoscape'
import dagre from 'cytoscape-dagre'
import type { Graph } from './data'
import { borderColor, kindColor, NODE_H, NODE_W } from './theme'

cytoscape.use(dagre)

export function createCytoscape(container: HTMLElement, graph: Graph, onSelect: (id: string | null) => void): Core {
  const cy = cytoscape({
    container,
    elements: [
      ...graph.nodes.map((n) => ({
        data: { id: n.id, label: n.mode ? `${n.label}\n${n.kind} | ${n.mode}` : `${n.label}\n${n.kind}`, border: borderColor(n), fill: kindColor[n.kind] },
        classes: n.kind,
      })),
      ...graph.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target }, classes: e.kind })),
    ],
    style: [
      {
        selector: 'node',
        style: {
          shape: 'round-rectangle',
          width: NODE_W,
          height: NODE_H,
          label: 'data(label)',
          'text-wrap': 'wrap',
          'text-valign': 'center',
          'font-size': 12,
          'background-color': '#fff',
          'border-width': 2,
          'border-color': 'data(border)',
        },
      },
      { selector: 'node.trigger, node.persona', style: { 'background-color': 'data(fill)', color: '#fff', shape: 'round-tag' } },
      { selector: 'node:selected', style: { 'overlay-color': '#3b82f6', 'overlay-opacity': 0.2, 'overlay-padding': 4 } },
      { selector: 'edge', style: { width: 1.5, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'line-color': '#94a3b8', 'target-arrow-color': '#94a3b8' } },
      { selector: 'edge.persona', style: { 'line-style': 'dashed', label: 'uses persona', 'font-size': 9 } },
      { selector: 'edge.triggers', style: { 'line-color': kindColor.trigger, 'target-arrow-color': kindColor.trigger } },
    ],
    layout: { name: 'dagre', rankDir: 'LR', nodeSep: 24, rankSep: 80 } as cytoscape.LayoutOptions,
    selectionType: 'single',
    minZoom: 0.1,
  })
  cy.on('tap', (event) => onSelect(event.target === cy ? null : event.target.isNode() ? (event.target.id() as string) : null))
  return cy
}

export function selectInCytoscape(cy: Core, id: string | null) {
  cy.$(':selected').unselect()
  if (id) cy.getElementById(id).select()
}
