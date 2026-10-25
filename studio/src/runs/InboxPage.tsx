import { useAtomValue } from 'jotai';
import { runsAtom } from '../state.ts';
import { Loading, Muted } from '../ui.tsx';
import { Rows, runRow, statusTip } from './rows.tsx';
import type { ServedRun } from './trace.ts';

const findRunsWaitingOnPeople = (runs: ServedRun[]) =>
  runs
    .filter(
      ({ run }) =>
        run.status === 'waiting' && !runs.some(c => c.run.by === run.id && run.reason === `waiting on ${c.run.id}`)
    )
    .toSorted((a, b) => b.run.started.localeCompare(a.run.started));

export const InboxPage = () => {
  const { value: runs, failure } = useAtomValue(runsAtom);
  if (!runs) return failure ? <Muted>{failure}</Muted> : <Loading />;
  const waiting = findRunsWaitingOnPeople(runs);
  if (!waiting.length) return <Muted>Nothing waits for you.</Muted>;
  return (
    <div className="h-full overflow-y-auto p-4">
      <Rows
        rows={waiting.map(r => ({
          ...runRow(r),
          open: true,
          children: [],
          body: (
            <p className="max-w-4xl py-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{statusTip(r.run)}</p>
          ),
        }))}
      />
    </div>
  );
};
