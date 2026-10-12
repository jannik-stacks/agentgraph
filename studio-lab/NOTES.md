# Graph library comparison for bothub studio

Run it with `NODE_OPTIONS= npm run dev`, then open `http://localhost:5173/#v=xyflow-dagre&data=small`.
Use the tabs to switch variants (the URL hash stores the variant and dataset). The foldkit
variant is a separate page at `/foldkit.html`, reachable from the "foldkit" tab.

Shared pieces: `src/data.ts` holds one neutral `{ nodes, edges }` model with node kinds
trigger, job and persona. It has two datasets: the `guard` workflow (14 nodes, 12 edges) and a
generated graph with 60 jobs, 4 triggers and 6 personas (70 nodes, 88 edges). `src/App.tsx`
holds the switcher (jotai atoms synced to the URL hash) and the shared selected-node panel.
Every React variant is loaded with `React.lazy`, so each one gets its own chunk.

Verified on Node 26.10, npm 11.19: `npm install`, `tsc --noEmit` (TypeScript 7.0.2) and
`vite build` all pass cleanly. `vite preview` served `/` and `/foldkit.html` with HTTP 200. I also
drove every variant in headless Chrome over CDP: each one renders both datasets with no console
errors, and clicking a node fills the side panel in all six. The one exception is reaflow on the
big dataset, covered below.

Install note: the Socket npm wrapper blocked the install because of a low-severity CVE in
`katex@0.16.47`, which mermaid pulls in. `package.json` overrides it to `katex@0.19.0` instead of
accepting the risk. The lab does not use mermaid's math rendering.

## Size baseline

The React shell (react 19.3 + react-dom + jotai + App + data) is **232 kB raw / 74 kB gzip**.
Every number below is what a variant adds on top of that. I measured it by loading the variant in
Chrome and gzipping every JS file it actually fetched beyond the shell.

| variant | JS added (raw / gzip) | install size (`du -sh`) |
|---|---|---|
| xyflow + dagre | 221 kB / 72 kB | @xyflow 4.0M, zustand 0.7M, @dagrejs 2.2M |
| xyflow + elk | 1574 kB / 483 kB | @xyflow 4.0M, elkjs 7.7M |
| cytoscape + dagre | 470 kB / 149 kB | cytoscape 5.9M, cytoscape-dagre 0.8M |
| reaflow | 2480 kB / 791 kB | reaflow 13M (nested elkjs 0.10), reablocks 7.4M, framer-motion 5.6M, motion 0.8M |
| mermaid | 2193 kB / 640 kB (32 chunks) | mermaid 129M, katex 4.6M, plus d3, cytoscape and its own elkjs 0.9 |
| foldkit + cytoscape | whole page 762 kB / 244 kB, no React | foldkit 4.2M, effect 53M, @effect/platform-browser 1.0M |

On the foldkit page, the foldkit + effect + snabbdom runtime chunk (with the app code) is
**288 kB raw / 94 kB gzip**. The other 470 kB raw / 149 kB gzip is cytoscape. That makes the
Effect-based runtime about 20 kB gzip heavier than react-dom + jotai.

## 1. xyflow-dagre (`src/variants/xyflow-dagre.tsx`, 19 LOC, plus `xyflow-shared.tsx`, 95 LOC)

- **Deps:** `@xyflow/react` 12.12.0 (MIT, released 2026-09-24, 15 releases in the last 12 months,
  uses zustand 4 internally) and `@dagrejs/dagre` 3.1.1 (MIT, released 2026-08-08, 8 releases
  in the last 12 months).
- **What worked:** the custom node component is plain JSX (kind badge, mode badge, matrix tag).
  The minimap, controls and background are one-liners, and dragging nodes works out of the box.
  `onNodeClick` drives the shared panel. dagre is synchronous, tiny, and has native ESM with
  types.
- **Editing:** dragging between handles adds an edge (`onConnect` + `addEdge`), and selecting an
  edge then pressing Backspace deletes it. Node positions stay in React state, so they are ready
  to persist. This is the strongest editing story of the six. The headless run verified rendering
  and node selection only; edge add and delete use xyflow's standard handlers and were not driven
  in a browser.
- **Awkward:** you convert the model into xyflow's node and edge shape yourself, and dagre
  returns node centres, so you subtract half the node size. dagre does not route edges, so
  xyflow draws beziers between handles. Layout runs once, and new edges do not re-layout.
- **Layout:** the small graph is clean. On the big graph it is readable but tall, with long edges
  to personas.
- **React 19:** native, with no warnings.

## 2. xyflow-elk (`src/variants/xyflow-elk.tsx`, 34 LOC, plus the shared 95 LOC)

- **Deps:** `elkjs` 0.12.0, released 2026-07-17, 2 releases in the last 12 months. **License:
  EPL-2.0 OR GPL-3.0-or-later.** That is weak copyleft at minimum, so check before shipping
  closed-source. Mermaid and reaflow also pull in their own elkjs copies.
- **What worked:** you get the same component as variant 1 by swapping in a different layout
  function. ELK's layered algorithm with fixed-side ports (WEST in, EAST out) packs the big graph
  noticeably tighter and with fewer crossings than dagre. The layout is async, so it can move to
  a web worker.
- **Awkward:** the ELK options are stringly typed (`'elk.layered.spacing.nodeNodeBetweenLayers'`).
  `elk.bundled.js` is a GWT-compiled 1.4 MB blob (about 440 kB gzip), which is the whole cost of
  this variant.
- **Editing:** same as variant 1.
- **Layout:** best of the set on the big graph. Orphan personas sit in a row at the top.
- **React 19:** native.

## 3. cytoscape (`src/variants/cytoscape.tsx`, 21 LOC, plus `src/cytoscape-graph.ts`, 51 LOC)

- **Deps:** `cytoscape` 3.34.3 (MIT, released 2026-09-07, 7 releases in the last 12 months,
  ships its own types) and `cytoscape-dagre` 4.0.1 (MIT, released 2026-08-28, ships its own types
  and bundles dagre). The `@types/cytoscape-dagre` package is not needed.
- **What worked:** the hand-written React wrapper is only `useRef` plus two `useEffect`s. Styling
  by kind and mode uses CSS-like selectors with `data()` mappers. It renders to canvas and stays
  fast on the big graph. The same imperative core is reused unchanged by the foldkit variant.
- **Awkward:** nodes are canvas-drawn, so a rich node (a badge, an icon, a button) means styling
  strings and the label wraps on `\n`. You cannot render HTML or JSX inside nodes without an
  extension. The `layout` option needs a cast because the extension's options do not widen
  `LayoutOptions`.
- **Editing:** dragging nodes works for free. Adding or deleting edges needs `cytoscape-edgehandles`
  or custom code, and I did not build it.
- **Layout:** the same dagre engine as variant 1, with similar results.
- **React 19:** not applicable (no React dependency); the wrapper is ours.

## 4. reaflow (`src/variants/reaflow.tsx`, 43 LOC)

- **Deps:** `reaflow` 5.4.1 (Apache-2.0). **The last release was 2025-04-08, with no releases in
  the last 12 months.** It pulls in reablocks, framer-motion/motion, d3-shape, and a nested
  elkjs 0.10 (EPL/GPL).
- **React 19:** it installs and runs. npm reports an invalid peer: reablocks' nested
  `react-highlight-words` declares `react <= 18`. No runtime errors showed up.
- **What worked:** ELK layout is built in, and node click, selection, `onNodeLink` (drag a node
  onto another to add an edge) and edge click to delete all work with very little code.
- **Awkward:** the default theme assumes a dark background, so node text was invisible until I
  added a CSS override. `fit` mis-centres the graph. On the small graph the rightmost node is
  clipped. **On the big graph, nothing is visible: 70 nodes render at about 0.3x zoom, but outside
  the viewport.** Raising `maxWidth`/`maxHeight` and calling `fitCanvas()` after layout did not
  fix it, so I left it as a recorded failure. It is also the heaviest variant (about 790 kB gzip).
- **Editing:** add and delete are easy, but nodes cannot be dragged freely because ELK owns the
  positions.

## 5. mermaid (`src/variants/mermaid.tsx`, 42 LOC, read-only)

- **Deps:** `mermaid` 12.1.0 (MIT, released 2026-10-02, 16 releases in the last 12 months). It
  bundles d3, cytoscape, elkjs 0.9 and katex (patched as described above).
- **What worked:** `toMermaid(graph)` is about 15 lines and gives shapes per kind, `classDef` per
  mode, and dotted "uses persona" edges. `click id mermaidSelect` callbacks reach the shared panel
  when `securityLevel: 'loose'` is set. The output looks good on both graphs, and the generated
  text is a free export format for docs and PRs.
- **Awkward:** the click callback goes through a global on `window`, and there is no live
  selection highlight or positional state. Every change re-renders the whole SVG. It loads 32
  chunks and about 640 kB gzip for one flowchart.
- **Editing:** none.
- **Layout:** very readable orthogonal routing on the small graph. The big graph is dense but
  legible.
- **React 19:** not applicable (renders a string into a div).

## 6. foldkit (`foldkit.html`, `src/foldkit/main.ts`, 140 LOC, `entry.ts`, 12 LOC)

- **Deps:** `foldkit` 0.168.0 (MIT, deps: parse5). Its peer deps are pinned exactly to
  `effect` 4.0.0 and `@effect/platform-browser` 4.0.0 (MIT).
- **Structure:** this follows the README's counter idioms: a Schema `Model`
  (`dataset: Literals`, `selectedId: Option<string>`), a fact-named `defineMessageUnion`, an
  exhaustive `Message.match` update with `modifyFields`, `Runtime.makeApplication`, and an
  `h.*` view. Cytoscape lives in a `Mount.defineStream` whose `execute` uses
  `Effect.acquireRelease` to create and destroy the instance, and `Stream.callback` +
  `Queue.offerUnsafe` to turn node taps into `ClickedGraphNode` / `ClickedGraphBackground`
  Messages. The graph element is `h.keyed` by dataset, so toggling the dataset remounts the
  Mount.
- **Integrating an imperative lib:** the library-to-app direction is natural and well-documented.
  Mount is exactly this seam, and teardown is scoped to the element. The app-to-library direction
  is awkward. Mount args are captured once at mount time, so pushing a Model change into
  cytoscape (the "clear selection" button) needs a `Command` that looks the element up by id plus
  a module-level `WeakMap<Element, Core>` to find the instance. React's `useEffect([selectedId])`
  is simpler for that direction.
- **Type safety:** strong. The Mount's stream type must be a subset of its declared `messages`.
  It caught me emitting the full `Message` union, which the compiler rejected. `match` is
  exhaustive, and the Model is a runtime-checked Schema. Some attribute helpers are loose
  (`AriaPressed` takes a string). The Effect vocabulary (`Stream.callback`, `Effect.gen`,
  `acquireRelease`) is a real learning cost if the team is not already on Effect.
- **Bundle:** see the size baseline. The runtime chunk is 94 kB gzip against 74 kB for the React
  shell, and the 53 MB effect install is mostly per-module sources and maps.
- **API churn risk: high.** There are 212 stable releases since the first publish on 2025-09-12,
  and 20 minor versions between 0.148 (2026-08-18) and 0.168 (2026-10-11), roughly one every
  2.7 days. Canaries ship several times a day. The README says breaking changes may occur in
  minor releases, and the peer dependency pins an exact effect version.
- **Editing:** whatever cytoscape gives you (node drag). Edge editing would be cytoscape
  extensions again.
- **Layout:** identical to variant 3.

## Recommendation

| criterion | xyflow + dagre | xyflow + elk | cytoscape | reaflow | mermaid | foldkit + cytoscape |
|---|---|---|---|---|---|---|
| JS added (gzip) | **72 kB** | 483 kB | 149 kB | 791 kB | 640 kB | 244 kB whole page |
| license | MIT | **EPL/GPL** (elkjs) | MIT | Apache + EPL/GPL (elkjs) | MIT (+ elkjs) | MIT |
| custom JSX nodes | yes | yes | no (canvas) | limited (SVG) | no | no (canvas) |
| editing (drag, add/delete edge) | **full** | **full** | drag only | add/delete, no drag | none | drag only |
| small graph layout | good | good | good | mis-fit | **best looking** | good |
| big graph layout | ok, tall | **best** | ok | **broken (off-screen)** | dense but ok | ok |
| React 19 | native | native | n/a (own wrapper) | works, stale peer | n/a | n/a (no React) |
| maintenance | active | active | active | **stale (2025-04)** | active | very active, high churn |
| variant LOC | 19 + 95 shared | 34 + 95 shared | 21 + 51 core | 43 | 42 | 152 |

**Pick @xyflow/react + @dagrejs/dagre for the studio.** It is the smallest addition at 72 kB
gzip, MIT end to end, gives fully custom JSX nodes (kind, mode and persona badges are trivial),
and is the only option with first-class editing. Since layout is a pure
`(graph) => Promise<Positions>` function, ELK can be swapped in later behind a lazy import if
big-graph layout quality becomes the bottleneck and the EPL license is acceptable.

Keep **mermaid** as a secondary output: `toMermaid(graph)` is a cheap read-only export for
READMEs and PR comments, not the studio canvas. **cytoscape** is the fallback for graphs far
beyond a few hundred nodes, where canvas rendering matters more than JSX nodes. **Avoid reaflow**
(stale, heaviest, broken fit on the big graph). **Hold off on foldkit:** its Mount and Message
design is principled and strongly typed, but the release churn, the exact Effect pin, and the
awkward Model-to-imperative-library direction make it a risky base for a canvas-heavy editor
today. It is worth revisiting once it reaches 1.0 if the rest of bothub moves to Effect.
