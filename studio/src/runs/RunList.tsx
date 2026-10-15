import { useAtomValue, useSetAtom } from 'jotai';
import { memo } from 'react';
import { runIdAtom } from '../state.ts';
import { cx, Link } from '../ui.tsx';
import { age, PhaseWord } from './bits.tsx';
import { live } from './live.ts';
import { eventTitle, type Group, type JobNode } from './model.ts';

const chip = 'inline-flex h-5 shrink-0 items-center gap-1.5 rounded border px-1.5 text-[11px]';

/** A job, selecting its latest attempt; its phase shows when it is not done. */
const JobChip = ({ job, current }: { job: JobNode; current: boolean }) => {
  const select = useSetAtom(runIdAtom);
  const last = job.attempts.at(-1)!;
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        select(last.id);
      }}
      className={cx(
        chip,
        current
          ? 'border-zinc-500 text-zinc-900 dark:border-zinc-400 dark:text-zinc-100'
          : 'border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400'
      )}
    >
      {job.job}
      {job.attempts.length > 1 && <span className="text-zinc-500">try {job.attempts.length}</span>}
      {job.phase !== 'done' && <PhaseWord phase={job.phase} status={last.status} className="text-[11px]" />}
    </button>
  );
};

/** The merge requests an event's runs opened. */
const PullChips = ({ event }: { event: string }) =>
  useAtomValue(live.pulls)
    .filter(p => p.origin?.event === event)
    .map(pull => (
      <Link
        key={pull.number}
        href={`/pulls/${pull.number}`}
        onClick={e => e.stopPropagation()}
        className={cx(
          chip,
          'border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400'
        )}
      >
        merge request #{pull.number}
      </Link>
    ));

/** A triggering event as one row: its phase, issue and title, then its jobs. */
const GroupRow = memo(function GroupRow({ group, run }: { group: Group; run: string | null }) {
  const select = useSetAtom(runIdAtom);
  const { event } = group;
  const selected = group.runs.some(r => r.id === run);
  const open = () => select(group.jobs.at(-1)?.attempts.at(-1)?.id ?? group.runs.at(-1)!.id);
  return (
    <li className="border-b border-zinc-100 dark:border-zinc-900">
      <div
        role="button"
        tabIndex={0}
        aria-current={selected || undefined}
        onClick={open}
        onKeyDown={e => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          open();
        }}
        className={cx(
          'cursor-pointer px-3 py-1.5',
          selected ? 'bg-zinc-100 dark:bg-zinc-900' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/50'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {event.number !== undefined && <span className="shrink-0 text-zinc-500">#{event.number}</span>}
          <span className="truncate font-medium">{eventTitle(event)}</span>
          <span className="shrink-0 text-xs text-zinc-500">{event.trigger}</span>
          <span className="ml-auto" />
          <PhaseWord phase={group.phase} />
          <span className="w-16 shrink-0 text-right text-xs text-zinc-500">{age(group.startedAt)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <PullChips event={event.id} />
          {group.jobs.map(job => (
            <JobChip key={job.key} job={job} current={job.attempts.some(a => a.id === run)} />
          ))}
        </div>
      </div>
    </li>
  );
});

export const RunList = ({ groups, run }: { groups: Group[]; run: string | null }) => (
  <ul>
    {groups.map(group => (
      <GroupRow key={group.event.id} group={group} run={run} />
    ))}
  </ul>
);
