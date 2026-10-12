import mermaid from 'mermaid'
import { useEffect, useId, useRef } from 'react'
import type { Graph } from '../data'
import { kindColor, modeColor, type VariantProps } from '../theme'

mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', flowchart: { htmlLabels: true }, maxEdges: 2000 })

const safe = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_')

export function toMermaid(graph: Graph): string {
  const shape = { trigger: ['([', '])'], job: ['[', ']'], persona: ['{{', '}}'] } as const
  const arrow = { needs: '-->', triggers: '-.->', persona: '-. uses persona .->' } as const
  return [
    'flowchart LR',
    ...graph.nodes.map((n) => {
      const [open, close] = shape[n.kind]
      return `  ${safe(n.id)}${open}"${n.label}${n.mode ? `<br/><small>${n.mode}</small>` : ''}"${close}:::${n.mode ?? n.kind}`
    }),
    ...graph.edges.map((e) => `  ${safe(e.source)} ${arrow[e.kind]} ${safe(e.target)}`),
    ...Object.entries({ ...kindColor, ...modeColor }).map(([k, c]) => `  classDef ${k} stroke:${c},stroke-width:2px`),
    ...graph.nodes.map((n) => `  click ${safe(n.id)} mermaidSelect`),
  ].join('\n')
}

export default function Mermaid({ graph, onSelect }: VariantProps) {
  const ref = useRef<HTMLDivElement>(null)
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  useEffect(() => {
    const byId = new Map(graph.nodes.map((n) => [safe(n.id), n.id]))
    Object.assign(window, { mermaidSelect: (nodeId: string) => onSelect(byId.get(nodeId) ?? null) })
    let live = true
    void mermaid.render(id, toMermaid(graph)).then(({ svg, bindFunctions }) => {
      if (!live || !ref.current) return
      ref.current.innerHTML = svg
      bindFunctions?.(ref.current)
    })
    return () => void (live = false)
  }, [graph, id, onSelect])

  return <div ref={ref} className="scroll" />
}
