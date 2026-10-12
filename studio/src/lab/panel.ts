import type { Chart } from './chart.ts';

export type PanelProps = { chart: Chart; selected: string | undefined; onSelect: (id: string | undefined) => void };
