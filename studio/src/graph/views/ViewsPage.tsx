import { useAtom } from 'jotai';
import { Suspense, useMemo } from 'react';
import { fixtures } from 'virtual:fixtures';
import { graphOf } from '../../../../core/src/graph.ts';
import { queryParam } from '../../state.ts';
import { Muted, Segmented } from '../../ui.tsx';
import { views } from './index.ts';

const viewAtom = queryParam('view');
const workflowAtom = queryParam('workflow');
const runAtom = queryParam('run');
const definition = 'definition';

const Select = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) => (
  <select
    aria-label={label}
    className="rounded-md border border-zinc-300 bg-transparent px-2 py-0.5 text-xs dark:border-zinc-700"
    value={value}
    onChange={e => onChange(e.target.value)}
  >
    {options.map(o => (
      <option key={o}>{o}</option>
    ))}
  </select>
);

/** Every registered graph view over a fixture workflow, as defined or with a simulated run. */
export const ViewsPage = () => {
  const [viewName, setView] = useAtom(viewAtom);
  const [workflowId, setWorkflow] = useAtom(workflowAtom);
  const [runLabel, setRun] = useAtom(runAtom);
  const view = views.find(v => v.name === viewName) ?? views[0]!;
  const fixture = fixtures.find(f => f.id === workflowId) ?? fixtures.find(f => f.id === 'acme-app/issue')!;
  const sim = fixture.runs.find(r => r.label === runLabel);
  const graph = useMemo(() => graphOf(fixture.workflow, fixture.checks, sim?.run), [fixture, sim]);
  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented aria-label="View" options={views.map(v => v.name)} value={view.name} onChange={setView} />
        <Select
          label="Workflow"
          value={fixture.id}
          options={fixtures.map(f => f.id)}
          onChange={id => {
            setRun(null);
            setWorkflow(id);
          }}
        />
        <Select
          label="Run"
          value={sim?.label ?? definition}
          options={[definition, ...fixture.runs.map(r => r.label)]}
          onChange={label => setRun(label === definition ? null : label)}
        />
      </div>
      <p className="max-w-3xl text-xs text-zinc-500">{fixture.workflow.body}</p>
      <Suspense fallback={<Muted>Loading.</Muted>}>
        <view.View graph={graph} run={sim?.run} trail={sim?.trail} />
      </Suspense>
    </div>
  );
};
