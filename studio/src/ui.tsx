import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
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

/**
 * A small pill for a name, a link when `onClick` is given. It leads with `icon`, or with a color dot when `dot` names a
 * background class.
 */
export const Chip = ({
  children,
  icon,
  dot,
  mono,
  title,
  href,
  onClick,
}: {
  children: ReactNode;
  icon?: ReactNode;
  dot?: string | undefined;
  mono?: boolean | undefined;
  title?: string | undefined;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}) => {
  const body = (
    <>
      {icon ?? (dot && <span className={cx('size-1.5 shrink-0 rounded-full', dot)} />)}
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

const buttons = {
  default:
    'rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-sky-600 dark:hover:text-sky-300',
  primary:
    'rounded px-2.5 py-0.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-700 dark:bg-sky-700 dark:hover:bg-sky-600',
  small:
    'whitespace-nowrap rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-600 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-sky-600 dark:hover:text-sky-300',
  dashed:
    'rounded-md border border-dashed border-zinc-300 px-1.5 text-[11px] leading-5 text-zinc-500 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:hover:border-sky-600 dark:hover:text-sky-300',
};

export const Button = ({
  variant = 'default',
  className,
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof buttons }) => (
  <button
    type="button"
    className={cx(buttons[variant], 'disabled:cursor-not-allowed disabled:opacity-40', className)}
    {...props}
  />
);

/** A row of mutually exclusive options. With `href` each option is a link marked `aria-current`, else a pressed button. */
export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  label = String,
  href,
  className = 'text-xs',
  'aria-label': ariaLabel,
}: {
  options: readonly T[];
  value: T | null | undefined;
  onChange: (option: T) => void;
  label?: (option: T) => ReactNode;
  href?: (option: T) => string;
  className?: string;
  'aria-label'?: string;
}) => (
  <div
    role="group"
    aria-label={ariaLabel}
    className={cx('inline-flex flex-wrap gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900', className)}
  >
    {options.map(option => {
      const on = option === value;
      const style = cx(
        'rounded-md px-2 py-0.5 transition-colors',
        on
          ? 'bg-white font-medium text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white'
          : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
      );
      return href ? (
        <a
          key={option}
          href={href(option)}
          aria-current={on ? 'page' : undefined}
          className={style}
          onClick={e => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onChange(option);
          }}
        >
          {label(option)}
        </a>
      ) : (
        <button key={option} type="button" aria-pressed={on} className={style} onClick={() => onChange(option)}>
          {label(option)}
        </button>
      );
    })}
  </div>
);

/** Text typed into a field, kept local and committed after a pause in typing, on blur and on unmount. */
export const useCommittedText = (value: string, commit: (text: string) => void, delay = 250) => {
  const [text, setText] = useState(value);
  const latest = useRef({
    commit,
    pending: undefined as string | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  useLayoutEffect(() => {
    latest.current.commit = commit;
  });
  const flush = useCallback(() => {
    const l = latest.current;
    clearTimeout(l.timer);
    if (l.pending === undefined) return;
    const next = l.pending;
    l.pending = undefined;
    l.commit(next);
  }, []);
  const change = useCallback(
    (next: string) => {
      setText(next);
      latest.current.pending = next;
      clearTimeout(latest.current.timer);
      latest.current.timer = setTimeout(flush, delay);
    },
    [flush, delay]
  );
  useEffect(() => {
    if (latest.current.pending === undefined) setText(value);
  }, [value]);
  useEffect(() => flush, [flush]);
  return { text, change, flush };
};

/** Calls `poll` every `ms` while the tab is visible, and again whenever it becomes visible. */
export const usePolling = (poll: () => void, ms: number) => {
  const tick = useEffectEvent(poll);
  useEffect(() => {
    const run = () => {
      if (!document.hidden) tick();
    };
    const timer = setInterval(run, ms);
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [ms]);
};
