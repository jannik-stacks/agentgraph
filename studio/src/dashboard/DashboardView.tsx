import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { RunRow } from '../../../src/live.ts';
import {
  botFilterAtom,
  dashboardPageAtom,
  eventIdAtom,
  infoAtom,
  locationAtom,
  needsHumanQueryAtom,
  runIdAtom,
  runPageAtom,
  runViewAtom,
  runViews,
  sinceFilterAtom,
  sortAtom,
  statusFilterAtom,
} from '../state.ts';
import { Icon } from '../studio/icons.tsx';
import { cx, Muted, RemovableChip, Segmented, Select, Tooltip } from '../ui.tsx';
import { GroupList } from './Groups.tsx';
import { live, pricesAtom, useLiveStream } from './live.ts';
import { costOfRuns, groupRuns, isFailed, isLive } from './model.ts';
import { NeedsHuman } from './NeedsHuman.tsx';
import { ChangesLink, PullsView } from './PullsView.tsx';
import { EventView } from './EventView.tsx';
import { RunView } from './RunView.tsx';
import { SummaryStrip } from './SummaryStrip.tsx';

/** The run follow mode shows: the newest running one, else the newest. */
const latest = (rows: RunRow[] | undefined) => rows?.find(r => r.status === 'running') ?? rows?.[0];

const matches = (run: RunRow, status: string | null, bot: string | null, since: number | undefined) =>
  (!status ||
    (status === 'running' ? isLive(run.status) : status === 'failed' ? isFailed(run.status) : run.status === status)) &&
  (!bot || run.bot === bot) &&
  (since === undefined || new Date(run.startedAt ?? run.event.ts).getTime() >= since);

const BotFilter = ({ bots }: { bots: string[] }) => {
  const [bot, setBot] = useAtom(botFilterAtom);
  return (
    <Select aria-label="bot" value={bot ?? ''} onChange={e => setBot(e.target.value || null)}>
      <option value="">all bots</option>
      {bots.map(b => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </Select>
  );
};

const statusLabels: Record<string, string> = { running: 'running now', failed: 'failed' };

/** The filters in effect, each removable, so a short list never looks like an empty store. */
const Filters = () => {
  const [status, setStatus] = useAtom(statusFilterAtom);
  const [bot, setBot] = useAtom(botFilterAtom);
  const [since, setSince] = useAtom(sinceFilterAtom);
  const [sort, setSort] = useAtom(sortAtom);
  const chips = [
    status && { label: statusLabels[status] ?? status, clear: () => setStatus(null) },
    bot && { label: `bot ${bot}`, clear: () => setBot(null) },
    since && { label: since === 'today' ? 'started today' : `since ${since}`, clear: () => setSince(null) },
    sort && { label: `sorted by ${sort}`, clear: () => setSort(null) },
  ].filter(Boolean) as { label: string; clear: () => void }[];
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3 pt-2">
      {chips.map(chip => (
        <RemovableChip key={chip.label} label={chip.label} onRemove={chip.clear}>
          {chip.label}
        </RemovableChip>
      ))}
    </div>
  );
};

const Runs = ({ rows }: { rows: RunRow[] }) => {
  const status = useAtomValue(statusFilterAtom);
  const bot = useAtomValue(botFilterAtom);
  const since = useAtomValue(sinceFilterAtom);
  const sort = useAtomValue(sortAtom);
  const pulls = useAtomValue(live.pulls);
  const prices = useAtomValue(pricesAtom);
  const run = useAtomValue(runIdAtom);
  const event = useAtomValue(eventIdAtom);
  const { groups, hidden } = useMemo(() => {
    const from = since === 'today' ? new Date().setHours(0, 0, 0, 0) : undefined;
    const shown = rows.filter(run => matches(run, status, bot, from));
    const ids = new Set(shown.map(run => run.event.id));
    const all = groupRuns(rows, pulls).filter(g => ids.has(g.event.id));
    const hidden = rows.length - shown.length;
    if (sort !== 'cost') return { groups: all, hidden };
    const cost = (runs: RunRow[]) => {
      const c = costOfRuns(runs, prices);
      return c.estimated ?? c.billed;
    };
    return { groups: all.toSorted((a, b) => cost(b.runs) - cost(a.runs)), hidden };
  }, [rows, pulls, prices, status, bot, since, sort]);
  const bots = useMemo(() => [...new Set(rows.flatMap(r => (r.bot ? [r.bot] : [])))].sort(), [rows]);
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <NeedsHuman />
        <BotFilter bots={bots} />
      </div>
      <Filters />
      <GroupList groups={groups} event={event} run={run} hidden={hidden} />
    </>
  );
};

const viewTips = {
  pane: 'Open runs in the pane beside the list',
  modal: 'Open runs in a dialog over the list',
};

/** Where a selected run opens, as this viewer prefers it. */
const ViewToggle = () => {
  const [view, setView] = useAtom(runViewAtom);
  return (
    <Segmented
      aria-label="Where runs open"
      options={runViews}
      value={view}
      onChange={setView}
      className="shrink-0 text-xs"
      label={option => (
        <Tooltip tip={viewTips[option]}>
          <span className="inline-flex items-center gap-1">
            <Icon name={option} className="size-3" />
            {option}
          </span>
        </Tooltip>
      )}
    />
  );
};

/** A large dialog over the run list; Escape, a click beside it or its close button calls `onClose`. */
const Modal = ({ onClose, children }: { onClose: () => void; children: ReactNode }) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label="Run"
      onCancel={e => {
        e.preventDefault();
        onClose();
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
      className="m-auto h-[88vh] max-h-none w-[min(72rem,94vw)] max-w-none overflow-hidden rounded-lg border border-zinc-200 bg-white p-0 text-inherit shadow-2xl backdrop:bg-zinc-950/30 dark:border-zinc-800 dark:bg-zinc-950 dark:backdrop:bg-black/50"
    >
      {children}
    </dialog>
  );
};

const noticeFor = 8000;

/** The stream's state when it is not plainly live: reconnecting, failing, or a change it just noticed. */
const Connection = () => {
  const connected = useAtomValue(live.connected);
  const failure = useAtomValue(live.failure);
  const notice = useAtomValue(live.notice);
  const [dismissed, setDismissed] = useState(0);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setDismissed(notice.at), Math.max(0, notice.at + noticeFor - Date.now()));
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <>
      {notice && dismissed !== notice.at && (
        <span
          role="status"
          className="bhm-enter truncate rounded bg-sky-50 px-2 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200"
        >
          {notice.text}
        </span>
      )}
      {!connected && (
        <Tooltip
          className="ml-auto shrink-0"
          tip={
            failure
              ? `Retrying every few seconds: ${failure}`
              : 'The live stream is reconnecting; the list refreshes every few seconds meanwhile'
          }
        >
          <span role="status" className={failure ? 'text-xs text-red-600 dark:text-red-400' : 'text-xs text-amber-600'}>
            {failure ? 'API unreachable' : 'reconnecting'}
          </span>
        </Tooltip>
      )}
    </>
  );
};

/** The page while no run list has arrived: loading, or why it cannot load. */
const Waiting = () => {
  const failure = useAtomValue(live.failure);
  if (!failure) return <Muted>Loading runs.</Muted>;
  return (
    <div role="alert" className="space-y-1 p-4 text-sm">
      <p className="text-red-600 dark:text-red-400">The run list cannot be loaded: {failure}.</p>
      <p className="text-zinc-500">Retrying every few seconds. Check that the studio dev server is running.</p>
    </div>
  );
};

/** The empty run list, naming the data directory it reads so a dashboard on the wrong server is obvious. */
const NoRuns = () => {
  const info = useAtomValue(infoAtom);
  return (
    <div className="space-y-1 p-4 text-sm text-zinc-500">
      <p>
        No runs in {info ? <code className="font-mono">{info.dataReal ?? info.data}</code> : 'this data directory'}.
      </p>
      <p>Run npm run seed in studio/ to add an example run.</p>
    </div>
  );
};

export const DashboardView = () => {
  const page = useAtomValue(dashboardPageAtom);
  const [selected, select] = useAtom(runIdAtom);
  const event = useAtomValue(eventIdAtom);
  const runPage = useAtomValue(runPageAtom);
  const view = useAtomValue(runViewAtom);
  const selectEvent = useSetAtom(eventIdAtom);
  const moved = useAtomValue(locationAtom).query.get('run');
  const rows = useAtomValue(live.rows);
  const refreshNeedsHuman = useSetAtom(needsHumanQueryAtom);
  const shown = 'follow' in page ? latest(rows)?.id : (selected ?? undefined);
  useLiveStream(shown);

  useEffect(() => {
    if (moved) select(moved, true);
  }, [moved, select]);

  const statuses = rows?.map(r => `${r.id}:${r.status}:${r.closure ?? ''}`).join() ?? '';
  useEffect(() => {
    if (statuses) refreshNeedsHuman();
  }, [statuses, refreshNeedsHuman]);

  if ('pulls' in page && page.pulls !== undefined) return <PullsView number={page.pulls} />;
  if (event && runPage) return <EventView key={event} id={event} variant="page" />;
  if ('follow' in page || (selected && runPage))
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 px-3 empty:hidden">
          <Connection />
        </div>
        <div className="min-h-0 flex-1">
          {shown ? (
            <RunView id={shown} variant={'follow' in page ? 'follow' : 'page'} />
          ) : rows ? (
            <Muted>Waiting for a run to start.</Muted>
          ) : (
            <Waiting />
          )}
        </div>
      </div>
    );
  if (!rows) return <Waiting />;
  const modal = view === 'modal';
  const close = () => (selected ? select(null) : selectEvent(null));
  return (
    <div className="grid h-full grid-cols-1 grid-rows-[auto_1fr]">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <SummaryStrip runs={rows} />
        <ChangesLink />
        <Connection />
        <span className="ml-auto" />
        <ViewToggle />
      </div>
      <div className="flex min-h-0">
        <div
          className={cx(
            'overflow-y-auto',
            modal ? 'min-w-0 flex-1' : 'w-[36rem] shrink-0 border-r border-zinc-200 dark:border-zinc-800'
          )}
        >
          {rows.length ? <Runs rows={rows} /> : <NoRuns />}
        </div>
        {modal ? (
          (selected || event) && (
            <Modal onClose={close}>
              {selected ? (
                <RunView id={selected} onClose={close} />
              ) : (
                event && <EventView key={event} id={event} onClose={close} />
              )}
            </Modal>
          )
        ) : (
          <div className="min-w-0 flex-1">
            {selected ? (
              <RunView id={selected} />
            ) : event ? (
              <EventView key={event} id={event} />
            ) : (
              <Muted>Select an event or a run to see it here.</Muted>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
