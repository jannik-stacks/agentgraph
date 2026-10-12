import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';
import type { ConfigError } from '../../../src/config.ts';
import { type GraphModel, graphModel } from '../graph-model.ts';
import { sampleModel } from '../graph-sample.ts';
import { hubAtom, navigateAtom, sampleAtom, selectedNodeAtom, studioTabAtom, studioTabs } from '../state.ts';
import { cx, Muted } from '../ui.tsx';
import { GraphCanvas } from './GraphCanvas.tsx';
import { NodeDetails } from './NodeDetails.tsx';
import { SetupView } from './SetupView.tsx';

const Errors = ({ errors }: { errors: ConfigError[] }) => (
  <div className="mx-auto max-w-3xl space-y-3 p-6">
    <h2 className="font-semibold text-red-600 dark:text-red-400">The hub config does not compile</h2>
    <p className="text-zinc-500">The files are still listed under Setup.</p>
    <ul className="space-y-2">
      {errors.map((error, i) => (
        <li key={i} className="rounded border border-red-200 p-2 dark:border-red-900">
          <div className="font-mono text-xs text-zinc-500">{error.path}</div>
          <pre className="whitespace-pre-wrap text-sm">{error.message}</pre>
        </li>
      ))}
    </ul>
  </div>
);

const Studio = ({ model }: { model: GraphModel }) => {
  const [selected, setSelected] = useAtom(selectedNodeAtom);
  const node = model.nodes.find(n => n.id === selected);
  if (!model.nodes.length) return <Muted>The hub has no workflows or bots yet.</Muted>;
  return (
    <div className="flex h-full">
      <div className="relative min-w-0 flex-1">
        <GraphCanvas model={model} selected={selected} onSelect={setSelected} />
      </div>
      <aside className="w-[30rem] shrink-0 overflow-y-auto border-l border-zinc-200 p-4 dark:border-zinc-800">
        {node ? (
          <NodeDetails node={node} model={model} />
        ) : (
          <p className="text-zinc-500">Select a node to see its details.</p>
        )}
      </aside>
    </div>
  );
};

const HubStudio = () => {
  const hub = useAtomValue(hubAtom);
  const model = useMemo(() => ('config' in hub ? graphModel(hub.config) : undefined), [hub]);
  return model ? <Studio model={model} /> : 'errors' in hub ? <Errors errors={hub.errors} /> : null;
};

const Graph = () => (useAtomValue(sampleAtom) ? <Studio model={sampleModel} /> : <HubStudio />);

const Tabs = () => {
  const tab = useAtomValue(studioTabAtom);
  const navigate = useSetAtom(navigateAtom);
  return (
    <div className="flex gap-1 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      {studioTabs.map(t => (
        <button
          key={t}
          aria-current={t === tab ? 'page' : undefined}
          onClick={() => navigate({ path: t === 'graph' ? '/studio' : `/studio/${t}` })}
          className={cx(
            'rounded px-2 py-0.5 text-xs capitalize',
            t === tab ? 'bg-zinc-200 dark:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900'
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
};

export const StudioView = () => {
  const tab = useAtomValue(studioTabAtom);
  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <Tabs />
      <div className="min-h-0">{tab === 'setup' ? <SetupView /> : <Graph />}</div>
    </div>
  );
};
