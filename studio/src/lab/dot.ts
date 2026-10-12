import { type Chart, type ChartState, safeId } from './chart.ts';

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const q = (text: string) => `"${text.replace(/"/g, '\\"')}"`;
const label = (state: ChartState) =>
  `<<b>${html(state.label)}</b>${state.notes.map(n => `<br/><font point-size="8" color="#71717a">${html(n)}</font>`).join('')}>`;

const init = (state: ChartState) => `${safeId(state.id)}__init`;
const firstLeaf = (state: ChartState): ChartState => (state.children[0] ? firstLeaf(state.children[0]) : state);

/** A Graphviz statechart: compound states as clusters, initial pseudo states as points, borders crossed with lhead and ltail. */
export const toDot = (chart: Chart, rankdir: 'LR' | 'TB' = 'LR') => {
  const lines: string[] = [];
  const emit = (state: ChartState, depth: number) => {
    const pad = '  '.repeat(depth);
    if (state.children.length) {
      lines.push(
        `${pad}subgraph cluster_${safeId(state.id)} {`,
        `${pad}  id=${q(`s:${state.id}`)}; label=${label(state)}; labeljust=l;`,
        `${pad}  style=${q(state.type === 'parallel' ? 'rounded,dashed' : 'rounded,filled')}; fillcolor="#fafafa"; color="#a1a1aa";`
      );
      if (state.initial) lines.push(`${pad}  ${init(state)} [shape=point width=0.1 label=""];`);
      state.children.forEach(child => emit(child, depth + 1));
      lines.push(`${pad}}`);
      return;
    }
    lines.push(
      `${pad}${safeId(state.id)} [id=${q(`s:${state.id}`)} label=${label(state)}${state.type === 'final' ? ' peripheries=2' : ''}];`
    );
  };
  const isCluster = (id: string) => !!chart.states.get(id)?.children.length;
  const head = (id: string) => {
    const state = chart.states.get(id)!;
    if (!state.children.length) return { node: safeId(id) };
    return { node: state.initial ? init(state) : safeId(firstLeaf(state).id), attr: `lhead=cluster_${safeId(id)}` };
  };
  const tail = (id: string) => {
    const state = chart.states.get(id)!;
    if (!state.children.length) return { node: safeId(id) };
    return { node: safeId(firstLeaf(state).id), attr: `ltail=cluster_${safeId(id)}` };
  };
  if (chart.root.initial) lines.push(`  ${init(chart.root)} [shape=point width=0.12 label=""];`);
  chart.root.children.forEach(child => emit(child, 1));
  const edges: string[] = [];
  if (chart.root.initial) edges.push(`  ${init(chart.root)} -> ${head(chart.root.initial).node};`);
  for (const state of chart.states.values())
    if (state !== chart.root && state.initial && isCluster(state.id))
      edges.push(`  ${init(state)} -> ${head(state.initial).node};`);
  for (const edge of chart.edges) {
    const [from, to] = [tail(edge.from), head(edge.to)];
    const attrs = [
      edge.label && `label=${q(edge.label)}`,
      from.attr,
      to.attr,
      edge.loop ? 'color="#d97706" fontcolor="#b45309"' : '',
    ].filter(Boolean);
    edges.push(`  ${from.node} -> ${to.node} [${attrs.join(' ')}];`);
  }
  return [
    'digraph statechart {',
    `  rankdir=${rankdir}; compound=true; newrank=true; nodesep=0.25; ranksep=0.4;`,
    '  fontname="Helvetica"; fontsize=11;',
    '  node [shape=box style="rounded,filled" fillcolor=white color="#71717a" fontname="Helvetica" fontsize=10 margin="0.12,0.05"];',
    '  edge [color="#71717a" fontcolor="#52525b" fontname="Helvetica" fontsize=8 arrowsize=0.6];',
    ...lines,
    ...edges,
    '}',
  ].join('\n');
};
