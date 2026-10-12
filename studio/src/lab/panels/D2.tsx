import { D2 as Compiler } from '@terrastruct/d2';
import { useCallback } from 'react';
import { toD2 } from '../d2.ts';
import type { PanelProps } from '../panel.ts';
import { SvgStage } from '../SvgStage.tsx';

const d2 = new Compiler();
// The worker answers in order without request ids, so calls must not overlap.
let queue: Promise<unknown> = Promise.resolve();

const decode = (name: string) => {
  try {
    return atob(name);
  } catch {
    return undefined;
  }
};

export default function D2({ chart, selected, onSelect }: PanelProps) {
  const load = useCallback(() => {
    const run = queue.then(async () => {
      const result = await d2.compile(toD2(chart), { options: { layout: 'elk' } });
      return d2.render(result.diagram, { ...result.renderOptions, noXMLTag: true, pad: 20 });
    });
    queue = run.catch(() => undefined);
    return run;
  }, [chart]);
  const tag = useCallback(
    (svg: SVGSVGElement) =>
      svg.querySelectorAll('g[class]').forEach(g => {
        for (const name of g.classList) {
          const id = `${chart.root.id}.${decode(name)}`;
          if (chart.states.has(id)) return g.setAttribute('data-state', id);
        }
      }),
    [chart]
  );
  return <SvgStage load={load} tag={tag} selected={selected} onSelect={onSelect} />;
}
