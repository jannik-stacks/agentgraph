import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import type { Run } from '../../../src/store.ts';
import { botFilterAtom, needsHumanQueryAtom, runIdAtom, runsAtom, runsQueryAtom, statusFilterAtom } from '../state.ts';
import { Muted } from '../ui.tsx';
import { NeedsHuman } from './NeedsHuman.tsx';
import { RunDetail } from './RunDetail.tsx';
import { RunTable } from './RunTable.tsx';
import { Tiles } from './Tiles.tsx';

const Filter = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  onChange: (value: string | null) => void;
}) => (
  <label className="flex items-center gap-1.5 text-xs text-zinc-500">
    {label}
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      className="rounded border border-zinc-200 bg-transparent px-1.5 py-0.5 text-sm text-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
    >
      <option value="">all</option>
      {options.map(option => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  </label>
);

const unique = (values: (string | undefined)[]) => [...new Set(values.filter(v => v !== undefined))].sort();

const Runs = ({ runs }: { runs: Run[] }) => {
  const [status, setStatus] = useAtom(statusFilterAtom);
  const [bot, setBot] = useAtom(botFilterAtom);
  const [selected, select] = useAtom(runIdAtom);
  const shown = runs.filter(run => (!status || run.status === status) && (!bot || run.persona === bot));
  return (
    <>
      <div className="flex gap-3 px-3 py-2">
        <Filter label="status" value={status} options={unique(runs.map(r => r.status))} onChange={setStatus} />
        <Filter label="bot" value={bot} options={unique(runs.map(r => r.persona))} onChange={setBot} />
      </div>
      {shown.length ? <RunTable runs={shown} selected={selected} onSelect={select} /> : <Muted>No runs match.</Muted>}
    </>
  );
};

export const DashboardView = () => {
  const runs = useAtomValue(runsAtom);
  const selected = useAtomValue(runIdAtom);
  const refreshRuns = useSetAtom(runsQueryAtom);
  const refreshNeedsHuman = useSetAtom(needsHumanQueryAtom);

  useEffect(() => {
    const timer = setInterval(() => {
      refreshRuns();
      refreshNeedsHuman();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshRuns, refreshNeedsHuman]);

  if (!runs) return <Muted>Loading runs.</Muted>;
  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
        <Tiles runs={runs} />
      </div>
      <div className="flex min-h-0">
        <div className="w-[30rem] shrink-0 space-y-4 overflow-y-auto border-r border-zinc-200 py-3 dark:border-zinc-800">
          <div className="px-3">
            <NeedsHuman />
          </div>
          {runs.length ? (
            <Runs runs={runs} />
          ) : (
            <Muted>No runs yet. Run npm run seed in studio/ to add an example run.</Muted>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? <RunDetail key={selected} id={selected} /> : <Muted>Select a run to see its events.</Muted>}
        </div>
      </div>
    </div>
  );
};
