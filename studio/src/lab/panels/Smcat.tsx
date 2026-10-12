import { useCallback } from 'react';
import { render } from 'state-machine-cat';
import type { PanelProps } from '../panel.ts';
import { toSmcat } from '../smcat.ts';
import { SvgStage } from '../SvgStage.tsx';

export default function Smcat({ chart, selected, onSelect }: PanelProps) {
  const load = useCallback(
    () => render(toSmcat(chart), { inputType: 'json', outputType: 'svg', direction: 'left-right' }),
    [chart]
  );
  const tag = useCallback(
    (svg: SVGSVGElement) =>
      svg.querySelectorAll('g.node, g.cluster').forEach(g => {
        const name = g.querySelector(':scope > title')?.textContent?.replace(/^cluster_/, '');
        if (name && chart.states.has(name)) g.setAttribute('data-state', name);
      }),
    [chart]
  );
  return <SvgStage load={load} tag={tag} selected={selected} onSelect={onSelect} />;
}
