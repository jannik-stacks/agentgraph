import { useAtomValue, useSetAtom } from 'jotai';
import { type ReactNode, Suspense, use, useMemo } from 'react';
import type { RunRow } from '../../../src/live.ts';
import { sum } from '../../../src/usage.ts';
import { eventIdAtom, runIdAtom, runPageAtom } from '../state.ts';
import { Icon, KindIcon } from '../studio/icons.tsx';
import { cx, IconButton, Muted } from '../ui.tsx';
import { Cost, Elapsed, Io, LastActivity, paneHeader, Running, StatusIcon } from './bits.tsx';
import { EventLine, EventLinks } from './Groups.tsx';
import { fetchOutcome, live, pricesAtom } from './live.ts';
import { checksOf, costOfRuns, groupRuns, isLive, type JobNode } from './model.ts';
import { FindingsLine, Text, VerdictView } from './render/index.tsx';

/**
 * One line in the right pane's lists: a status, a name and what else it needs, and the totals of its runs. `after`
 * ends the name's part of the line; a running run adds a second line with what it did last.
 */
const Line = ({
  icon,
  label,
  note,
  after,
  runs,
  depth,
  onSelect,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  note?: ReactNode;
  after?: ReactNode;
  runs: RunRow[];
  depth: number;
  onSelect?: (() => void) | undefined;
  children?: ReactNode;
}) => {
  const prices = useAtomValue(pricesAtom);
  const cost = costOfRuns(runs, prices);
  const one = runs.length === 1 ? runs[0] : undefined;
  const running = one && isLive(one.status) ? one : undefined;
  const body = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="shrink-0 truncate">{label}</span>
        {note && <span className="shrink-0 truncate text-zinc-500">{note}</span>}
        {after}
      </span>
      {runs.length > 0 && (
        <span className="flex shrink-0 items-center gap-3">
          {running ? (
            <Running run={running} />
          ) : (
            one && <Elapsed startedAt={one.startedAt} endedAt={one.endedAt ?? one.startedAt} />
          )}
          <Io tally={sum(runs.map(r => r.tally))} />
          <Cost billed={cost.billed} estimated={cost.estimated} className="w-12 justify-end" />
        </span>
      )}
    </>
  );
  const row = 'flex w-full min-w-0 items-center gap-2 rounded py-1 pr-2 text-left text-xs';
  const indent = { paddingLeft: `${0.5 + depth * 1.25}rem` };
  return (
    <li className={cx(running && 'bhm-live-row rounded')}>
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          className={cx(row, 'hover:bg-zinc-50 dark:hover:bg-zinc-900')}
          style={indent}
        >
          {body}
        </button>
      ) : (
        <div className={row} style={indent}>
          {body}
        </div>
      )}
      {running && (
        <div className="flex min-w-0 pr-2 pb-1 text-xs" style={{ paddingLeft: `${1.875 + depth * 1.25}rem` }}>
          <LastActivity activity={running.activity} className="flex-1" />
        </div>
      )}
      {children && (
        <div className="pr-2 pb-1 empty:hidden" style={{ paddingLeft: `${1.875 + depth * 1.25}rem` }}>
          {children}
        </div>
      )}
    </li>
  );
};

/**
 * The findings of check `name` on `attempt`, fetched with the attempt's outcome: with `line`, the end of the check's row
 * when they fit on it; else the block under the row when they do not.
 */
export const FetchedFindings = ({ attempt, name, line = false }: { attempt: RunRow; name: string; line?: boolean }) => {
  const verdict = use(fetchOutcome(attempt.id, attempt.status))?.checks?.find(v => v.check === name);
  if (!verdict) return null;
  return line ? <FindingsLine verdict={verdict} /> : <VerdictView verdict={verdict} />;
};

/** The verdict of check `name` on `attempt` as an icon in its status and tone, with what it means as the tip. */
export const VerdictIcon = ({ attempt, name, runs }: { attempt: RunRow; name: string; runs: RunRow[] }) => {
  const brief = attempt.brief?.checks?.find(v => v.check === name);
  const last = runs.at(-1);
  if (brief && !(last && isLive(last.status)))
    return (
      <StatusIcon
        kind="check"
        status={brief.skipped ? 'skipped' : brief.pass ? 'succeeded' : 'failed'}
        {...(!brief.pass && !brief.skipped && !brief.gating && { tone: 'warn' })}
        tip={
          brief.skipped
            ? `Check ${name} skipped`
            : brief.pass
              ? `Check ${name} passed`
              : brief.gating
                ? `Check ${name} failed and blocked the attempt`
                : `Check ${name} failed; log checks only report`
        }
      />
    );
  if (last) return <StatusIcon kind="check" status={last.status} level="job" tip={`Check ${name}, ${last.status}`} />;
  return <KindIcon kind="check" />;
};

/**
 * The checks that judged `attempt`, one line each with the totals of all its runs. A check that ran a bot selects its
 * latest run; a check that ran none shows its findings in place.
 */
export const CheckLines = ({ attempt, rows, depth }: { attempt: RunRow; rows: RunRow[]; depth: number }) => {
  const select = useSetAtom(runIdAtom);
  const checks = checksOf(attempt, rows);
  for (const verdict of attempt.brief?.checks ?? []) if (!checks.has(verdict.check)) checks.set(verdict.check, []);
  return [...checks].map(([name, runs]) => {
    const gating = attempt.brief?.checks?.find(v => v.check === name)?.gating;
    return (
      <Line
        key={name}
        icon={<VerdictIcon attempt={attempt} name={name} runs={runs} />}
        label={name}
        note={[gating === false && 'log', runs.length > 1 && `${runs.length} runs`].filter(Boolean).join(', ')}
        after={
          !runs.length && (
            <Suspense fallback={null}>
              <FetchedFindings attempt={attempt} name={name} line />
            </Suspense>
          )
        }
        runs={runs}
        depth={depth}
        onSelect={runs.length ? () => select(runs.at(-1)!.id) : undefined}
      >
        {!runs.length && (
          <Suspense fallback={null}>
            <FetchedFindings attempt={attempt} name={name} />
          </Suspense>
        )}
      </Line>
    );
  });
};

/** A job: its attempts, each followed by the checks that judged it. One attempt stands for the job itself. */
const JobLines = ({ job, rows }: { job: JobNode; rows: RunRow[] }) => {
  const select = useSetAtom(runIdAtom);
  const many = job.attempts.length > 1;
  const attempts = job.attempts.map((attempt, i) => (
    <Line
      key={attempt.id}
      icon={<StatusIcon status={attempt.status} level="job" />}
      label={many ? `attempt ${i + 1}` : job.job}
      note={attempt.bot}
      runs={[attempt]}
      depth={many ? 1 : 0}
      onSelect={() => select(attempt.id)}
    />
  ));
  return (
    <>
      {many && (
        <Line
          icon={<StatusIcon status={job.status} level="job" />}
          label={job.job}
          note={`${job.attempts.length} attempts`}
          runs={job.attempts}
          depth={0}
          onSelect={() => select(job.attempts.at(-1)!.id)}
        />
      )}
      {job.attempts.flatMap((attempt, i) => [
        attempts[i],
        <CheckLines key={`${attempt.id}:checks`} attempt={attempt} rows={rows} depth={many ? 2 : 1} />,
      ])}
    </>
  );
};

/** One triggering event: what started it, then every job it started, their attempts and the checks that judged them. */
export const EventView = ({
  id,
  variant = 'panel',
  onClose,
}: {
  id: string;
  variant?: 'panel' | 'page';
  onClose?: (() => void) | undefined;
}) => {
  const rows = useAtomValue(live.rows);
  const pulls = useAtomValue(live.pulls);
  const setRunPage = useSetAtom(runPageAtom);
  const selectEvent = useSetAtom(eventIdAtom);
  const group = useMemo(() => rows && groupRuns(rows, pulls).find(g => g.event.id === id), [rows, pulls, id]);
  if (!rows) return <div className="min-h-96" />;
  if (!group)
    return (
      <Muted>
        No runs for event <code className="font-mono">{id}</code>.{' '}
        <button type="button" className="underline" onClick={() => selectEvent(null)}>
          Back to the run list
        </button>
      </Muted>
    );
  const body = group.event.body?.trim();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={paneHeader}>
        {variant === 'page' && (
          <IconButton tip="Back to the run list" onClick={() => setRunPage(false)}>
            <Icon name="left" className="size-3" />
          </IconButton>
        )}
        <EventLine group={group} />
        {variant === 'panel' && (
          <IconButton tip="Open this event on its own page" onClick={() => setRunPage(true)}>
            <Icon name="open" className="size-3" />
          </IconButton>
        )}
        {onClose && (
          <IconButton tip="Close" keys="Esc" onClick={onClose}>
            <Icon name="close" className="size-3" />
          </IconButton>
        )}
      </header>
      <div className="bhm-scroll-fade min-h-0 flex-1 overflow-y-auto py-1">
        <div className="mx-3 mt-1 flex flex-wrap items-center gap-1 empty:hidden">
          <EventLinks group={group} />
        </div>
        {body && (
          <div className="bhm-scroll-fade mx-3 my-2 max-h-48 overflow-y-auto border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
            <Text text={body} />
          </div>
        )}
        <ul>
          {group.jobs.map(job => (
            <JobLines key={job.key} job={job} rows={rows} />
          ))}
        </ul>
      </div>
    </div>
  );
};
