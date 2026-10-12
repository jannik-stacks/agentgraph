import { useAtom } from 'jotai'
import { type ComponentType, lazy, Suspense } from 'react'
import { datasets, type DatasetKey, type Graph } from './data'
import { datasetAtom, selectedIdAtom, type Variant, variantAtom, variants } from './store'
import { borderColor, type VariantProps } from './theme'

const views: Record<Variant, ComponentType<VariantProps>> = {
  'xyflow-dagre': lazy(() => import('./variants/xyflow-dagre')),
  'xyflow-elk': lazy(() => import('./variants/xyflow-elk')),
  cytoscape: lazy(() => import('./variants/cytoscape')),
  reaflow: lazy(() => import('./variants/reaflow')),
  mermaid: lazy(() => import('./variants/mermaid')),
}

export function App() {
  const [variant, setVariant] = useAtom(variantAtom)
  const [dataset, setDataset] = useAtom(datasetAtom)
  const [selectedId, setSelectedId] = useAtom(selectedIdAtom)
  const graph = datasets[dataset]
  const View = views[variant]

  return (
    <div className="app">
      <header>
        <nav>
          {variants.map((v) => (
            <button key={v} aria-pressed={v === variant} onClick={() => setVariant(v)}>
              {v}
            </button>
          ))}
          <a href="./foldkit.html">foldkit</a>
        </nav>
        <nav>
          {(Object.keys(datasets) as DatasetKey[]).map((d) => (
            <button key={d} aria-pressed={d === dataset} onClick={() => setDataset(d)}>
              {d} ({datasets[d].nodes.length})
            </button>
          ))}
        </nav>
      </header>
      <main>
        <Suspense fallback={<p className="loading">loading {variant}</p>}>
          <View key={`${variant}:${dataset}`} graph={graph} selectedId={selectedId} onSelect={setSelectedId} />
        </Suspense>
      </main>
      <Panel graph={graph} selectedId={selectedId} />
    </div>
  )
}

function Panel({ graph, selectedId }: { graph: Graph; selectedId: string | null }) {
  const node = graph.nodes.find((n) => n.id === selectedId)
  if (!node) return <aside className="panel muted">select a node</aside>
  const incoming = graph.edges.filter((e) => e.target === node.id)
  const outgoing = graph.edges.filter((e) => e.source === node.id)
  return (
    <aside className="panel" style={{ borderColor: borderColor(node) }}>
      <h2>{node.label}</h2>
      <dl>
        <dt>kind</dt>
        <dd>{node.kind}</dd>
        {Object.entries(node)
          .filter(([k]) => !['id', 'kind', 'label'].includes(k))
          .map(([k, v]) => (
            <Row key={k} name={k} value={typeof v === 'string' ? v : JSON.stringify(v)} />
          ))}
        <Row name="in" value={incoming.map((e) => `${e.source} (${e.kind})`).join(', ') || '-'} />
        <Row name="out" value={outgoing.map((e) => `${e.target} (${e.kind})`).join(', ') || '-'} />
      </dl>
    </aside>
  )
}

const Row = ({ name, value }: { name: string; value: string }) => (
  <>
    <dt>{name}</dt>
    <dd>{value}</dd>
  </>
)
