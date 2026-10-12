import { type Chart, type ChartState, lift, owner, safeId } from './chart.ts';

const text = (value: string) => value.replace(/[:;"]/g, ' ');

/**
 * The chart as mermaid stateDiagram-v2. Mermaid cannot draw a transition between states inside different composites,
 * so each transition is lifted to the children of the innermost composite that holds both ends.
 */
export const toMermaid = (chart: Chart) => {
  const lines = ['stateDiagram-v2', '  direction LR'];
  const finals: string[] = [];
  const edgesIn = (state: ChartState, pad: string) =>
    chart.edges
      .filter(edge => owner(chart, edge) === state.id)
      .map(edge => {
        const { from, to } = lift(chart, edge);
        return `${pad}${safeId(from)} --> ${safeId(to)}${edge.label ? ` : ${text(edge.label)}` : ''}`;
      });
  const body = (state: ChartState, pad: string) => {
    if (state.initial) lines.push(`${pad}[*] --> ${safeId(state.initial)}`);
    state.children.forEach(child => emit(child, pad));
    lines.push(...edgesIn(state, pad));
  };
  const emit = (state: ChartState, pad: string) => {
    const id = safeId(state.id);
    lines.push(`${pad}state "${text(state.label)}" as ${id}`);
    if (state.type === 'final') finals.push(id);
    if (state.children.length) {
      lines.push(`${pad}state ${id} {`);
      if (state.type === 'parallel')
        state.children.forEach((region, i) => {
          if (i) lines.push(`${pad}  --`);
          emit(region, `${pad}  `);
        });
      else body(state, `${pad}  `);
      lines.push(`${pad}}`);
    }
    if (state.notes.length) lines.push(`${pad}note right of ${id}`, ...state.notes.map(n => `${pad}  ${text(n)}`), `${pad}end note`);
  };
  body(chart.root, '  ');
  lines.push('  classDef terminal stroke-width:3px,stroke:#3f3f46');
  if (finals.length) lines.push(`  class ${finals.join(', ')} terminal`);
  return lines.join('\n');
};
