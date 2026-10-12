import { useAtomValue, useSetAtom } from 'jotai';
import { needsHumanAtom, runIdAtom } from '../state.ts';
import { Badge, Section } from '../ui.tsx';
import { age } from './RunTable.tsx';

export const NeedsHuman = () => {
  const items = useAtomValue(needsHumanAtom);
  const select = useSetAtom(runIdAtom);
  if (!items) return null;
  return (
    <Section title={`needs a human (${items.length})`}>
      {items.length ? (
        <ul className="space-y-1">
          {items.map(({ run, reason, questions }) => (
            <li key={run.id}>
              <button
                onClick={() => select(run.id)}
                className="w-full rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
              >
                <div className="flex items-center gap-2">
                  <Badge tone={reason === 'asked' ? 'warn' : 'danger'}>{reason}</Badge>
                  <span className="truncate">
                    {run.workflow} / {run.job}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-zinc-500">{age(run.endedAt ?? run.event.ts)}</span>
                </div>
                <div className="truncate text-xs text-zinc-500">{questions[0] ?? run.error ?? run.status}</div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 text-zinc-500">Nothing is waiting.</p>
      )}
    </Section>
  );
};
