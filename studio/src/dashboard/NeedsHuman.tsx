import { useAtomValue, useSetAtom } from 'jotai';
import { needsHumanAtom, runIdAtom } from '../state.ts';
import { Icon } from '../studio/icons.tsx';
import { Badge, cx, Disclosure, Tooltip } from '../ui.tsx';
import { age } from './bits.tsx';

/** Runs waiting on a human, folded behind their count. */
export const NeedsHuman = () => {
  const items = useAtomValue(needsHumanAtom);
  const select = useSetAtom(runIdAtom);
  if (!items) return <span />;
  return (
    <Disclosure
      className="min-w-0 flex-1 text-xs"
      summaryClassName={cx(
        'inline-flex gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-900',
        items.length ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'
      )}
      summary={
        <Tooltip
          tip={`${items.length} ${items.length === 1 ? 'run needs' : 'runs need'} a human: a question to answer or a failure to look at\nClick to list them`}
        >
          <span className="inline-flex items-center gap-1">
            <Icon name="question" className="size-3.5" />
            {items.length}
          </span>
        </Tooltip>
      }
    >
      <ul className="mt-1 space-y-0.5">
        {items.map(({ run, reason, questions }) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => select(run.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-0.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-900"
            >
              <Badge tone={reason === 'failed' ? 'danger' : 'warn'}>{reason}</Badge>
              <span className="shrink-0">
                {run.workflow} / {run.job}
              </span>
              <span className="min-w-0 truncate text-zinc-500">{questions[0] ?? run.error ?? run.status}</span>
              <span className="ml-auto shrink-0 text-zinc-500">{age(run.endedAt ?? run.event.ts)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
};
