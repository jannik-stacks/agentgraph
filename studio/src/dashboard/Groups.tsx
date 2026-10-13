import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Fragment, memo, useState } from 'react';
import type { RunRow } from '../../../src/live.ts';
import { navigateAtom, runIdAtom } from '../state.ts';
import { Icon } from '../studio/icons.tsx';
import { cx, Tooltip } from '../ui.tsx';
import { age, Cost, Elapsed, Io, StatusIcon, useEnter } from './bits.tsx';
import { pricesAtom } from './live.ts';
import { costOf, costOfRuns, eventTitle, type Group, isLive, type JobNode, type Link, triggerGlyph } from './model.ts';

/**
 * One run on one line: status, job or check, the bot when it is not the job's own, attempt, tokens, cost, duration
 * and age. The group above already names the event and workflow.
 */
const RunLine = memo(function RunLine({ run, job }: { run: RunRow; job: JobNode }) {
  const prices = useAtomValue(pricesAtom);
  const [selected, select] = useAtom(runIdAtom);
  const enter = useEnter(`run:${run.id}`);
  const cost = costOf(run.tally, run.model, prices);
  const attempts = job.attempts.length;
  return (
    <li className={enter}>
      <button
        type="button"
        onClick={() => select(run.id)}
        className={cx(
          'grid w-full grid-cols-[1rem_minmax(0,1fr)_auto_3.5rem_3rem_3.5rem] items-center gap-2 py-1 pr-3 pl-8 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900',
          run.id === selected ? 'bg-sky-50 dark:bg-sky-950/40' : run.status === 'running' && 'bhm-live-row'
        )}
      >
        <StatusIcon
          status={run.status}
          {...(run.check && {
            kind: 'check' as const,
            tip: `Check ${run.check}, ${run.status}, judging attempt ${job.attempts.findIndex(a => a.id === run.parent) + 1 || 1}`,
          })}
        />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{run.check ?? run.job}</span>
          {run.bot !== job.attempts[0]?.bot && <span className="truncate text-zinc-500">{run.bot}</span>}
          {attempts > 1 && !run.check && (
            <Tooltip tip={`Attempt ${run.attempt ?? 1} of ${attempts}`}>
              <span className="text-zinc-500">
                {run.attempt ?? 1}/{attempts}
              </span>
            </Tooltip>
          )}
        </span>
        <Io tally={run.tally} />
        <Cost billed={cost.billed} estimated={cost.estimated} tally={run.tally} className="justify-end" />
        <span className="text-right">
          <Elapsed
            startedAt={run.startedAt}
            endedAt={run.endedAt ?? (isLive(run.status) ? undefined : run.startedAt)}
          />
        </span>
        <Tooltip tip={`Started ${new Date(run.startedAt ?? run.event.ts).toLocaleString()}`} className="justify-end">
          <span className="text-zinc-500">{age(run.startedAt ?? run.event.ts)}</span>
        </Tooltip>
      </button>
    </li>
  );
});

const Node = ({ job, onSelect }: { job: JobNode; onSelect: (id: string) => void }) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    <Tooltip
      tip={`Job ${job.job}${job.attempts.length > 1 ? `, ${job.attempts.length} attempts` : ''}; opens the latest attempt`}
    >
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          onSelect(job.attempts.at(-1)!.id);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-1.5 text-[11px] leading-5 hover:border-sky-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-sky-600"
      >
        <StatusIcon status={job.status} level="job" className="size-3" />
        {job.job}
        {job.attempts.length > 1 && (
          <span className="inline-flex items-center gap-0.5 text-zinc-500">
            <Icon name="retry" className="size-2.5" />
            {job.attempts.length}
          </span>
        )}
      </button>
    </Tooltip>
    {[...job.checks].map(([name, runs]) => (
      <Tooltip key={name} tip={`Check ${name}${runs.length > 1 ? `, ${runs.length} runs` : ''}; opens the latest`}>
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onSelect(runs.at(-1)!.id);
          }}
          className="inline-flex items-center gap-1 rounded border border-dashed border-zinc-200 px-1 text-[10px] leading-4 text-zinc-600 hover:border-sky-400 dark:border-zinc-700 dark:text-zinc-400"
        >
          <StatusIcon status={runs.at(-1)!.status} level="job" kind="check" className="size-2.5" />
          {name}
          {runs.length > 1 && <span className="text-zinc-500">{runs.length}</span>}
        </button>
      </Tooltip>
    ))}
  </span>
);

/** The jobs an event started, left to right in the order they started, each followed by the checks that gate it. */
const JobGraph = ({ jobs }: { jobs: JobNode[] }) => {
  const select = useSetAtom(runIdAtom);
  return (
    <div className="flex flex-wrap items-center gap-1 pb-1.5 pl-8">
      {jobs.map((job, i) => (
        <Fragment key={job.key}>
          {i > 0 && <Icon name="chevron" className="size-3 text-zinc-400" />}
          <Node job={job} onSelect={select} />
        </Fragment>
      ))}
    </div>
  );
};

const LinkChip = ({ link, direction }: { link: Link; direction: 'from' | 'to' }) => {
  const select = useSetAtom(runIdAtom);
  return (
    <Tooltip
      tip={`${direction === 'from' ? 'Started by' : 'Started'} ${link.label}${link.likely ? ', matched by issue and time' : ''}; opens that run`}
    >
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          select(link.run);
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-zinc-200 px-1 text-[11px] text-zinc-600 hover:border-sky-400 dark:border-zinc-700 dark:text-zinc-400"
      >
        <Icon name="link" className="size-3" />
        {direction === 'from' ? 'by ' : ''}
        {link.label}
        {link.likely && '?'}
      </button>
    </Tooltip>
  );
};

/**
 * A triggering event: what, where, who and when, its totals and its links, with its jobs as a small graph below.
 * Expanded, it lists every run.
 */
export const GroupRow = memo(function GroupRow({ group, open: initiallyOpen }: { group: Group; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const prices = useAtomValue(pricesAtom);
  const enter = useEnter(`event:${group.event.id}`);
  const { event } = group;
  const cost = costOfRuns(group.runs, prices);
  const running = group.runs.filter(r => r.status === 'running').length;
  return (
    <li className={cx('border-b border-zinc-100 dark:border-zinc-900', enter)}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={e => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          setOpen(!open);
        }}
        className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
      >
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Icon name="chevron" className={cx('size-3 text-zinc-400 transition-transform', open && 'rotate-90')} />
          <StatusIcon
            status={group.status}
            level="event"
            {...(running > 0 && { tip: `${running} ${running === 1 ? 'run' : 'runs'} running for this event` })}
          />
          {running > 1 && <span className="text-xs text-sky-600 dark:text-sky-400">{running}</span>}
          <Tooltip tip={`Triggered by ${event.trigger}${event.action ? ` ${event.action}` : ''}`}>
            <Icon name={triggerGlyph(event)} className="size-3.5 text-zinc-500" />
          </Tooltip>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {event.number !== undefined && <span className="text-zinc-500">#{event.number}</span>}
            <span className="truncate font-medium">{eventTitle(event)}</span>
            <span className="shrink-0 text-xs text-zinc-500">{event.actor.login}</span>
            {group.causedBy && <LinkChip link={group.causedBy} direction="from" />}
            {group.caused.map(link => (
              <LinkChip key={link.event} link={link} direction="to" />
            ))}
          </span>
          <Io tally={group.tally} className="text-xs" />
          <Cost
            billed={cost.billed}
            estimated={cost.estimated}
            tally={group.tally}
            className="w-14 justify-end text-xs"
          />
          <Tooltip tip={`Started ${new Date(group.startedAt).toLocaleString()}`} className="w-14 justify-end">
            <span className="text-xs text-zinc-500">{age(group.startedAt)}</span>
          </Tooltip>
        </div>
        <JobGraph jobs={group.jobs} />
      </div>
      {open && (
        <ul className="pb-1">
          {group.jobs.flatMap(job =>
            [...job.attempts, ...[...job.checks.values()].flat()]
              .toSorted((a, b) => (a.id < b.id ? -1 : 1))
              .map(run => <RunLine key={run.id} run={run} job={job} />)
          )}
        </ul>
      )}
    </li>
  );
});

export const GroupList = ({
  groups,
  selected,
  hidden,
}: {
  groups: Group[];
  selected: string | null;
  hidden: number;
}) => {
  const navigate = useSetAtom(navigateAtom);
  if (!groups.length)
    return (
      <p className="p-4 text-zinc-500">
        {hidden} {hidden === 1 ? 'run is' : 'runs are'} hidden by filters.{' '}
        <button
          type="button"
          className="underline"
          onClick={() => navigate({ query: { status: null, bot: null, since: null } })}
        >
          Clear filters
        </button>
      </p>
    );
  return (
    <ul>
      {groups.map(group => (
        <GroupRow
          key={group.event.id}
          group={group}
          open={selected !== null && group.runs.some(r => r.id === selected)}
        />
      ))}
    </ul>
  );
};
