export const libs = ['elk', 'smcat', 'viz', 'mermaid', 'd2'] as const;
export type Lib = (typeof libs)[number];

export type Caption = {
  name: string;
  packages: string;
  size: string;
  layout: string;
  interaction: string;
  compound: string;
};

export const captions: Record<Lib, Caption> = {
  elk: {
    name: 'ELK + xyflow',
    packages: 'elkjs 0.12.0 (EPL-2.0), @xyflow/react 12.12.0',
    size: '426 kB gzip on top of the studio page, which already loads xyflow. Almost all of it is the GWT-compiled elk.bundled.js.',
    layout:
      'Layered layout over the whole hierarchy, top to bottom, with orthogonal routes and space reserved for labels. The cleanest result here. Closure edges from three jobs fan into four terminals without crossing the jobs.',
    interaction:
      'Pan, zoom, click to select, nodes are JSX. Dragging is off because ELK owns the routes; editing would mean re-running the layout.',
    compound:
      'Nested states are xyflow parent nodes, parallel regions sit side by side, edges start or end on a compound border. The retry loop is a routed back edge.',
  },
  smcat: {
    name: 'state-machine-cat',
    packages: 'state-machine-cat 15.0.9 (MIT), Graphviz wasm via @hpcc-js/wasm-graphviz',
    size: '663 kB gzip, of which 634 kB is the Graphviz wasm.',
    layout:
      'Graphviz dot in UML statechart notation: initial dots, dashed parallel regions, do/ activity rows under the state name, event [guard] labels. The final pseudo state has no label, so named outcomes are drawn as bold regular states.',
    interaction: 'Static SVG. Pan, zoom and click come from the lab wrapper, matched through the Graphviz title of each node.',
    compound:
      'Composite and parallel states are native and transitions may cross borders. Edges leaving a composite start from its border. Loops are dot back edges, and the closure fan-out turns into long curves.',
  },
  viz: {
    name: 'Graphviz (viz-js)',
    packages: '@viz-js/viz 3.30.0 (MIT)',
    size: '473 kB gzip, the Graphviz wasm inlined into one chunk.',
    layout:
      'Hand-written DOT, about 70 lines. Clusters for compound states, lhead and ltail clip edges at a cluster border. Compact, but parallel regions float apart and closure edges cross the page.',
    interaction: 'Static SVG element. Pan, zoom and click come from the lab wrapper, matched through node ids.',
    compound:
      'A cluster only groups nodes, so a compound state needs an anchor node inside it to be an edge end. Loops are back edges.',
  },
  mermaid: {
    name: 'mermaid stateDiagram-v2',
    packages: 'mermaid 12.0.0 (MIT)',
    size: '614 kB gzip over 32 chunks, including its own ELK chunk.',
    layout:
      'Dagre with each composite laid out on its own, then placed as a block. Readable for the run lifecycle; notes become dark boxes beside the state.',
    interaction: 'Static SVG. State diagrams have no click callbacks, so the lab wrapper adds them.',
    compound:
      'Composite and concurrent states are native, but a transition cannot join states in different composites. It is lifted to the composite, so the 3 attempts failed edge leaves implement instead of checking.',
  },
  d2: {
    name: 'd2',
    packages: '@terrastruct/d2 0.1.33 (MPL-2.0), Go compiled to wasm, in a worker',
    size: '5884 kB gzip, one 8 MB chunk with the compiler, layout engines and fonts.',
    layout:
      'd2 with its bundled ELK, top to bottom. Fine for the run lifecycle; on the workflow, container labels overflow and some cross-container edges lose segments.',
    interaction:
      'Static SVG. Pan, zoom and click come from the lab wrapper, matched through base64 class names. The worker answers without request ids, so calls are queued.',
    compound: 'Containers nest freely and edges address nested paths directly. No statechart notation; loops are ordinary edges.',
  },
};
