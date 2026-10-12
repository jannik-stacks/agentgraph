import type { Core } from 'cytoscape'
import { useEffect, useRef } from 'react'
import { createCytoscape, selectInCytoscape } from '../cytoscape-graph'
import type { VariantProps } from '../theme'

export default function Cytoscape({ graph, selectedId, onSelect }: VariantProps) {
  const container = useRef<HTMLDivElement>(null)
  const cy = useRef<Core>(null)

  useEffect(() => {
    const instance = createCytoscape(container.current!, graph, onSelect)
    cy.current = instance
    return () => instance.destroy()
  }, [graph, onSelect])

  useEffect(() => {
    if (cy.current) selectInCytoscape(cy.current, selectedId)
  }, [selectedId])

  return <div ref={container} className="fill" />
}
