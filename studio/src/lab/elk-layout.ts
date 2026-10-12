import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Chart, ChartState } from './chart.ts';

export type Point = { x: number; y: number };
export type LaidState = { state: ChartState | undefined; id: string; parent?: string; x: number; y: number; width: number; height: number };
export type LaidEdge = { id: string; label: string; points: Point[]; labelAt?: Point; loop: boolean };

const charWidth = 6.6;
const line = 15;
export const initialSuffix = '#initial';

const textWidth = (lines: string[]) => Math.max(...lines.map(l => l.length)) * charWidth;

const leaf = (state: ChartState): ElkNode => ({
  id: state.id,
  width: Math.max(72, textWidth([state.label, ...state.notes]) + 24),
  height: 30 + state.notes.length * line,
});

const container = (state: ChartState): ElkNode => ({
  id: state.id,
  layoutOptions: {
    'elk.padding': `[top=${30 + state.notes.length * line},left=14,bottom=14,right=14]`,
    'elk.nodeSize.minimum': `(${textWidth([state.label, ...state.notes]) + 28},40)`,
    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
  },
  children: [
    ...(state.initial ? [{ id: state.id + initialSuffix, width: 12, height: 12 }] : []),
    ...state.children.map(toNode),
  ],
});

const toNode = (state: ChartState): ElkNode => (state.children.length ? container(state) : leaf(state));

const elk = new ELK();

/** Lays a chart out with ELK's layered algorithm across the whole hierarchy, with orthogonal routes in root coordinates. */
export const layout = async (chart: Chart, direction: 'RIGHT' | 'DOWN') => {
  const initialEdges: ElkExtendedEdge[] = [...chart.states.values()]
    .filter(s => s.initial && s !== chart.root)
    .map(s => ({ id: `${s.id}${initialSuffix}`, sources: [s.id + initialSuffix], targets: [s.initial!] }));
  const rootInitial = chart.root.initial
    ? [{ id: chart.root.id + initialSuffix, sources: [chart.root.id + initialSuffix], targets: [chart.root.initial] }]
    : [];
  const graph: ElkNode = {
    id: '__root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '36',
      'elk.spacing.nodeNode': '22',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.inline': 'false',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: [
      ...(chart.root.initial ? [{ id: chart.root.id + initialSuffix, width: 12, height: 12 }] : []),
      ...chart.root.children.map(toNode),
    ],
    edges: [
      ...rootInitial,
      ...initialEdges,
      ...chart.edges.map(e => ({
        id: e.id,
        sources: [e.from],
        targets: [e.to],
        labels: e.label ? [{ text: e.label, width: e.label.length * 6 + 8, height: 16 }] : [],
      })),
    ],
  };
  const laid = await elk.layout(graph);
  const states: LaidState[] = [];
  const visit = (node: ElkNode, parent?: string) => {
    for (const child of node.children ?? []) {
      states.push({
        id: child.id,
        state: chart.states.get(child.id),
        ...(parent && { parent }),
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      visit(child, child.id);
    }
  };
  visit(laid);
  const edges: LaidEdge[] = (laid.edges ?? []).map(edge => {
    const section = edge.sections?.[0];
    const points = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [];
    const label = edge.labels?.[0];
    const source = chart.edges.find(e => e.id === edge.id);
    return {
      id: edge.id,
      label: label?.text ?? '',
      points,
      ...(label?.x !== undefined && label.y !== undefined && { labelAt: { x: label.x, y: label.y } }),
      loop: source?.loop ?? false,
    };
  });
  return { states, edges };
};
