import { type ComponentType, lazy } from 'react';
import type { Graph } from '../../../../core/src/graph.ts';
import type { Run } from '../../../../core/src/workflow.ts';
import type { Trail } from './scenarios.ts';

/** What every graph view draws: the graph, and a run with the outcomes that led to it when there is one. */
export type ViewProps = { graph: Graph; run?: Run | undefined; trail?: Trail | undefined };

/** Every graph view the views page offers, one line each, the default first. */
export const views: { name: string; View: ComponentType<ViewProps> }[] = [
  { name: 'column', View: lazy(() => import('./column.tsx').then(m => ({ default: m.Column }))) },
  { name: 'timeline', View: lazy(() => import('./timeline.tsx')) },
  { name: 'chart', View: lazy(() => import('./chart.tsx')) },
];
