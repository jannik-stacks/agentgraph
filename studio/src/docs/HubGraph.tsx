import { atom, useAtomValue } from 'jotai';
import { Suspense, useMemo, useState } from 'react';
import { graphModel } from '../graph-model.ts';
import { sampleModel } from '../graph-sample.ts';
import { Link } from '../Providers.tsx';
import { hubAtom } from '../state.ts';
import { GraphCanvas } from '../studio/GraphCanvas.tsx';

const configAtom = atom(async get => {
  const hub = await get(hubAtom).catch(() => undefined);
  return hub && 'config' in hub ? hub.config : undefined;
});

const Canvas = () => {
  const config = useAtomValue(configAtom);
  const model = useMemo(() => (config ? graphModel(config) : sampleModel), [config]);
  const [selected, setSelected] = useState<string | null>(null);
  return <GraphCanvas model={model} selected={selected} onSelect={setSelected} layoutKey="docs" />;
};

/** The running hub's graph, read-only, with a link to explore it in Studio. */
export const HubGraph = () => (
  <figure className="not-prose my-6">
    <div className="h-[28rem] overflow-hidden rounded-lg border border-fd-border">
      <Suspense fallback={<p className="p-4 text-sm text-fd-muted-foreground">Loading the hub.</p>}>
        <Canvas />
      </Suspense>
    </div>
    <figcaption className="mt-2 text-sm text-fd-muted-foreground">
      The hub this BHM is pointed at. <Link href="/studio">Open it in Studio</Link> to inspect each node.
    </figcaption>
  </figure>
);
