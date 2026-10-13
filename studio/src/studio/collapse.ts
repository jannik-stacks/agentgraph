import type { GraphEdge, GraphModel, GraphNode, NodeKind } from '../graph-model.ts';

/** The most nodes of one kind a parent shows, and the most rows a list shows before the rest fold away. */
export const fanLimit = 5;

const spine = new Set<NodeKind>(['trigger', 'job', 'script']);
const modes = ['block', 'warn', 'shadow'];
const facetKeys = ['mode', 'type'] as const;

const modeRank = (mode: unknown) => {
  const at = modes.indexOf(String(mode));
  return at < 0 ? modes.length : at;
};

const plural = (kind: string) => (kind.endsWith('s') ? kind : `${kind}s`);

/** Splits items at the fan limit: all of them while they fit, else one fewer than the limit and the rest. */
export const fold = <T>(items: T[]) =>
  items.length <= fanLimit
    ? { shown: items, rest: [] as T[] }
    : { shown: items.slice(0, fanLimit - 1), rest: items.slice(fanLimit - 1) };

/** How many of `nodes` share each mode and each type, modes from block to shadow, types most common first. */
const facets = (nodes: GraphNode[]): NonNullable<GraphNode['stack']>['facets'] =>
  facetKeys.flatMap(key => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const value = node.data?.[key];
      if (typeof value === 'string') counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const order = (value: string) => (key === 'mode' ? modeRank(value) : -counts.get(value)!);
    return counts.size ? [{ key, counts: [...counts].sort(([a], [b]) => order(a) - order(b)) }] : [];
  });

/** The node each node hangs off: the first step it links to, else the first node it links to at all. */
const owners = ({ nodes, edges }: GraphModel) => {
  const kinds = new Map(nodes.map(n => [n.id, n.kind]));
  const near = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    const list = near.get(a);
    if (list) list.push(b);
    else near.set(a, [b]);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  return (id: string) => {
    const ids = near.get(id) ?? [];
    return ids.find(other => spine.has(kinds.get(other)!)) ?? ids[0] ?? '';
  };
};

/**
 * Groups the nodes that hang off one parent by kind, block checks before warn before shadow, and folds every group
 * past the fan limit into a stack node holding the rest. Edges of the held nodes lead to the stack, one per kind and
 * end. Triggers, jobs and scripts are the flow itself and never fold.
 */
export const collapse = (model: GraphModel): GraphModel => {
  const ownerOf = owners(model);
  const fans = new Map<string, { owner: string; kind: NodeKind; nodes: GraphNode[] }>();
  for (const node of model.nodes) {
    if (spine.has(node.kind)) continue;
    const owner = ownerOf(node.id);
    const key = `${owner}/${node.kind}`;
    const fan = fans.get(key);
    if (fan) fan.nodes.push(node);
    else fans.set(key, { owner, kind: node.kind, nodes: [node] });
  }
  const into = new Map<string, string>();
  const ordered = new Map<string, GraphNode[]>();
  for (const [key, { owner, kind, nodes }] of fans) {
    const { shown, rest } = fold(nodes.toSorted((a, b) => modeRank(a.data?.mode) - modeRank(b.data?.mode)));
    const id = `stack:${key}`;
    for (const node of rest) into.set(node.id, id);
    const stack: GraphNode[] = rest.length
      ? [
          {
            id,
            kind,
            label: `+${rest.length} ${plural(kind)}`,
            stack: { owner, members: rest.map(n => n.id), facets: facets(rest) },
          },
        ]
      : [];
    ordered.set(nodes[0]!.id, [...shown, ...stack]);
  }
  const nodes = model.nodes.flatMap(n => (spine.has(n.kind) ? [n] : (ordered.get(n.id) ?? [])));
  if (!into.size) return { nodes, edges: model.edges };
  const end = (id: string) => into.get(id) ?? id;
  const seen = new Set<string>();
  const edges = model.edges.flatMap((e): GraphEdge[] => {
    const [from, to] = [end(e.from), end(e.to)];
    const key = `${e.kind}:${from}->${to}`;
    if ((from === to && e.from !== e.to) || seen.has(key)) return [];
    seen.add(key);
    return [from === e.from && to === e.to ? e : { ...e, from, to }];
  });
  return { nodes, edges };
};

/** The stack holding each folded node, by the folded node's id. */
export const heldBy = (model: GraphModel) =>
  new Map(model.nodes.flatMap(n => n.stack?.members.map(m => [m, n.id] as const) ?? []));
