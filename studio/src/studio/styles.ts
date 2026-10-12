import { type Edge, MarkerType } from '@xyflow/react';
import type { EdgeKind, NodeKind } from '../graph-model.ts';

export const nodeStyle: Record<NodeKind, string> = {
  trigger: 'rounded-2xl border-l-violet-500',
  job: 'rounded-md border-l-sky-500',
  script: 'rounded-md border-l-slate-500 font-mono',
  bot: 'rounded-md border-l-emerald-500',
  skill: 'rounded-sm border-l-amber-500',
  check: 'rounded-md border-l-rose-500',
  note: 'rounded-sm border-dashed border-l-stone-400',
  issues: 'rounded-sm border-dashed border-l-indigo-500',
  tool: 'rounded-full border-l-cyan-500',
};

const palette = {
  'violet-400': '#a78bfa',
  'sky-500': '#0ea5e9',
  'emerald-500': '#10b981',
  'amber-500': '#f59e0b',
  'rose-500': '#f43f5e',
  'orange-500': '#f97316',
  'teal-500': '#14b8a6',
  'teal-600': '#0d9488',
  'stone-400': '#a8a29e',
  'indigo-500': '#6366f1',
  'cyan-500': '#06b6d4',
};
const color = (name: keyof typeof palette) => palette[name];
const arrow = (name: keyof typeof palette) => ({
  type: MarkerType.ArrowClosed,
  color: color(name),
  width: 16,
  height: 16,
});

export const edgeStyle: Record<EdgeKind, Partial<Edge>> = {
  triggers: { style: { stroke: color('violet-400') }, markerEnd: arrow('violet-400') },
  needs: { style: { stroke: color('sky-500'), strokeWidth: 1.5 }, markerEnd: arrow('sky-500') },
  'runs-as': { style: { stroke: color('emerald-500'), strokeDasharray: '6 4' } },
  'uses-skill': { style: { stroke: color('amber-500'), strokeDasharray: '2 3' } },
  gates: { style: { stroke: color('rose-500'), strokeWidth: 2 }, markerEnd: arrow('rose-500') },
  'loops-back': {
    type: 'loop',
    style: { stroke: color('orange-500'), strokeWidth: 1.5, strokeDasharray: '8 3' },
    markerEnd: arrow('orange-500'),
  },
  'fans-out': {
    style: { stroke: color('teal-500'), strokeWidth: 3 },
    markerEnd: arrow('teal-500'),
    labelStyle: { fill: color('teal-600'), fontSize: 11 },
    labelBgPadding: [6, 2],
    labelBgBorderRadius: 8,
  },
  'reads-notes': { style: { stroke: color('stone-400'), strokeDasharray: '1 4', strokeLinecap: 'round' } },
  preloads: { style: { stroke: color('indigo-500'), strokeDasharray: '4 3' }, markerEnd: arrow('indigo-500') },
  calls: { style: { stroke: color('cyan-500'), strokeDasharray: '2 2' } },
};

export const defaultEdgeLabel: Partial<Record<EdgeKind, string>> = {
  'loops-back': 'retry',
  'fans-out': 'for each chunk',
};
