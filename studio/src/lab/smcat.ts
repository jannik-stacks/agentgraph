import type { IState, IStateMachine, ITransition } from 'state-machine-cat';
import { type Chart, type ChartState, owner } from './chart.ts';

const initialOf = (state: ChartState) => `${state.id}.initial`;

/**
 * The chart as state-machine-cat's JSON AST, with each transition declared in the innermost machine that holds both
 * ends. Named final states stay regular states with a `terminal` class, since the final pseudo state has no label.
 */
export const toSmcat = (chart: Chart): IStateMachine => {
  let id = 0;
  const machine = (state: ChartState): IStateMachine => {
    const transitions: ITransition[] = [
      ...(state.initial ? [{ id: id++, from: initialOf(state), to: state.initial }] : []),
      ...chart.edges
        .filter(edge => owner(chart, edge) === state.id)
        .map(edge => ({
          id: id++,
          from: edge.from,
          to: edge.to,
          ...(edge.label && { label: edge.label }),
          ...(edge.event && { event: edge.event }),
          ...(edge.guard && { cond: edge.guard }),
          ...(edge.loop && { color: '#d97706' }),
        })),
    ];
    const states: IState[] = [
      ...(state.initial ? [{ name: initialOf(state), type: 'initial' as const }] : []),
      ...state.children.map(
        (child): IState => ({
          name: child.id,
          label: child.label,
          type: child.type === 'parallel' ? 'parallel' : 'regular',
          ...(child.type === 'final' && { class: 'terminal' }),
          ...(child.notes.length && { actions: child.notes.map(body => ({ type: 'activity' as const, body })) }),
          ...(child.children.length && { statemachine: machine(child) }),
        })
      ),
    ];
    return { states, ...(transitions.length && { transitions }) };
  };
  return machine(chart.root);
};
