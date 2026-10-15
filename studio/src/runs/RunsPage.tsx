import { useAtom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { infoAtom, pageAtom, runIdAtom, statusFilterAtom } from '../state.ts';
import { cx, Link, Muted } from '../ui.tsx';
import { live, useLiveStream } from './live.ts';
import { groupRuns, type Phase } from './model.ts';
import { PullsView } from './PullsView.tsx';
import { RunList } from './RunList.tsx';
import { RunView } from './RunView.tsx';

const filters = ['all', 'running', 'waiting', 'failed'] as const;
const matches: Record<(typeof filters)[number], (phase: Phase) => boolean> = {
  all: () => true,
  running: phase => phase === 'running' || phase === 'queued',
  waiting: phase => phase === 'waiting',
  failed: phase => phase === 'failed',
};

/** The stream's state when it is not plainly live. */
const Connection = () => {
  const connected = useAtomValue(live.connected);
  const failure = useAtomValue(live.failure);
  if (connected) return null;
  return (
    <span role="status" className="text-xs text-zinc-500">
      {failure ? `API unreachable: ${failure}` : 'reconnecting'}
    </span>
  );
};

const NoRuns = () => {
  const info = useAtomValue(infoAtom);
  return (
    <div className="space-y-1 p-4 text-sm text-zinc-500">
      <p>
        No runs in {info ? <code className="font-mono">{info.dataReal ?? info.data}</code> : 'this data directory'}.
      </p>
      <p>Run npm run seed in studio/ to add an example run.</p>
    </div>
  );
};

/** The run list beside one run, filtered by phase; merge requests at `/pulls`. */
export const RunsPage = () => {
  useLiveStream();
  const page = useAtomValue(pageAtom);
  const run = useAtomValue(runIdAtom);
  const rows = useAtomValue(live.rows);
  const pulls = useAtomValue(live.pulls);
  const failure = useAtomValue(live.failure);
  const [filter, setFilter] = useAtom(statusFilterAtom);
  const groups = useMemo(() => (rows ? groupRuns(rows) : []), [rows]);
  if ('pull' in page) return <PullsView number={page.pull ?? null} />;
  if (!rows) return <Muted>{failure ? `The run list cannot be loaded: ${failure}.` : 'Loading runs.'}</Muted>;
  const active = filters.find(f => f === filter) ?? 'all';
  const shown = groups.filter(g => matches[active](g.phase));
  const open = pulls.filter(p => p.state === 'open').length;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[34rem] shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-3 border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
          {filters.map(f => {
            const count = groups.filter(g => matches[f](g.phase)).length;
            return (
              <button
                key={f}
                type="button"
                aria-pressed={f === active}
                onClick={() => setFilter(f === 'all' ? null : f)}
                className={cx(
                  f === active ? 'font-medium' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
                )}
              >
                {f} {f !== 'all' && count > 0 && <span className="tabular-nums">{count}</span>}
              </button>
            );
          })}
          <span className="ml-auto" />
          <Connection />
          <Link href="/pulls" className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            merge requests{open > 0 && `, ${open} open`}
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!rows.length ? (
            <NoRuns />
          ) : shown.length ? (
            <RunList groups={shown} run={run} />
          ) : (
            <Muted>No {active} runs.</Muted>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {run ? <RunView key={run} id={run} /> : <Muted>Select a run to see it here.</Muted>}
      </div>
    </div>
  );
};
