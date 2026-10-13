import { useAtomValue, useSetAtom } from 'jotai';
import { memo } from 'react';
import { Link as Anchor } from '../Providers.tsx';
import { eventIdAtom, navigateAtom, runIdAtom } from '../state.ts';
import { Icon } from '../studio/icons.tsx';
import { cx, Tooltip } from '../ui.tsx';
import { age, Cost, Elapsed, Io, Running, StatusIcon, useEnter } from './bits.tsx';
import { live, pricesAtom } from './live.ts';
import { costOfRuns, eventTitle, type Group, type JobNode, type Link, triggerGlyph } from './model.ts';

const chip =
  'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1 text-[11px] hover:border-sky-400 dark:hover:border-sky-600';
const chipIdle = 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400';
const chipOn = 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-600 dark:bg-sky-950 dark:text-sky-200';
const chipLive = 'bhm-live-row border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-200';

/** A job and the checks that gate it, each selecting its latest run; `after` puts an arrow in front. */
const Node = ({ job, after, run }: { job: JobNode; after: boolean; run: string | null }) => {
  const select = useSetAtom(runIdAtom);
  const attempts = job.attempts.length;
  const live = job.attempts.find(a => a.status === 'running');
  return (
    <>
      <Tooltip
        tip={`Job ${job.job}${attempts > 1 ? `, ${attempts} attempts` : ''}`}
        action="Show the latest attempt"
        className="shrink-0 items-center gap-1"
      >
        {after && <Icon name="right" className="size-2.5 text-zinc-300 dark:text-zinc-600" />}
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            select(job.attempts.at(-1)!.id);
          }}
          className={cx(
            chip,
            'gap-1.5 bg-white dark:bg-zinc-900',
            job.attempts.some(a => a.id === run) ? chipOn : live ? chipLive : chipIdle
          )}
        >
          <StatusIcon status={job.status} level="job" className="size-3" />
          {job.job}
          {live && <Elapsed startedAt={live.startedAt} className="text-sky-700 dark:text-sky-300" />}
          {attempts > 1 && (
            <span className="inline-flex items-center gap-0.5 text-zinc-500">
              <Icon name="retry" className="size-2.5" />
              {attempts}
            </span>
          )}
        </button>
      </Tooltip>
      {[...job.checks].map(([name, runs]) => (
        <Tooltip
          key={name}
          tip={`Check ${name}${runs.length > 1 ? `, ${runs.length} runs` : ''}`}
          action="Show the latest run"
          className="shrink-0"
        >
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              select(runs.at(-1)!.id);
            }}
            className={cx(
              chip,
              'border-dashed text-[10px] leading-4',
              runs.some(r => r.id === run) ? chipOn : runs.at(-1)!.status === 'running' ? chipLive : chipIdle
            )}
          >
            <StatusIcon status={runs.at(-1)!.status} level="job" kind="check" className="size-2.5" />
            {name}
            {runs.length > 1 && <span className="text-zinc-500 tabular-nums">{runs.length}</span>}
          </button>
        </Tooltip>
      ))}
    </>
  );
};

const LinkChip = ({ link, direction }: { link: Link; direction: 'from' | 'to' }) => {
  const select = useSetAtom(runIdAtom);
  return (
    <Tooltip
      className="shrink-0"
      tip={`${direction === 'from' ? 'Started by' : 'Started'} ${link.label}${link.likely ? ', matched by issue and time' : ''}`}
      action="Show that run"
    >
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          select(link.run);
        }}
        className={cx(chip, 'shrink-0', chipIdle)}
      >
        <Icon name="link" className="size-3" />
        {direction === 'from' ? 'by ' : ''}
        {link.label}
        {link.likely && '?'}
      </button>
    </Tooltip>
  );
};

/** The merge requests an event's runs opened, each a link to its changes. */
const PullChips = ({ event }: { event: string }) => {
  const pulls = useAtomValue(live.pulls).filter(p => p.origin?.event === event);
  return pulls.map(pull => (
    <Tooltip
      key={pull.number}
      className="shrink-0"
      tip={`Merge request #${pull.number}, ${pull.state}: ${pull.title}`}
      action="Show its changes"
    >
      <Anchor
        href={`/dashboard/pulls/${pull.number}`}
        onClick={e => e.stopPropagation()}
        className={cx(chip, 'shrink-0', chipIdle)}
      >
        <Icon name="pull" className="size-3" />#{pull.number}
      </Anchor>
    </Tooltip>
  ));
};

/** The header line of an event: status, trigger, issue, title, actor, links, totals and age. */
export const EventLine = ({ group, links = true }: { group: Group; links?: boolean }) => {
  const prices = useAtomValue(pricesAtom);
  const { event } = group;
  const cost = costOfRuns(group.runs, prices);
  const live = group.runs.filter(r => r.status === 'running');
  const running = live.length;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <StatusIcon
        status={group.status}
        level="event"
        {...(running > 0 && { tip: `${running} ${running === 1 ? 'run' : 'runs'} running for this event` })}
      />
      {running > 1 && <span className="text-xs text-sky-600 dark:text-sky-400">{running}</span>}
      <Tooltip tip={`Triggered by ${event.trigger}${event.action ? ` ${event.action}` : ''}`}>
        <Icon name={triggerGlyph(event)} className="size-3.5 text-zinc-500" />
      </Tooltip>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {event.number !== undefined && <span className="text-zinc-500">#{event.number}</span>}
        <span className="truncate font-medium">{eventTitle(event)}</span>
        <span className="shrink-0 text-xs text-zinc-500">{event.actor.login}</span>
        {links && group.causedBy && <LinkChip link={group.causedBy} direction="from" />}
        {links && group.caused.map(link => <LinkChip key={link.event} link={link} direction="to" />)}
        {links && <PullChips event={event.id} />}
      </span>
      <Io tally={group.tally} className="shrink-0 text-xs" />
      <Cost billed={cost.billed} estimated={cost.estimated} tally={group.tally} className="w-12 justify-end text-xs" />
      {live[0] ? (
        <Running run={live[0]} />
      ) : (
        <Tooltip tip={`Started ${new Date(group.startedAt).toLocaleString()}`} className="w-14 shrink-0 justify-end">
          <span className="text-xs text-zinc-500">{age(group.startedAt)}</span>
        </Tooltip>
      )}
    </div>
  );
};

const chipLimit = 8;

/** The jobs whose chips fit in about two lines, and how many chips are left over. */
const fit = (jobs: JobNode[]) => {
  const chips = (job: JobNode) => 1 + job.checks.size;
  const shown: JobNode[] = [];
  let used = 0;
  for (const job of jobs) {
    if (shown.length && used + chips(job) > chipLimit) break;
    shown.push(job);
    used += chips(job);
  }
  return { shown, more: jobs.reduce((n, job) => n + chips(job), 0) - used };
};

/** A triggering event as one selectable row: its line, then its jobs and checks, each selecting its own run. */
export const GroupRow = memo(function GroupRow({
  group,
  selected,
  run,
}: {
  group: Group;
  selected: boolean;
  run: string | null;
}) {
  const select = useSetAtom(eventIdAtom);
  const enter = useEnter(`event:${group.event.id}`);
  const { shown, more } = fit(group.jobs);
  return (
    <li className={cx('border-b border-zinc-100 dark:border-zinc-900', enter)}>
      <div
        role="button"
        tabIndex={0}
        aria-current={selected || undefined}
        onClick={() => select(group.event.id)}
        onKeyDown={e => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          select(group.event.id);
        }}
        className={cx(
          'cursor-pointer border-l-2 py-1.5 pr-3 pl-2.5',
          selected
            ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
            : 'border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-900'
        )}
      >
        <EventLine group={group} />
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-[2.75rem]">
          {shown.map((job, i) => (
            <Node key={job.key} job={job} after={i > 0} run={run} />
          ))}
          {more > 0 && (
            <Tooltip tip={`${more} more jobs and checks`} action="Show the event with all of them" focusable>
              <span className="text-[11px] text-zinc-500 tabular-nums">+{more}</span>
            </Tooltip>
          )}
        </div>
      </div>
    </li>
  );
});

export const GroupList = ({
  groups,
  event,
  run,
  hidden,
}: {
  groups: Group[];
  event: string | null;
  run: string | null;
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
          selected={group.event.id === event || (run !== null && group.runs.some(r => r.id === run))}
          run={run}
        />
      ))}
    </ul>
  );
};
