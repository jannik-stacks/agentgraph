import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { lazy, Suspense, useMemo, useRef } from 'react';
import type { ConfigError } from '../../../src/config.ts';
import { type GraphModel, graphModel } from '../graph-model.ts';
import { sampleModel } from '../graph-sample.ts';
import { editPathAtom, hubAtom, navigateAtom, sampleAtom, selectedNodeAtom, studioTabAtom, studioTabs } from '../state.ts';
import { cx, Muted } from '../ui.tsx';
import { GraphCanvas } from './GraphCanvas.tsx';
import { NodeDetails } from './NodeDetails.tsx';
import { ChangesTray } from './edit/ChangesTray.tsx';
import { draftHubAtom } from './edit/hub-edits.ts';
import { HubItems } from './edit/HubItems.tsx';
import { ItemEditor } from './edit/ItemEditor.tsx';
import { SetupView } from './SetupView.tsx';

const LabView = lazy(() => import('../lab/LabView.tsx'));

const Errors = ({ errors }: { errors: ConfigError[] }) => {
  const navigate = useSetAtom(navigateAtom);
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-6">
      <h2 className="font-semibold text-red-600 dark:text-red-400">The hub config does not compile</h2>
      <p className="text-zinc-500">Open a file to fix it here, or see every file under Setup.</p>
      <ul className="space-y-2">
        {errors.map((error, i) => (
          <li key={i} className="rounded border border-red-200 p-2 dark:border-red-900">
            <button
              type="button"
              className="font-mono text-xs text-sky-700 hover:underline dark:text-sky-400"
              onClick={() => navigate({ query: { edit: error.path, node: null } })}
            >
              {error.path}
            </button>
            <pre className="whitespace-pre-wrap text-sm">{error.message}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
};

const Studio = ({ model, errors, editable }: { model: GraphModel | undefined; errors?: ConfigError[]; editable: boolean }) => {
  const [selected, setSelected] = useAtom(selectedNodeAtom);
  const edit = useAtomValue(editPathAtom);
  const navigate = useSetAtom(navigateAtom);
  const node = model?.nodes.find(n => n.id === selected);
  const select = (id: string | null) => {
    const keep = edit && id && model?.nodes.find(n => n.id === id)?.source?.path === edit;
    if (edit && !keep) navigate({ query: { node: id, edit: null } });
    else setSelected(id);
  };
  const canvas = model?.nodes.length ? (
    <GraphCanvas model={model} selected={selected} onSelect={select} />
  ) : errors?.length ? (
    <Errors errors={errors} />
  ) : (
    <Muted>The hub has no workflows or bots yet. Add them from the list on the right.</Muted>
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {canvas}
          {model?.nodes.length && errors?.length ? (
            <p className="absolute left-3 top-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700 shadow-sm dark:bg-red-950 dark:text-red-300">
              The pending changes do not compile; the graph shows the last version that did.
            </p>
          ) : null}
        </div>
        <aside className="w-[30rem] shrink-0 overflow-y-auto border-l border-zinc-200 p-4 dark:border-zinc-800">
          {editable && edit ? (
            <ItemEditor path={edit} model={model} />
          ) : node && model ? (
            <NodeDetails node={node} model={model} />
          ) : editable ? (
            <HubItems />
          ) : (
            <p className="text-zinc-500">Select a node to see its details.</p>
          )}
        </aside>
      </div>
      {editable && <ChangesTray />}
    </div>
  );
};

const HubStudio = () => {
  const hub = useAtomValue(hubAtom);
  const draft = useAtomValue(draftHubAtom);
  const last = useRef<GraphModel | undefined>(undefined);
  const config = draft ? draft.validated.config : 'config' in hub ? hub.config : undefined;
  const model = useMemo(() => (config ? graphModel(config) : undefined), [config]);
  if (model) last.current = model;
  const errors = draft ? draft.validated.errors : 'errors' in hub ? hub.errors : [];
  return <Studio model={model ?? last.current} errors={errors} editable />;
};

const Graph = () => (useAtomValue(sampleAtom) ? <Studio model={sampleModel} editable={false} /> : <HubStudio />);

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
      <div className="min-h-0">
        {tab === 'setup' ? (
          <SetupView />
        ) : tab === 'lab' ? (
          <Suspense fallback={<Muted>Loading.</Muted>}>
            <LabView />
          </Suspense>
        ) : (
          <Graph />
        )}
      </div>
    </div>
  );
};
