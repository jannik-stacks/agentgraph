import type { Chart, ChartState } from './chart.ts';

const quote = (value: string) => JSON.stringify(value);

/** The d2 path of a state, relative to the chart root, one quoted segment per level. */
export const d2Path = (chart: Chart, id: string) =>
  id
    .slice(chart.root.id.length + 1)
    .split('.')
    .map(quote)
    .join('.');

const initKey = '"__init"';

/** The chart as d2: compound states as containers, parallel states dashed, finals with a double border. */
export const toD2 = (chart: Chart) => {
  const lines = ['direction: down'];
  const emit = (state: ChartState, pad: string) => {
    const label = [state.label, ...state.notes].join('\n');
    lines.push(`${pad}${quote(state.id.split('.').at(-1)!)}: ${quote(label)} {`);
    lines.push(`${pad}  style.border-radius: 8`);
    if (state.type === 'final') lines.push(`${pad}  style.double-border: true`);
    if (state.type === 'parallel') lines.push(`${pad}  style.stroke-dash: 4`);
    if (state.children.length) {
      lines.push(`${pad}  style.fill: "#fafafa"`, `${pad}  label.near: top-left`);
      body(state, `${pad}  `);
    }
    lines.push(`${pad}}`);
  };
  const body = (state: ChartState, pad: string) => {
    if (state.initial) {
      lines.push(`${pad}${initKey}: "" { shape: circle; width: 12; height: 12; style.fill: "#18181b" }`);
      lines.push(`${pad}${initKey} -> ${quote(state.initial.split('.').at(-1)!)}`);
    }
    state.children.forEach(child => emit(child, pad));
  };
  body(chart.root, '');
  for (const edge of chart.edges)
    lines.push(
      `${d2Path(chart, edge.from)} -> ${d2Path(chart, edge.to)}${edge.label ? `: ${quote(edge.label)}` : ''}${
        edge.loop ? ' { style.stroke: "#d97706" }' : ''
      }`
    );
  return lines.join('\n');
};
