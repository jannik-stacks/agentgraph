import {
  cloneElement,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Closure } from '../../src/schema.ts';
import type { RunStatus } from '../../src/store.ts';
import type { Tone } from './graph-model.ts';
import { Link } from './Providers.tsx';
import { Icon } from './studio/icons.tsx';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/**
 * The classes of each tone: a badge's fill, an icon's or text's color, a status dot's fill, a light wash for a whole row
 * and a stronger mark for part of one.
 */
export const tones: Record<Tone, { badge: string; text: string; dot: string; wash: string; mark: string }> = {
  neutral: {
    badge: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    text: 'text-zinc-400 dark:text-zinc-500',
    dot: 'bg-zinc-300 dark:bg-zinc-600',
    wash: 'bg-zinc-50 dark:bg-zinc-400/10',
    mark: 'bg-zinc-200 dark:bg-zinc-400/30',
  },
  info: {
    badge: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    text: 'text-sky-600 dark:text-sky-400',
    dot: 'bg-sky-500',
    wash: 'bg-sky-50 dark:bg-sky-500/15',
    mark: 'bg-sky-200 dark:bg-sky-500/40',
  },
  ok: {
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    wash: 'bg-emerald-50 dark:bg-emerald-500/15',
    mark: 'bg-emerald-200 dark:bg-emerald-500/40',
  },
  warn: {
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    text: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    wash: 'bg-amber-50 dark:bg-amber-500/15',
    mark: 'bg-amber-200 dark:bg-amber-500/40',
  },
  danger: {
    badge: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    text: 'text-red-600 dark:text-red-400',
    dot: 'bg-red-500',
    wash: 'bg-red-50 dark:bg-red-500/15',
    mark: 'bg-red-200 dark:bg-red-500/40',
  },
};

const statusTones: Record<RunStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  succeeded: 'ok',
  failed: 'danger',
  'timed-out': 'danger',
  interrupted: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
};

/** The tone of a run status: failures are danger, cancelled and skipped runs neutral. */
export const statusTone = (status: RunStatus) => statusTones[status];

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
      tones[tone].badge
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

export const heading = 'text-xs font-semibold uppercase tracking-wide text-zinc-500';

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-2">
    <h3 className={heading}>{title}</h3>
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

type ChipProps = {
  children: ReactNode;
  icon?: ReactNode;
  dot?: string | undefined;
  mono?: boolean | undefined;
  title?: string | undefined;
  action?: string | undefined;
  href?: string | undefined;
};

/** The chip's content, inside a span or a link that the caller styles, with `title` and `action` as its tooltip. */
const ChipInner = ({
  children,
  icon,
  dot,
  mono,
  title,
  action,
  href,
  className,
}: ChipProps & { className: string }) => {
  const body = (
    <>
      {icon ?? (dot && <span className={cx('size-1.5 shrink-0 rounded-full', dot)} />)}
      <span className={cx('truncate', mono && 'font-mono text-[11px]')}>{children}</span>
    </>
  );
  const chip = href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <span className={className}>{body}</span>
  );
  return title || action ? (
    <Tooltip tip={title} action={action}>
      {chip}
    </Tooltip>
  ) : (
    chip
  );
};

/**
 * A small pill for a name, a link when `href` is given. It leads with `icon`, or with a color dot when `dot` names a
 * background class.
 */
export const Chip = (chip: ChipProps) => (
  <ChipInner {...chip} className={cx(chipBase, chip.href ? chipLink : chipIdle)} />
);

/** A {@link Chip} with a remove button inside its border, for editable lists. */
export const RemovableChip = ({ label, onRemove, ...chip }: ChipProps & { label: string; onRemove: () => void }) => (
  <span
    className={cx(
      chipBase,
      chipIdle,
      'gap-0 pr-0',
      chip.href &&
        'has-[a:hover]:border-sky-400 has-[a:hover]:bg-sky-50 dark:has-[a:hover]:border-sky-600 dark:has-[a:hover]:bg-sky-950'
    )}
  >
    <ChipInner
      {...chip}
      className={cx(
        'inline-flex min-w-0 items-center gap-1.5',
        chip.href && 'cursor-pointer hover:text-sky-800 dark:hover:text-sky-200'
      )}
    />
    <button
      type="button"
      aria-label={`Remove ${label}`}
      onClick={onRemove}
      className="-my-px ml-1.5 flex items-center self-stretch rounded-r-[5px] border-l border-zinc-200 px-1 text-zinc-400 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset dark:border-zinc-700 dark:text-zinc-500 dark:hover:bg-red-950 dark:hover:text-red-400"
    >
      <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  </span>
);

export const Chips = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap gap-1">{children}</div>;

/**
 * A summary row with a turning chevron that folds its content, which renders only while open. It opens as `open` says
 * and again whenever `open` changes; `onToggle` reports the reader's clicks.
 */
export const Disclosure = ({
  summary,
  open = false,
  onToggle,
  className,
  summaryClassName,
  children,
}: {
  summary: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  className?: string;
  summaryClassName?: string;
  children: ReactNode;
}) => {
  const [state, setState] = useState({ open, shown: open });
  let shown = state.shown;
  if (state.open !== open) {
    shown = open;
    setState({ open, shown });
  }
  return (
    <details
      open={shown}
      onToggle={e => {
        const next = e.currentTarget.open;
        if (next === shown) return;
        setState({ open, shown: next });
        onToggle?.(next);
      }}
      className={cx('group/disclosure', className)}
    >
      <summary
        className={cx(
          'flex cursor-pointer select-none items-center gap-1.5 marker:content-none [&::-webkit-details-marker]:hidden',
          summaryClassName
        )}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-3 shrink-0 text-zinc-400 transition-transform group-open/disclosure:rotate-90"
        >
          <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {summary}
      </summary>
      {shown && children}
    </details>
  );
};

const buttons = {
  default:
    'rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-sky-600 dark:hover:text-sky-300',
  primary:
    'rounded px-2.5 py-0.5 text-xs font-medium text-white bg-sky-600 hover:bg-sky-700 dark:bg-sky-700 dark:hover:bg-sky-600',
  small:
    'whitespace-nowrap rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-600 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-sky-600 dark:hover:text-sky-300',
  ghost: 'rounded p-0.5 text-zinc-400 hover:text-sky-600 dark:hover:text-sky-400',
  quiet:
    'inline-flex size-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 aria-pressed:text-sky-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:aria-pressed:text-sky-400',
  dashed:
    'rounded-md border border-dashed border-zinc-300 px-1.5 text-[11px] leading-5 text-zinc-500 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:hover:border-sky-600 dark:hover:text-sky-300',
};

const gap = 6;

const place = (tip: HTMLElement, anchor: DOMRect) => {
  tip.showPopover();
  const box = tip.getBoundingClientRect();
  const below = anchor.bottom + gap;
  const top = below + box.height > innerHeight ? anchor.top - box.height - gap : below;
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - box.width / 2), innerWidth - box.width - 8);
  tip.style.top = `${Math.max(8, top)}px`;
  tip.style.left = `${left}px`;
};

/** What a tooltip says: `tip` explains the element, `action` says what clicking it does, `keys` its shortcut. */
type TipProps = {
  tip?: ReactNode;
  action?: ReactNode;
  keys?: string | undefined;
};

/** The tooltip body: the explanation, then the action on its own muted line under a hairline. */
const TipContent = ({ tip, action, keys }: TipProps) => {
  const info = tip !== undefined && tip !== null && tip !== '';
  return (
    <>
      {info && tip}
      {action && (
        <span
          className={cx(
            'flex items-center gap-1.5 whitespace-normal',
            info &&
              'mt-1 border-t border-zinc-700 pt-1 text-[10px] text-zinc-400 dark:border-zinc-300 dark:text-zinc-500'
          )}
        >
          <Icon name="click" className="size-3" />
          <span className="min-w-0">{action}</span>
          {keys && (
            <kbd className="ml-auto rounded border border-zinc-600 px-1 font-mono text-[10px] leading-4 dark:border-zinc-400">
              {keys}
            </kbd>
          )}
        </span>
      )}
    </>
  );
};

/**
 * Explains what it wraps on hover and on keyboard focus, as the wrapped element's description. The tip sits in the
 * top layer, so scrolling containers never clip it. `focusable` lets keyboard users reach content that is not
 * interactive itself.
 */
export const Tooltip = ({
  tip,
  action,
  keys,
  children,
  focusable = false,
  className,
}: TipProps & {
  children: ReactNode;
  focusable?: boolean;
  className?: string | undefined;
}) => {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = (target: HTMLElement, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current && place(ref.current, target.getBoundingClientRect()), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (ref.current?.matches(':popover-open')) ref.current.hidePopover();
  };
  useEffect(() => hide, []);
  const element = isValidElement(children) && typeof children.type === 'string';
  return (
    <span
      className={cx('inline-flex min-w-0', className)}
      onMouseEnter={e => show(e.currentTarget, 300)}
      onMouseLeave={hide}
      onFocus={e => show(e.currentTarget, 0)}
      onBlur={hide}
      onKeyDown={e => e.key === 'Escape' && hide()}
      {...(!element && { 'aria-describedby': id })}
      {...(!element && focusable && { tabIndex: 0 })}
    >
      {element
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            'aria-describedby': id,
            ...(focusable && { tabIndex: 0 }),
          })
        : children}
      <span
        ref={ref}
        id={id}
        role="tooltip"
        popover="manual"
        className="pointer-events-none fixed inset-auto m-0 max-w-xs rounded border-0 bg-zinc-900 px-2 py-1 text-[11px] leading-snug whitespace-pre-line text-zinc-50 shadow-md dark:bg-zinc-100 dark:text-zinc-900"
      >
        <TipContent tip={tip} action={action} keys={keys} />
      </span>
    </span>
  );
};

/** A muted question mark that exists only to explain what sits next to it. */
export const InfoTip = ({ tip, className }: { tip: ReactNode; className?: string }) => (
  <Tooltip
    tip={tip}
    focusable
    className={cx(
      'items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300',
      className
    )}
  >
    <span role="img" aria-label="More about this" className="inline-flex">
      <Icon name="question" className="size-3" />
    </span>
  </Tooltip>
);

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

/** A button showing only an icon; `tip` names what it does, as its tooltip action and its accessible name. */
export const IconButton = ({
  tip,
  keys,
  variant = 'small',
  ...props
}: ComponentProps<typeof Button> & { tip: string; keys?: string }) => (
  <Tooltip action={tip} keys={keys}>
    <Button variant={variant} aria-label={tip} {...props} />
  </Tooltip>
);

/** A native select with its own chevron, spaced from the text, in place of the browser's arrow. */
export const Select = ({
  className,
  wrapperClassName,
  ...props
}: ComponentProps<'select'> & { wrapperClassName?: string }) => (
  <span className={cx('relative inline-flex items-center', wrapperClassName)}>
    <select
      className={cx(
        'appearance-none rounded border border-zinc-300 bg-white py-0.5 pr-6 pl-2 text-xs outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-900',
        className
      )}
      {...props}
    />
    <svg viewBox="0 0 12 12" aria-hidden="true" className="pointer-events-none absolute right-2 size-2.5 text-zinc-500">
      <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </span>
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
  label?: (option: T) => ReactNode;
  className?: string;
  'aria-label'?: string;
} & ({ href: (option: T) => string; onChange?: never } | { onChange: (option: T) => void; href?: never })) => (
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
        <Link key={option} href={href(option)} aria-current={on ? 'page' : undefined} className={style}>
          {label(option)}
        </Link>
      ) : (
        <button key={option} type="button" aria-pressed={on} className={style} onClick={() => onChange?.(option)}>
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

/** Calls `poll` every `ms` while the tab is visible, and again whenever it becomes visible. `null` pauses it. */
export const usePolling = (poll: () => void, ms: number | null) => {
  const tick = useEffectEvent(poll);
  useEffect(() => {
    if (ms === null) return;
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
