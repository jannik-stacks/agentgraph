import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { lazy, Suspense } from 'react';
import type { ConfigError } from '../../../src/config.ts';
import type { GraphModel } from '../graph-model.ts';
import { sampleModel } from '../graph-sample.ts';
import { editPathAtom, navigateAtom, sampleAtom, selectedNodeAtom, studioTabAtom, studioTabs } from '../state.ts';
import { Link } from '../Providers.tsx';
import { cx, Muted } from '../ui.tsx';
import { GraphCanvas } from './GraphCanvas.tsx';
import { NodeDetails } from './NodeDetails.tsx';
import { ChangesTray } from './edit/ChangesTray.tsx';
import { HubItems } from './edit/HubItems.tsx';
import { ItemEditor } from './edit/ItemEditor.tsx';
import { useHubModel } from './hub-model.ts';
import { NotesView } from './NotesView.tsx';
import { SetupView } from './SetupView.tsx';
import { StudioLayout } from './StudioLayout.tsx';

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

/** Selects a node, closing the editor unless it edits the selected node's file. */
const useSelect = (model: GraphModel | undefined) => {
  const [selected, setSelected] = useAtom(selectedNodeAtom);
  const edit = useAtomValue(editPathAtom);
  const navigate = useSetAtom(navigateAtom);
  const select = (id: string | null) => {
    const keep = edit && id && model?.nodes.find(n => n.id === id)?.source?.path === edit;
    if (edit && !keep) navigate({ query: { node: id, edit: null } });
    else setSelected(id);
  };
  return { selected, select, node: model?.nodes.find(n => n.id === selected), edit };
};

const SampleStudio = () => {
  const { selected, select, node } = useSelect(sampleModel);
  return (
    <StudioLayout
      aside={
        node ? (
          <NodeDetails node={node} model={sampleModel} />
        ) : (
          <p className="text-zinc-500">Select a node to see its details.</p>
        )
      }
    >
      <GraphCanvas model={sampleModel} selected={selected} onSelect={select} layoutKey="sample" />
    </StudioLayout>
  );
};

const HubStudio = () => {
  const { model, errors } = useHubModel();
  const { selected, select, node, edit } = useSelect(model);
  return (
    <StudioLayout
      aside={
        edit ? (
          <ItemEditor path={edit} model={model} />
        ) : node && model ? (
          <NodeDetails node={node} model={model} />
        ) : (
          <HubItems />
        )
      }
      footer={<ChangesTray />}
    >
      {model?.nodes.length ? (
        <GraphCanvas model={model} selected={selected} onSelect={select} layoutKey="hub" />
      ) : errors.length ? (
        <Errors errors={errors} />
      ) : (
        <Muted>The hub has no workflows or bots yet. Add them from the list on the right.</Muted>
      )}
      {model?.nodes.length && errors.length ? (
        <p className="absolute left-3 bottom-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700 shadow-sm dark:bg-red-950 dark:text-red-300">
          The pending changes do not compile; the graph shows the last version that did.
        </p>
      ) : null}
    </StudioLayout>
  );
};

const Graph = () => (useAtomValue(sampleAtom) ? <SampleStudio /> : <HubStudio />);

const Tabs = () => {
  const tab = useAtomValue(studioTabAtom);
  return (
    <nav className="flex gap-1 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      {studioTabs.map(t => (
        <Link
          key={t}
          href={t === 'graph' ? '/studio' : `/studio/${t}`}
          aria-current={t === tab ? 'page' : undefined}
          className={cx(
            'rounded px-2 py-0.5 text-xs capitalize',
            t === tab ? 'bg-zinc-200 dark:bg-zinc-800' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900'
          )}
        >
          {t}
        </Link>
      ))}
    </nav>
  );
};

const tabs = { graph: Graph, notes: NotesView, setup: SetupView, lab: LabView } satisfies Record<
  (typeof studioTabs)[number],
  unknown
>;

export const StudioView = () => {
  const Tab = tabs[useAtomValue(studioTabAtom)];
  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <Tabs />
      <div className="min-h-0">
        <Suspense fallback={<Muted>Loading.</Muted>}>
          <Tab />
        </Suspense>
      </div>
    </div>
  );
};
