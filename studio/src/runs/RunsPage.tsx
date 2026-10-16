import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { served } from 'virtual:fixtures';
import { pageAtom, polled, runsAtom } from '../state.ts';
import { Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';
import type { CoreRun } from './trace.ts';

const RunList = () => {
  const { value: runs, failure } = useAtomValue(runsAtom);
  if (!runs) return <Muted>{failure ?? 'Loading runs.'}</Muted>;
  if (!runs.length) return <Muted>No runs in this data dir.</Muted>;
  return <Rows rows={runs.toSorted((a, b) => b.run.started.localeCompare(a.run.started)).map(r => runRow(r))} />;
};

const RunPage = ({ id }: { id: string }) => {
  const one = useMemo(
    () => polled<CoreRun | null>(`/core/runs/${encodeURIComponent(id)}`, r => r?.run.status === 'running'),
    [id]
  );
  const { value: r, failure } = useAtomValue(one);
  if (r === undefined) return <Muted>{failure ?? 'Loading the run.'}</Muted>;
  if (r === null) return <Muted>No run {id} in this data dir.</Muted>;
  return <Rows rows={[runRow(r, true)]} />;
};

/** The served hub's runs as rows, at `/runs`; one run opened with every trace line at `/runs/<id>`. */
export const RunsPage = () => {
  const { run } = useAtomValue(pageAtom);
  return (
    <div className="h-full space-y-3 overflow-y-auto p-4">
      {served && served.problems.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium">The hub does not load.</p>
          <ul className="list-disc pl-5 text-xs">
            {served.problems.map((p, i) => (
              <li key={i}>
                <span className="font-mono">{p.path}</span>: {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {run ? <RunPage id={run} /> : <RunList />}
    </div>
  );
};
