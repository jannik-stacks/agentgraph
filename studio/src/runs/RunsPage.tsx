import { useAtom, useAtomValue } from 'jotai';
import { useMemo, useState } from 'react';
import { fixtures, served } from 'virtual:fixtures';
import { storyOfRun, WorkflowGraph } from '../graph/GraphPage.tsx';
import { trailOf } from '../graph/visits.ts';
import { pageAtom, polled, queryParam, runsAtom } from '../state.ts';
import { Combobox, Disclosure, Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';
import type { CoreRun } from './trace.ts';

const issueParam = queryParam('issue');

/** Each issue the runs worked on, newest first, as a filter option with its title and body, else its workflows. */
const issuesOf = (runs: CoreRun[]) => {
  const byIssue = new Map<number, { workflows: Set<string>; title?: string | undefined; body?: string | undefined }>();
  for (const { run } of runs.toSorted((a, b) => a.run.started.localeCompare(b.run.started))) {
    const seen = byIssue.get(run.issue) ?? { workflows: new Set() };
    byIssue.set(run.issue, {
      workflows: seen.workflows.add(run.workflow),
      title: run.title ?? seen.title,
      body: run.body ?? seen.body,
    });
  }
  return [...byIssue]
    .sort(([a], [b]) => b - a)
    .map(([issue, { workflows, title, body }]) => ({
      value: String(issue),
      label: `#${issue} ${title ?? [...workflows].join(', ')}`,
      ...(body !== undefined && { detail: body }),
    }));
};

const RunList = () => {
  const { value: runs, failure } = useAtomValue(runsAtom);
  const [issue, setIssue] = useAtom(issueParam);
  const options = useMemo(() => issuesOf(runs ?? []), [runs]);
  if (!runs) return <Muted>{failure ?? 'Loading runs.'}</Muted>;
  if (!runs.length) return <Muted>No runs in this data dir.</Muted>;
  const shown = runs
    .filter(r => issue === null || String(r.run.issue) === issue)
    .toSorted((a, b) => b.run.started.localeCompare(a.run.started));
  return (
    <>
      <Combobox label="Issue" placeholder="every issue" value={issue} options={options} onChange={setIssue} />
      <Rows rows={shown.map(r => runRow(r))} />
    </>
  );
};

const graphKey = 'bothub.runGraph';
const readOpen = () => {
  try {
    return localStorage.getItem(graphKey) !== 'closed';
  } catch {
    return true;
  }
};
const saveOpen = (open: boolean) => {
  try {
    localStorage.setItem(graphKey, open ? 'open' : 'closed');
  } catch {
    // Without storage the section opens by default next time.
  }
};

/** The run drawn over its workflow, folded or open as the reader last left it, and resizable from its corner. */
const RunGraph = ({ r }: { r: CoreRun }) => {
  const [open, setOpen] = useState(readOpen);
  const fixture = fixtures.find(f => f.id === r.fixture);
  const picked = useMemo(
    () => fixture && { fixture, run: r.run, trail: trailOf(r.run, r.trace), trace: r.trace },
    [fixture, r]
  );
  if (!picked) return null;
  return (
    <Disclosure
      open={open}
      onToggle={next => {
        setOpen(next);
        saveOpen(next);
      }}
      summary={
        <span className="min-w-0 truncate text-xs text-zinc-500">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">Graph</span> {storyOfRun(picked)}
        </span>
      }
    >
      <div className="mt-2 flex h-80 min-h-40 resize-y flex-col overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        <WorkflowGraph shown={[picked.fixture]} picked={picked} />
      </div>
    </Disclosure>
  );
};

const RunPage = ({ id }: { id: string }) => {
  const one = useMemo(
    () => polled<CoreRun | null>(`/core/runs/${encodeURIComponent(id)}`, r => r?.run.status === 'running'),
    [id]
  );
  const { value: r, failure } = useAtomValue(one);
  if (r === undefined) return <Muted>{failure ?? 'Loading the run.'}</Muted>;
  if (r === null) return <Muted>No run {id} in this data dir.</Muted>;
  return (
    <>
      <RunGraph r={r} />
      <Rows rows={[runRow(r, true)]} />
    </>
  );
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
