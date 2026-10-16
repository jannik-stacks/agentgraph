import {
  cloneElement,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from 'react';
import { useSetAtom } from 'jotai';
import { navigateAtom } from './state.ts';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/** The one accent color, for what needs attention: running, waiting and failed. */
export const accent = {
  text: 'text-sky-600 dark:text-sky-400',
  border: 'border-sky-600 dark:border-sky-400',
};

const isInternal = (href: string | undefined): href is string => !!href?.startsWith('/') && !href.startsWith('//');

/** An anchor that navigates in-app for same-origin paths and leaves everything else to the browser. */
export const Link = ({ href, onClick, ...props }: ComponentProps<'a'>) => {
  const navigate = useSetAtom(navigateAtom);
  return (
    <a
      href={href}
      {...props}
      onClick={e => {
        onClick?.(e);
        if (e.defaultPrevented || !isInternal(href)) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 || props.target) return;
        e.preventDefault();
        navigate({ href });
      }}
    />
  );
};

export const Badge = ({ on = false, children }: { on?: boolean; children: ReactNode }) => (
  <span
    className={cx(
      'inline-block rounded border px-1.5 text-[10px] leading-4 font-medium',
      on ? cx(accent.border, accent.text) : 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300'
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
  <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">{children}</dl>
);

export const Muted = ({ children }: { children: ReactNode }) => <p className="p-4 text-zinc-500">{children}</p>;

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
      className={className}
    >
      <summary
        className={cx(
          'flex cursor-pointer items-center gap-1.5 select-none marker:content-none [&::-webkit-details-marker]:hidden',
          summaryClassName
        )}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-3 shrink-0 text-zinc-400 [details[open]>summary>&]:rotate-90"
        >
          <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {summary}
      </summary>
      {shown && children}
    </details>
  );
};

export const field =
  'rounded border border-zinc-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900';

const buttons = {
  default:
    'rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-400',
  primary:
    'rounded bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-zinc-300',
  small:
    'rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-zinc-600 hover:border-zinc-500 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-400',
  ghost: 'rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200',
  quiet:
    'inline-flex size-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 aria-pressed:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:aria-pressed:text-zinc-100',
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

/**
 * Explains what it wraps on hover and on keyboard focus: `tip` what it is, `action` what clicking it does. The tip sits
 * in the top layer, so scrolling containers never clip it. `focusable` lets keyboard users reach content that is not
 * interactive itself.
 */
export const Tooltip = ({
  tip,
  action,
  children,
  focusable = false,
  className,
}: {
  tip?: ReactNode;
  action?: ReactNode;
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
  const info = tip !== undefined && tip !== null && tip !== '';
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
        {info && tip}
        {action && (
          <span className={cx('block', info && 'mt-1 text-[10px] text-zinc-400 dark:text-zinc-500')}>{action}</span>
        )}
      </span>
    </span>
  );
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

/** A button showing only an icon; `tip` names what it does, as its tooltip and its accessible name. */
export const IconButton = ({ tip, variant = 'small', ...props }: ComponentProps<typeof Button> & { tip: string }) => (
  <Tooltip action={tip}>
    <Button variant={variant} aria-label={tip} {...props} />
  </Tooltip>
);

/** A row of mutually exclusive options as pressed buttons. */
export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  label = String,
  className = 'text-xs',
  'aria-label': ariaLabel,
}: {
  options: readonly T[];
  value: T | null | undefined;
  onChange: (option: T) => void;
  label?: (option: T) => ReactNode;
  className?: string;
  'aria-label'?: string;
}) => (
  <div
    role="group"
    aria-label={ariaLabel}
    className={cx('inline-flex flex-wrap gap-0.5 rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-900', className)}
  >
    {options.map(option => (
      <button
        key={option}
        type="button"
        aria-pressed={option === value}
        className={cx(
          'rounded px-2 py-0.5',
          option === value
            ? 'bg-white font-medium text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white'
            : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
        )}
        onClick={() => onChange(option)}
      >
        {label(option)}
      </button>
    ))}
  </div>
);

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
