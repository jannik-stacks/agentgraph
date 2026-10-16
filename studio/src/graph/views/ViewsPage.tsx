import { useAtom } from 'jotai';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { fixtures } from 'virtual:fixtures';
import { graphOf } from '../../../../core/src/graph.ts';
import type { Trace } from '../../../../core/src/store.ts';
import type { Run } from '../../../../core/src/workflow.ts';
import { queryParam } from '../../state.ts';
import { Muted, Segmented } from '../../ui.tsx';
import { say } from '../../runs/trace.ts';
import { views } from './index.ts';
import type { Trail } from './scenarios.ts';

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

/** Rebuilds a real run's trail from the outcome lines of its trace, each with the run as it stood before. */
const trailOf = (run: Run, trace: Trace[]): Trail => {
  let before: Pick<Run, 'status' | 'tries' | 'rounds'> = { status: 'running', tries: 0, rounds: {} };
  return trace.flatMap(line => {
    if (!('outcome' in line)) return [];
    const at = { ...run, ...before, step: line.step };
    before = line.run;
    return [{ at, outcome: line.outcome }];
  });
};

/** Every registered graph view over a workflow, as defined, with a simulated run, or with a real run of the served hub. */
export const ViewsPage = () => {
  const [viewName, setView] = useAtom(viewAtom);
  const [workflowId, setWorkflow] = useAtom(workflowAtom);
  const [runLabel, setRun] = useAtom(runAtom);
  const view = views.find(v => v.name === viewName) ?? views[0]!;
  const fixture = fixtures.find(f => f.id === workflowId) ?? fixtures.find(f => f.id === 'acme-app/issue')!;
  const [step, setStep] = useState<string | null>(null);
  const [real, setReal] = useState<{ fixture: string; run: Run; trace: Trace[] }[]>([]);
  useEffect(() => {
    const poll = () =>
      fetch('/core/runs')
        .then(r => (r.ok ? r.json() : []))
        .then(setReal, () => {});
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  const runs = real.filter(r => r.fixture === fixture.id);
  const picked = runs.find(r => r.run.id === runLabel);
  const sim = picked
    ? {
        label: picked.run.id,
        run: picked.run,
        trail: trailOf(picked.run, picked.trace),
      }
    : fixture.runs.find(r => r.label === runLabel);
  const graph = useMemo(() => graphOf(fixture.workflow, fixture.checks, sim?.run), [fixture, sim?.run]);
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
          options={[definition, ...fixture.runs.map(r => r.label), ...runs.map(r => r.run.id)]}
          onChange={label => setRun(label === definition ? null : label)}
        />
      </div>
      <p className="max-w-3xl text-xs text-zinc-500">{fixture.workflow.body}</p>
      <div onClick={e => setStep((e.target as Element).closest('[data-step]')?.getAttribute('data-step') ?? null)}>
        <Suspense fallback={<Muted>Loading.</Muted>}>
          <view.View graph={graph} run={sim?.run} trail={sim?.trail} />
        </Suspense>
      </div>
      {picked && step && (
        <ol className="max-w-3xl space-y-0.5 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
          {picked.trace
            .filter(line => line.step === step)
            .map((line, i) => (
              <li key={i} className="truncate" title={say(line)}>
                {line.at.slice(11, 19)} {say(line)}
                {'applied' in line && line.applied.url && (
                  <a className="ml-1 text-sky-600 underline" href={line.applied.url} target="_blank" rel="noreferrer">
                    {line.applied.url.replace('https://github.com/', '')}
                  </a>
                )}
              </li>
            ))}
        </ol>
      )}
    </div>
  );
};
