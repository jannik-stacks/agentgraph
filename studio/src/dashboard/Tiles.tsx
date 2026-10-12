import type { Run } from '../../../src/store.ts';
import { cx } from '../ui.tsx';

const day = 24 * 60 * 60 * 1000;
const time = (iso: string | undefined) => (iso ? new Date(iso).getTime() : 0);

export const summarize = (runs: Run[], now = new Date()) => {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const today = runs.filter(run => time(run.startedAt ?? run.event.ts) >= midnight);
  return {
    active: runs.filter(run => run.status === 'running').length,
    queued: runs.filter(run => run.status === 'queued').length,
    today: today.length,
    costToday: today.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    failures: runs.filter(
      run =>
        (run.status === 'failed' || run.status === 'timed-out') &&
        time(run.endedAt ?? run.startedAt ?? run.event.ts) >= now.getTime() - day
    ).length,
  };
};

const Tile = ({ label, value, alert }: { label: string; value: string | number; alert?: boolean }) => (
  <div className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
    <div className="text-xs text-zinc-500">{label}</div>
    <div className={cx('text-lg font-semibold tabular-nums', alert && 'text-red-600 dark:text-red-400')}>{value}</div>
  </div>
);

export const Tiles = ({ runs }: { runs: Run[] }) => {
  const s = summarize(runs);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Tile label="active" value={s.active} />
      <Tile label="queued" value={s.queued} />
      <Tile label="runs today" value={s.today} />
      <Tile label="cost today" value={`$${s.costToday.toFixed(2)}`} />
      <Tile label="failures, 24h" value={s.failures} alert={s.failures > 0} />
    </div>
  );
};
