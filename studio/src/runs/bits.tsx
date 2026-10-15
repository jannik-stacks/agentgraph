import type { RunStatus } from '../../../src/store.ts';
import type { Tally } from '../../../src/usage.ts';
import { accent, cx, Tooltip } from '../ui.tsx';
import { type Phase, phaseWord } from './model.ts';

export const formatTokens = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(2)}M`;

const formatUsd = (usd: number) => (usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

const formatDuration = (ms: number | undefined) => {
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

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** How long a run took, or when it started while it still runs. */
export const Took = ({ startedAt, endedAt }: { startedAt?: string | undefined; endedAt?: string | undefined }) =>
  startedAt ? (
    <span className="text-zinc-500 tabular-nums">
      {endedAt
        ? formatDuration(new Date(endedAt).getTime() - new Date(startedAt).getTime())
        : `since ${clock(startedAt)}`}
    </span>
  ) : null;

/** A phase as its word: the accent color for anything not done, plain gray for done. */
export const PhaseWord = ({
  phase,
  status,
  className,
}: {
  phase: Phase;
  status?: RunStatus | undefined;
  className?: string;
}) => (
  <span className={cx('shrink-0 text-xs', phase === 'done' ? 'text-zinc-500' : accent.text, className)}>
    {phaseWord(phase, status)}
  </span>
);

type Tokens = Pick<Tally, 'in' | 'out' | 'cached' | 'reasoning'>;

/** Tokens in and out, muted, with the exact counts in the tooltip. */
export const Io = ({ tally, className }: { tally: Tokens; className?: string }) => (
  <Tooltip
    tip={[
      `${tally.in.toLocaleString()} tokens in${tally.cached ? `, ${tally.cached.toLocaleString()} of them cached` : ''}`,
      `${tally.out.toLocaleString()} tokens out${tally.reasoning ? `, plus ${tally.reasoning.toLocaleString()} reasoning` : ''}`,
    ].join('\n')}
  >
    <span className={cx('text-zinc-500 tabular-nums', className)}>
      {formatTokens(tally.in)} in, {formatTokens(tally.out + tally.reasoning)} out
    </span>
  </Tooltip>
);

/** Cost: the list-price estimate when it is higher than what was billed, else the billed amount. */
export const Cost = ({ billed, estimated }: { billed: number; estimated?: number | undefined }) => {
  const shown = estimated !== undefined && estimated > billed ? estimated : billed;
  return (
    <Tooltip
      tip={
        estimated === undefined
          ? `${formatUsd(billed)} billed; no list price for this model`
          : `${formatUsd(estimated)} at list prices, ${formatUsd(billed)} billed`
      }
    >
      <span className="text-zinc-500 tabular-nums">{formatUsd(shown)}</span>
    </Tooltip>
  );
};
