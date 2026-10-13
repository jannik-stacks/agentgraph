import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { RunStatus } from '../../../src/store.ts';
import type { Tally } from '../../../src/usage.ts';
import type { Tone } from '../graph-model.ts';
import { checkMarks, type Glyph, Icon, KindIcon } from '../studio/icons.tsx';
import { cx, statusTone, tones, Tooltip } from '../ui.tsx';

/** The header of the right pane: one line at a fixed height, whatever the selection puts in it. */
export const paneHeader =
  'flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b border-zinc-200 px-3 text-xs dark:border-zinc-800';

export const formatTokens = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(2)}M`;

export const formatUsd = (usd: number) => (usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

export const formatDuration = (ms: number | undefined) => {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
};

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
const steps: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', Infinity],
];

export const age = (iso: string, now = Date.now()) => {
  let value = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return iso;
};

const firstSeen = new Map<string, number>();
const freshFor = 1200;

/**
 * Records when the client first learned of each key. Keys known from the first load are old; keys that arrive later
 * are new for a moment, which is what lets a row animate in once and never again.
 */
export const noteSeen = (keys: Iterable<string>, old: boolean) => {
  const now = old ? 0 : Date.now();
  for (const key of keys) if (!firstSeen.has(key)) firstSeen.set(key, now);
};

/** The class that slides a row in, when its key arrived just now rather than with the first load. */
export const useEnter = (key: string) => {
  const [enter] = useState(() => {
    const at = firstSeen.get(key);
    return at !== undefined && at > 0 && Date.now() - at < freshFor;
  });
  return enter ? 'bhm-enter' : undefined;
};

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A number that counts up to its new value instead of jumping, unless motion is reduced. */
export const Num = memo(function Num({ value, format }: { value: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  useEffect(() => {
    const node = ref.current?.firstChild;
    const from = last.current;
    last.current = value;
    if (!node || from === value || reduced()) return;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 300);
      node.nodeValue = format(from + (value - from) * (1 - (1 - k) ** 3));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      node.nodeValue = format(value);
    };
  }, [value, format]);
  return (
    <span ref={ref} className="tabular-nums">
      {format(value)}
    </span>
  );
});

const statusGlyph: Record<RunStatus, Glyph> = {
  queued: 'queued',
  running: 'live',
  succeeded: 'ok',
  failed: 'fail',
  'timed-out': 'fail',
  interrupted: 'fail',
  cancelled: 'skipped',
  skipped: 'skipped',
};

const checkMark: Record<RunStatus, keyof typeof checkMarks> = {
  queued: 'queued',
  running: 'queued',
  succeeded: 'ok',
  failed: 'fail',
  'timed-out': 'halt',
  interrupted: 'halt',
  cancelled: 'skipped',
  skipped: 'skipped',
};

const marks: Partial<Record<Glyph, string>> = { ok: 'm8 12 3 3 5-6', fail: 'm9 9 6 6m0-6-6 6', queued: 'M12 7v5l3 2' };

/** The run spinner. When the run ends the arc closes into a ring and the mark draws in, in the same element. */
const RunStatusIcon = ({ status, tone, className }: { status: RunStatus; tone: Tone; className: string }) => {
  const running = status === 'running';
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cx('shrink-0 transition-colors duration-300', tones[tone].text, className)}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        pathLength={100}
        className={cx(
          'origin-center transition-[stroke-dasharray] duration-500 [transform-box:fill-box]',
          running && 'motion-safe:animate-spin'
        )}
        style={{ strokeDasharray: running ? '28 100' : '100 0' }}
      />
      <path
        d={marks[statusGlyph[status]] ?? 'M8 12h8'}
        pathLength={1}
        className="transition-[stroke-dashoffset] delay-300 duration-300"
        style={{ strokeDasharray: 1, strokeDashoffset: running ? 1 : 0 }}
      />
    </svg>
  );
};

/** A status dot in its tone, with a halo pulsing out of it while `pulse` is set. */
export const Dot = ({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) => (
  <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
    {pulse && <span className={cx('bhm-halo absolute size-2 rounded-full', tones[tone].dot)} />}
    <span className={cx('relative size-2 rounded-full transition-colors duration-300', tones[tone].dot)} />
  </span>
);

/** A job at work: three grey dots breathing in turn. */
const Breathing = ({ className }: { className: string }) => (
  <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center gap-px', className)}>
    {[0, 1, 2].map(i => (
      <span
        key={i}
        className="bhm-breathe size-[3px] rounded-full bg-zinc-400 dark:bg-zinc-500"
        style={{ animationDelay: `${i * 160}ms` }}
      />
    ))}
  </span>
);

const statusTip: Record<RunStatus, string> = {
  queued: 'Queued, waiting to start',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  'timed-out': 'Timed out',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  skipped: 'Skipped',
};

const Look = ({
  status,
  level,
  kind,
  tone,
  className,
}: {
  status: RunStatus;
  level: 'run' | 'job' | 'event';
  kind: 'check' | 'tool' | undefined;
  tone: Tone;
  className: string;
}) => {
  if (level === 'event') return <Dot tone={tone} pulse={status === 'running'} />;
  if (status === 'running' && level === 'job') return <Breathing className={className} />;
  if (kind === 'check' && status !== 'running') {
    const mark = checkMark[status];
    return (
      <KindIcon kind="check" title="" mark={mark} tone={mark === 'halt' ? 'neutral' : tone} className={className} />
    );
  }
  if (kind === 'tool' && status !== 'running')
    return <KindIcon kind="tool" title="" {...(status !== 'succeeded' && { tone })} className={className} />;
  if (level === 'job')
    return (
      <span className={cx('inline-flex', tones[tone].text)}>
        <Icon name={statusGlyph[status]} className={className} />
      </span>
    );
  return <RunStatusIcon status={status} tone={tone} className={className} />;
};

/**
 * A status as one icon, drawn per level so one running run shows one spinner: the run spins and turns into its result,
 * a job breathes, an event shows a dot that pulses while anything under it runs. With `kind`, the kind's own icon takes
 * the status's shape and tone, so a status never sits next to a kind icon.
 */
export const StatusIcon = ({
  status,
  level = 'run',
  kind,
  tone = statusTone(status),
  className = 'size-3.5',
  tip,
}: {
  status: RunStatus;
  level?: 'run' | 'job' | 'event';
  kind?: 'check' | 'tool' | undefined;
  tone?: Tone | undefined;
  className?: string;
  tip?: string | undefined;
}) => (
  <Tooltip tip={tip ?? `${statusTip[status]}${level === 'run' ? '' : level === 'job' ? ', this job' : ', this event'}`}>
    <span role="img" aria-label={status} className="inline-flex shrink-0">
      <Look status={status} level={level} kind={kind} tone={tone} className={className} />
    </span>
  </Tooltip>
);

const subscribers = new Set<() => void>();
let clock: ReturnType<typeof setInterval> | undefined;
const subscribeClock = (tick: () => void) => {
  subscribers.add(tick);
  clock ??= setInterval(() => subscribers.forEach(fn => fn()), 1000);
  return () => {
    subscribers.delete(tick);
    if (!subscribers.size) {
      clearInterval(clock);
      clock = undefined;
    }
  };
};
const noClock = () => () => {};
const second = () => Math.floor(Date.now() / 1000);

/** How long a run took, counting every second while it runs. Shown on one element per running thing. */
export const Elapsed = ({ startedAt, endedAt }: { startedAt?: string | undefined; endedAt?: string | undefined }) => {
  const now = useSyncExternalStore(endedAt ? noClock : subscribeClock, second, second);
  if (!startedAt) return <span />;
  const ms = new Date(endedAt ?? now * 1000).getTime() - new Date(startedAt).getTime();
  return <span className="text-zinc-500 tabular-nums">{formatDuration(Math.max(0, ms))}</span>;
};

const Amount = ({ value, glyph }: { value: number; glyph: 'in' | 'out' }) => (
  <span className="inline-flex items-center">
    <Num value={value} format={formatTokens} />
    <Icon name={glyph} className="size-3" />
  </span>
);

type Tokens = Pick<Tally, 'in' | 'out' | 'cached' | 'reasoning'>;

const tokenLines = (tally: Tokens) =>
  [
    `${tally.in.toLocaleString()} tokens in${tally.cached ? `, ${tally.cached.toLocaleString()} of them cached` : ''}`,
    `${tally.out.toLocaleString()} tokens out${tally.reasoning ? `, plus ${tally.reasoning.toLocaleString()} reasoning` : ''}`,
  ].join('\n');

/** Tokens in and out, each number followed by its arrow, muted; the exact counts in the tooltip. */
export const Io = ({ tally, className, tip }: { tally: Tokens; className?: string; tip?: string }) => (
  <Tooltip tip={tip ? `${tip}\n${tokenLines(tally)}` : tokenLines(tally)}>
    <span className={cx('inline-flex items-center gap-2 text-fd-muted-foreground tabular-nums', className)}>
      <Amount value={tally.in} glyph="in" />
      <Amount value={tally.out + tally.reasoning} glyph="out" />
    </span>
  </Tooltip>
);

const exact = (usd: number) =>
  usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 10,
  });

/**
 * Cost, rounded: the list-price estimate when it is higher than what was billed, else the billed amount. The tooltip
 * has both exact values and, given `tally`, the tokens behind them.
 */
export const Cost = ({
  billed,
  estimated,
  tally,
  tip,
  className,
}: {
  billed: number;
  estimated?: number | undefined;
  tally?: Tokens | undefined;
  tip?: string | undefined;
  className?: string;
}) => {
  const shown = estimated !== undefined && estimated > billed ? estimated : billed;
  const lines = [
    tip,
    `${exact(shown)}${estimated === undefined ? '' : `, of which ${exact(billed)} billed`}`,
    estimated === undefined ? 'No list price for this model' : `${exact(estimated)} estimated at list prices`,
    tally && tokenLines(tally),
  ];
  return (
    <Tooltip tip={lines.filter(Boolean).join('\n')} className={className}>
      <span className="inline-flex w-full items-center justify-[inherit] text-fd-muted-foreground tabular-nums">
        <Num value={shown} format={formatUsd} />
      </span>
    </Tooltip>
  );
};
