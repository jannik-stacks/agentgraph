import { type ReactNode, useCallback, useState } from 'react';
import type { Closure } from '../../src/schema.ts';
import type { RunStatus } from '../../src/store.ts';
import type { Tone } from './graph-model.ts';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

const tones: Record<Tone, string> = {
  neutral: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  info: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

const statusTones: Partial<Record<RunStatus, Tone>> = { queued: 'neutral', running: 'info', succeeded: 'ok' };
export const statusTone = (status: RunStatus): Tone => statusTones[status] ?? 'danger';

export const closureTones: Record<Closure, Tone> = {
  done: 'ok',
  'handed-off': 'info',
  blocked: 'warn',
  deferred: 'warn',
  'no-op': 'neutral',
};

export const Badge = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => (
  <span
    className={cx(
      'inline-block rounded px-1.5 py-px text-[10px] font-medium normal-case leading-4 tracking-normal',
      tones[tone]
    )}
  >
    {children}
  </span>
);

export const Field = ({ name, children }: { name: string; children: ReactNode }) => (
  <>
    <dt className="text-zinc-500">{name}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </>
);

export const Fields = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{children}</dl>
);

export const Pre = ({ children }: { children: ReactNode }) => (
  <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
    {children}
  </pre>
);

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
    {children}
  </section>
);

export const Muted = ({ children }: { children: ReactNode }) => <p className="p-4 text-zinc-500">{children}</p>;

export const list = (items: readonly string[] | undefined) => (items?.length ? items.join(', ') : '-');

const chipBase =
  'inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-px text-xs leading-5 transition-colors';
const chipIdle = 'border-zinc-200 bg-white text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300';
const chipLink =
  'cursor-pointer border-zinc-200 bg-white text-zinc-800 hover:border-sky-400 hover:bg-sky-50 hover:text-sky-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-sky-600 dark:hover:bg-sky-950 dark:hover:text-sky-200';

/** A small pill for a name, a link when `onClick` is given. `dot` is a background class for a leading color dot. */
export const Chip = ({
  children,
  dot,
  mono,
  title,
  href,
  onClick,
}: {
  children: ReactNode;
  dot?: string | undefined;
  mono?: boolean | undefined;
  title?: string | undefined;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}) => {
  const body = (
    <>
      {dot && <span className={cx('size-1.5 shrink-0 rounded-full', dot)} />}
      <span className={cx('truncate', mono && 'font-mono text-[11px]')}>{children}</span>
    </>
  );
  if (!onClick)
    return (
      <span className={cx(chipBase, chipIdle)} title={title}>
        {body}
      </span>
    );
  return (
    <a
      href={href}
      title={title}
      className={cx(chipBase, chipLink)}
      onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onClick();
      }}
    >
      {body}
    </a>
  );
};

export const Chips = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap gap-1">{children}</div>;

const readFlag = (key: string, fallback: boolean) => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
};

/** A boolean remembered per browser in localStorage. */
export const useStoredFlag = (key: string, fallback: boolean) => {
  const [value, setValue] = useState(() => readFlag(key, fallback));
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {}
    },
    [key]
  );
  return [value, set] as const;
};
