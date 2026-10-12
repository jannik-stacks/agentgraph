import mermaid from 'mermaid';
import { useCallback, useId } from 'react';
import { safeId } from '../chart.ts';
import { toMermaid } from '../mermaid.ts';
import type { PanelProps } from '../panel.ts';
import { SvgStage } from '../SvgStage.tsx';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

export default function Mermaid({ chart, selected, onSelect }: PanelProps) {
  const domId = `m${useId().replace(/\W/g, '')}`;
  const load = useCallback(async () => (await mermaid.render(domId, toMermaid(chart))).svg, [chart, domId]);
  const tag = useCallback(
    (svg: SVGSVGElement) => {
      const ids = new Map([...chart.states.keys()].map(id => [safeId(id), id]));
      svg.querySelectorAll('g[id]').forEach(g => {
        const match = /^(?:.*?-)?state-(.+)-\d+$/.exec(g.id)?.[1] ?? g.id;
        const id = ids.get(match);
        if (id) g.setAttribute('data-state', id);
      });
    },
    [chart]
  );
  return <SvgStage load={load} tag={tag} selected={selected} onSelect={onSelect} />;
}
