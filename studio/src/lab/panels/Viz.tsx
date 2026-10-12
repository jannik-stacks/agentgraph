import { instance } from '@viz-js/viz';
import { useCallback } from 'react';
import { toDot } from '../dot.ts';
import type { PanelProps } from '../panel.ts';
import { SvgStage } from '../SvgStage.tsx';

const viz = instance();

const tag = (svg: SVGSVGElement) => {
  svg.querySelectorAll('g.node[id^="s:"], g.cluster[id^="s:"]').forEach(g => g.setAttribute('data-state', g.id.slice(2)));
};

export default function Viz({ chart, selected, onSelect }: PanelProps) {
  const load = useCallback(async () => (await viz).renderSVGElement(toDot(chart)), [chart]);
  return <SvgStage load={load} tag={tag} selected={selected} onSelect={onSelect} />;
}
