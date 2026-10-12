import type { Core } from 'cytoscape'
import { Effect, Option, Queue, Schema, Stream } from 'effect'
import { Command, Mount, Runtime, Update } from 'foldkit'
import type { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { createCytoscape, selectInCytoscape } from '../cytoscape-graph'
import { datasets, type DatasetKey, type GraphNode } from '../data'
import { borderColor } from '../theme'

// MODEL

const Dataset = Schema.Literals(['small', 'big'])

export const Model = Schema.Struct({
  dataset: Dataset,
  selectedId: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDataset: { dataset: Dataset },
  ClickedGraphNode: { id: Schema.String },
  ClickedGraphBackground: {},
  ClickedClearSelection: {},
  CompletedClearGraphSelection: {},
})
export type Message = typeof Message.Type

// COMMAND

const graphs = new WeakMap<Element, Core>()
const GRAPH_ID = 'graph'

const ClearGraphSelection = Command.define('ClearGraphSelection', {
  messages: [Message.CompletedClearGraphSelection],
  execute: Effect.sync(() => {
    const element = document.getElementById(GRAPH_ID)
    const cy = element && graphs.get(element)
    if (cy) selectInCytoscape(cy, null)
    return Message.CompletedClearGraphSelection()
  }),
})

// MOUNT

const CytoscapeGraph = Mount.defineStream('CytoscapeGraph', {
  args: { initialDataset: Dataset },
  messages: [Message.ClickedGraphNode, Message.ClickedGraphBackground],
  execute: ({ element, initialDataset }) =>
    Stream.callback<typeof Message.ClickedGraphNode.Type | typeof Message.ClickedGraphBackground.Type>((queue) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const cy = createCytoscape(element as HTMLElement, datasets[initialDataset], (id) =>
              Queue.offerUnsafe(queue, id ? Message.ClickedGraphNode({ id }) : Message.ClickedGraphBackground()),
            )
            graphs.set(element, cy)
            return cy
          }),
          (cy) => Effect.sync(() => cy.destroy()),
        )
        return yield* Effect.never
      }),
    ),
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedDataset: ({ dataset }) => ({
      model: modifyFields(model, { dataset: () => dataset, selectedId: () => Option.none() }),
    }),
    ClickedGraphNode: ({ id }) => ({ model: modifyFields(model, { selectedId: () => Option.some(id) }) }),
    ClickedGraphBackground: () => ({ model: modifyFields(model, { selectedId: () => Option.none() }) }),
    ClickedClearSelection: () => ({
      model: modifyFields(model, { selectedId: () => Option.none() }),
      commands: [ClearGraphSelection()],
    }),
    CompletedClearGraphSelection: () => ({ model }),
  })

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { dataset: 'small', selectedId: Option.none() },
})

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const graph = datasets[model.dataset]
  const selected = Option.flatMap(model.selectedId, (id) => Option.fromNullishOr(graph.nodes.find((n) => n.id === id)))
  return {
    title: 'bothub studio lab (foldkit)',
    body: h.div(
      [h.Class('app')],
      [
        h.header(
          [],
          [
            h.nav([], [h.a([h.Href('./')], ['react variants']), h.span([], ['foldkit + cytoscape'])]),
            h.nav(
              [],
              Dataset.literals.map((dataset: DatasetKey) =>
                h.button(
                  [h.AriaPressed(String(dataset === model.dataset)), h.OnClick(Message.ClickedDataset({ dataset }))],
                  [`${dataset} (${datasets[dataset].nodes.length})`],
                ),
              ),
            ),
          ],
        ),
        h.main([], [h.keyed('div')(model.dataset, [h.Id(GRAPH_ID), h.Class('fill'), h.OnMount(CytoscapeGraph({ initialDataset: model.dataset }))], [])]),
        Option.match(selected, {
          onNone: () => h.aside([h.Class('panel muted')], ['select a node']),
          onSome: (node) => panel(node, h),
        }),
      ],
    ),
  }
}

const panel = (node: GraphNode, h: HtmlBuilder<Message>) =>
  h.aside(
    [h.Class('panel'), h.Style({ 'border-color': borderColor(node) })],
    [
      h.h2([], [node.label]),
      h.dl(
        [],
        Object.entries(node)
          .filter(([k]) => k !== 'id' && k !== 'label')
          .flatMap(([k, v]) => [h.dt([], [k]), h.dd([], [typeof v === 'string' ? v : JSON.stringify(v)])]),
      ),
      h.p([], [h.button([h.OnClick(Message.ClickedClearSelection())], ['clear selection'])]),
    ],
  )
