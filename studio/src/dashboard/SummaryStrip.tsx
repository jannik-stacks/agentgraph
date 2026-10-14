import { useAtom, useAtomValue } from 'jotai';
import type { ReactNode } from 'react';
import type { RunRow } from '../../../src/live.ts';
import { sum } from '../../../src/usage.ts';
import { sinceFilterAtom, sortAtom, statusFilterAtom } from '../state.ts';
import { Icon } from '../studio/icons.tsx';
import { cx, Tooltip } from '../ui.tsx';
import { age, Amount, Dot, formatUsd, Num } from './bits.tsx';
import { pricesAtom } from './live.ts';
import { costOfRuns, isFailed, isLive, type Prices } from './model.ts';

const hour = 3_600_000;
const startOf = (run: RunRow) => new Date(run.startedAt ?? run.event.ts).getTime();
const percent = (n: number) => `${Math.round(n)}%`;
const count = (n: number) => String(Math.round(n));

export const summarize = (runs: RunRow[], prices: Prices, now = Date.now()) => {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const today = runs.filter(run => startOf(run) >= midnight);
  const finished = today.filter(run => !isLive(run.status));
  const passed = finished.filter(run => run.status === 'succeeded').length;
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const from = now - (24 - i) * hour;
    const slot = runs.filter(run => startOf(run) >= from && startOf(run) < from + hour);
    const cost = costOfRuns(slot, prices);
    return cost.estimated ?? cost.billed;
  });
  const last = runs.reduce((at, run) => Math.max(at, startOf(run)), 0);
  return {
    last: last || undefined,
    live: runs.filter(run => isLive(run.status)).length,
    today: today.length,
    passRate: finished.length ? (passed / finished.length) * 100 : undefined,
    failures: finished.filter(run => isFailed(run.status)).length,
    tally: sum(today.map(run => run.tally)),
    cost: costOfRuns(today, prices),
    hourly,
  };
};

const Spark = ({ values }: { values: number[] }) => {
  const max = Math.max(...values, 0);
  if (!max) return null;
  return (
    <svg viewBox="0 0 48 12" className="h-3 w-12" aria-hidden="true">
      {values.map((v, i) => (
        <rect
          key={i}
          x={i * 2}
          y={12 - (v / max) * 12}
          width="1.5"
          height={(v / max) * 12}
          className="fill-sky-400/70"
        />
      ))}
    </svg>
  );
};

const Stat = ({
  on,
  tip,
  onClick,
  children,
}: {
  on: boolean;
  tip: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Tooltip tip={tip} action={on ? 'Clear the filter' : 'Filter the list'}>
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 tabular-nums transition-colors',
        on ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
      )}
    >
      {children}
    </button>
  </Tooltip>
);

const runs = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'run' : 'runs'}`;
const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1 ? 2 : 4 });

/** One line of live totals; each one filters or sorts the list below. */
export const SummaryStrip = ({ runs: rows }: { runs: RunRow[] }) => {
  const prices = useAtomValue(pricesAtom);
  const [status, setStatus] = useAtom(statusFilterAtom);
  const [since, setSince] = useAtom(sinceFilterAtom);
  const [sort, setSort] = useAtom(sortAtom);
  const s = summarize(rows, prices);
  const estimated = s.cost.estimated ?? 0;
  const toggle = (value: string | null, current: string | null, set: (v: string | null) => void) =>
    set(current === value ? null : value);
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      <span className="text-zinc-400 dark:text-zinc-500">now</span>
      <Stat
        on={status === 'running'}
        tip={`${runs(s.live)} running or queued now`}
        onClick={() => toggle('running', status, setStatus)}
      >
        <Dot tone={s.live > 0 ? 'info' : 'neutral'} pulse={s.live > 0} />
        <Num value={s.live} format={count} />
      </Stat>
      <span className="pl-2 text-zinc-400 dark:text-zinc-500">today</span>
      <Stat on={since === 'today'} tip={`${runs(s.today)} today`} onClick={() => toggle('today', since, setSince)}>
        <Icon name="schedule" className="size-3.5" />
        <Num value={s.today} format={count} />
      </Stat>
      <Stat
        on={status === 'failed'}
        tip={
          s.passRate === undefined
            ? 'No finished runs today'
            : `${Math.round(s.passRate)}% of finished runs today passed their checks; ${runs(s.failures)} failed`
        }
        onClick={() => toggle('failed', status, setStatus)}
      >
        <Icon
          name={s.failures ? 'fail' : 'ok'}
          className={cx('size-3.5', s.failures ? 'text-red-500' : 'text-emerald-500')}
        />
        {s.passRate === undefined ? '-' : <Num value={s.passRate} format={percent} />}
      </Stat>
      <Tooltip
        tip={`${s.tally.in.toLocaleString()} tokens sent to models today: prompts, context and tool results${s.tally.cached ? `, ${s.tally.cached.toLocaleString()} of them cached` : ''}\n${(s.tally.out + s.tally.reasoning).toLocaleString()} tokens generated\n${usd(Math.max(estimated, s.cost.billed))} today, of which ${usd(s.cost.billed)} billed and ${usd(estimated)} estimated at list prices\nBars: cost per hour over the last 24 hours`}
        action={sort === 'cost' ? 'Stop sorting by cost' : 'Sort by cost'}
      >
        <button
          type="button"
          aria-pressed={sort === 'cost'}
          onClick={() => toggle('cost', sort, setSort)}
          className={cx(
            'inline-flex items-center gap-2 rounded px-1.5 py-0.5 tabular-nums transition-colors',
            sort === 'cost'
              ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200'
              : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
          )}
        >
          <span className="inline-flex items-center gap-2 text-fd-muted-foreground">
            <Amount value={s.tally.in} glyph="in" />
            <Amount value={s.tally.out + s.tally.reasoning} glyph="out" />
          </span>
          <Num value={Math.max(estimated, s.cost.billed)} format={formatUsd} />
          <Spark values={s.hourly} />
        </button>
      </Tooltip>
      {!s.today && (
        <span className="pl-1 text-zinc-500">
          {s.last ? `last run ${age(new Date(s.last).toISOString())}` : 'no runs yet'}
        </span>
      )}
    </div>
  );
};
