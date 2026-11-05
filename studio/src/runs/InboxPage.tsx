import { useAtomValue } from 'jotai';
import { isOnIssue } from '../../../src/graph.ts';
import { findRunsWaitingOnPeople, formatNextSteps } from '../../../src/status.ts';
import { runsAtom, shown } from '../state.ts';
import type { ServedRun } from './trace.ts';
import { Live, Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';

const local = !!shown?.local;
const flags = shown?.name ? ` --instance ${shown.name}` : '';

export const InboxPage = () => <Live state={useAtomValue(runsAtom)}>{runs => <Inbox runs={runs} />}</Live>;

const Inbox = ({ runs }: { runs: ServedRun[] }) => {
  const waiting = findRunsWaitingOnPeople(runs.map(r => r.run).filter(isOnIssue)).map(run => ({
    ...runs.find(r => r.run === run)!,
    run,
  }));
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
              {[r.run.reason, ...formatNextSteps(r.run, local ? undefined : r.repo || '<owner>/<repo>', flags).slice(1)]
                .filter(Boolean)
                .join('\n')}
            </pre>
          ),
        }))}
      />
    </div>
  );
};
