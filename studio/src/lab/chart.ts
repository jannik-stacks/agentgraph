import type { AnyStateMachine, AnyStateNode } from 'xstate';

export type ChartState = {
  id: string;
  label: string;
  type: 'atomic' | 'compound' | 'parallel' | 'final';
  initial?: string;
  notes: string[];
  children: ChartState[];
};
export type ChartEdge = { id: string; from: string; to: string; event: string; guard?: string; label: string; loop: boolean };
export type Chart = {
  root: ChartState;
  edges: ChartEdge[];
  states: Map<string, ChartState>;
  parent: Map<string, string>;
};

const eventName = (type: string, source: string) => {
  if (type === '') return '';
  if (type === `xstate.done.state.${source}`) return 'done';
  const after = /^xstate\.after\.([^.]+)\./.exec(type);
  if (after) return `after ${after[1]}`;
  return type;
};

const guardName = (guard: unknown): string | undefined =>
  typeof guard === 'string'
    ? guard
    : typeof guard === 'function'
      ? guard.name
      : guard && typeof guard === 'object' && 'type' in guard
        ? String(guard.type)
        : undefined;

/** Flattens an XState machine into states and labelled transitions that every renderer consumes. */
export const toChart = (machine: AnyStateMachine): Chart => {
  const states = new Map<string, ChartState>();
  const parent = new Map<string, string>();
  const edges: ChartEdge[] = [];
  const walk = (node: AnyStateNode): ChartState => {
    const children = Object.values(node.states).map(child => {
      parent.set(child.id, node.id);
      return walk(child);
    });
    const type = node.type === 'history' ? 'atomic' : node.type;
    const meta = node.meta as { label?: string } | undefined;
    const state: ChartState = {
      id: node.id,
      label: meta?.label ?? node.key,
      type,
      notes: node.description ? node.description.split('\n') : [],
      children,
      ...(node.initial?.target[0] && { initial: node.initial.target[0].id }),
    };
    states.set(node.id, state);
    const transitions = [...Object.values(node.on).flat(), ...(node.always ?? [])];
    for (const t of transitions)
      for (const target of t.target ?? []) {
        const event = eventName(t.eventType, node.id);
        const guard = guardName(t.guard);
        edges.push({
          id: `e${edges.length}`,
          from: node.id,
          to: target.id,
          event,
          ...(guard && { guard }),
          label: [event === 'done' && guard ? '' : event, guard && `[${guard}]`].filter(Boolean).join(' '),
          loop: t.reenter,
        });
      }
    return state;
  };
  return { root: walk(machine.root), edges, states, parent };
};

export const ancestors = (chart: Chart, id: string): string[] => {
  const up: string[] = [];
  for (let at = chart.parent.get(id); at; at = chart.parent.get(at)) up.push(at);
  return up;
};

/** The innermost state that contains both ends of an edge. */
export const owner = (chart: Chart, edge: Pick<ChartEdge, 'from' | 'to'>) => {
  const toPath = [edge.to, ...ancestors(chart, edge.to)];
  return ancestors(chart, edge.from).find(id => toPath.includes(id) && id !== edge.to) ?? chart.root.id;
};

/** Lifts both ends of an edge to the children of their lowest common ancestor, for notations that cannot cross compound borders. */
export const lift = (chart: Chart, edge: ChartEdge): { from: string; to: string } => {
  const fromPath = [edge.from, ...ancestors(chart, edge.from)];
  const toPath = [edge.to, ...ancestors(chart, edge.to)];
  const common = owner(chart, edge);
  const below = (path: string[]) => path[path.indexOf(common) - 1] ?? path[0]!;
  return { from: below(fromPath), to: below(toPath) };
};

export const safeId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_');
