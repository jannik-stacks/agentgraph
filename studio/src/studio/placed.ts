import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react';
import type { Point } from './layout.ts';

const isPoint = (value: unknown): value is Point =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Point).x === 'number' &&
  typeof (value as Point).y === 'number';

const stored = new Map<string, Record<string, Point>>();

/** Dragged positions saved under `key`, read from localStorage once per key. */
export const loadPositions = (key: string): Record<string, Point> => {
  const cached = stored.get(key);
  if (cached) return cached;
  let at: Record<string, Point> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (value && typeof value === 'object')
      at = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Point] => isPoint(entry[1])));
  } catch {}
  stored.set(key, at);
  return at;
};

export const savePositions = (key: string, at: Record<string, Point>) => {
  stored.set(key, at);
  try {
    if (Object.keys(at).length) localStorage.setItem(key, JSON.stringify(at));
    else localStorage.removeItem(key);
  } catch {}
};

/** The laid out nodes at their saved positions, keeping the sizes already measured for the same ids. */
export const placeNodes = <N extends Node>(laidOut: N[], saved: Record<string, Point>, previous: N[] = []): N[] => {
  const measured = new Map(previous.map(n => [n.id, n.measured]));
  return laidOut.map(n => {
    const size = measured.get(n.id);
    return { ...n, position: saved[n.id] ?? n.position, ...(size && { measured: size }) };
  });
};

/** Applies the drag and measure changes React Flow reports; selection stays with the caller. */
export const applyMoves = <N extends Node>(changes: NodeChange<N>[], nodes: N[]): N[] => {
  const kept = changes.filter(c => c.type === 'position' || c.type === 'dimensions');
  return kept.length ? applyNodeChanges(kept, nodes) : nodes;
};

/** Marks the selected node and dims those outside `near`, returning the same object for every unchanged node. */
export const decorate = <N extends Node>(nodes: N[], selected: string | null, near: Set<string> | undefined): N[] =>
  nodes.map(n => {
    const isSelected = n.id === selected;
    const className = near && !near.has(n.id) ? 'opacity-45' : '';
    return (n.selected ?? false) === isSelected && (n.className ?? '') === className
      ? n
      : { ...n, selected: isSelected, className };
  });
