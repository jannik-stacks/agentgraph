import { useAtom, useAtomValue } from 'jotai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fixtures, served } from 'virtual:fixtures';
import { storyOfRun, WorkflowGraph } from '../graph/GraphPage.tsx';
import { trailOf } from '../graph/visits.ts';
import { pageAtom, live, queryParam, runsAtom } from '../state.ts';
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

/** A yes or no the reader set, kept in local storage under `key` when the browser allows it. */
const useStored = (key: string, fallback: boolean) => {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? fallback : saved === 'open';
    } catch {
      return fallback;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(key, next ? 'open' : 'closed');
    } catch {
      // Without storage the default comes back next time.
    }
  };
  return [value, set] as const;
};

/** The run drawn over its workflow, folded or open as the reader last left it, and resizable from its corner. */
const RunGraph = ({ r }: { r: CoreRun }) => {
  const [open, setOpen] = useStored('bothub.runGraph', true);
  const fixture = fixtures.find(f => f.id === r.fixture);
  const picked = useMemo(
    () => fixture && { fixture, run: r.run, trail: trailOf(r.run, r.trace), trace: r.trace },
    [fixture, r]
  );
  if (!picked) return null;
  return (
    <Disclosure
      open={open}
      onToggle={setOpen}
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
  const one = useMemo(() => live<CoreRun | null>(`/core/runs/${encodeURIComponent(id)}`), [id]);
  const { value: r, failure } = useAtomValue(one);
  const [expand, setExpand] = useStored('bothub.expandSessions', true);
  const end = useRef<HTMLDivElement>(null);
  const following = expand && r?.run.status === 'running';
  useEffect(() => {
    if (!following) return;
    for (const box of document.querySelectorAll('[data-scroll]')) box.scrollTop = box.scrollHeight;
    end.current?.scrollIntoView({ block: 'end' });
  }, [following, r]);
  if (r === undefined) return <Muted>{failure ?? 'Loading the run.'}</Muted>;
  if (r === null) return <Muted>No run {id} in this data dir.</Muted>;
  return (
    <>
      <RunGraph r={r} />
      <label className="flex w-fit items-center gap-1.5 text-xs text-zinc-500">
        <input type="checkbox" checked={expand} onChange={e => setExpand(e.target.checked)} />
        Open every session{r.run.status === 'running' && ' and follow the newest events'}
      </label>
      <Rows rows={[runRow(r, true, expand)]} />
      <div ref={end} />
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
