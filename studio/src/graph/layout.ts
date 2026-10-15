import dagre from '@dagrejs/dagre';
import type { Flow } from './model.ts';

export const stepSize = { width: 210, height: 68 };
const pillSize = { width: 130, height: 28 };

type Placed = { id: string; kind: 'trigger' | 'step' | 'done'; label: string; x: number; y: number };
export type Line = { id: string; from: string; to: string; back?: string };

/** Places every flow left to right with dagre: a trigger pill, the steps, and a done node. */
export const layout = (flows: Flow[]) => {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 56 });
  g.setDefaultEdgeLabel(() => ({}));
  const nodes: Omit<Placed, 'x' | 'y'>[] = [];
  const lines: Line[] = [];
  for (const flow of flows) {
    const trigger = `trigger:${flow.workflow}`;
    const done = `done:${flow.workflow}`;
    nodes.push({ id: trigger, kind: 'trigger', label: flow.triggers.join(', ') });
    nodes.push(...flow.steps.map(s => ({ id: s.id, kind: 'step' as const, label: s.name })));
    nodes.push({ id: done, kind: 'done', label: 'done' });
    for (const to of flow.entry) lines.push({ id: `${trigger}>${to}`, from: trigger, to });
    for (const step of flow.steps) {
      for (const to of step.next) lines.push({ id: `${step.id}>${to}`, from: step.id, to });
      if (!step.next.length) lines.push({ id: `${step.id}>${done}`, from: step.id, to: done });
      for (const back of step.back)
        if (back.to !== step.id)
          lines.push({ id: `${step.id}<${back.to}`, from: step.id, to: back.to, back: back.label });
    }
  }
  for (const node of nodes) g.setNode(node.id, { ...(node.kind === 'step' ? stepSize : pillSize) });
  for (const line of lines) if (!line.back) g.setEdge(line.from, line.to);
  dagre.layout(g);
  const placed: Placed[] = nodes.map(node => {
    const { x, y, width, height } = g.node(node.id);
    return { ...node, x: x - width / 2, y: y - height / 2 };
  });
  return { placed, lines };
};
