import { useAtomValue } from 'jotai';
import { findRunsWaitingOnPeople, formatNextSteps } from '../../../src/status.ts';
import { runsAtom } from '../state.ts';
import { Loading, Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';

const {
  VITE_AGI_INSTANCE: instance,
  VITE_AGI_HUB: hub,
  VITE_AGI_DATA: data,
} = import.meta.env as Record<string, string | undefined>;
const where = instance
  ? { again: `--instance ${instance}`, forge: `${instance}/forge` }
  : { again: `--hub ${hub ?? '<hub>'} --data ${data ?? '<data>'}` };

export const InboxPage = () => {
  const { value: runs, failure } = useAtomValue(runsAtom);
  if (!runs) return failure ? <Muted>{failure}</Muted> : <Loading />;
  const waiting = findRunsWaitingOnPeople(runs.map(r => r.run)).map(run => runs.find(r => r.run === run)!);
  if (!waiting.length) return <Muted>Nothing waits for you.</Muted>;
  return (
    <div className="h-full overflow-y-auto p-4">
      <Rows
        rows={waiting.map(r => ({
          ...runRow(r),
          open: true,
          children: [],
          body: (
            <pre className="py-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
              {[r.run.reason, ...formatNextSteps(r.run, { ...where, repo: r.repo }).slice(1)]
                .filter(Boolean)
                .join('\n')}
            </pre>
          ),
        }))}
      />
    </div>
  );
};
