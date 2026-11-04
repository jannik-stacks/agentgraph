import {
  cloneElement,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type TransitionEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useSetAtom } from 'jotai';
import { atomWithStorage, createJSONStorage } from 'jotai/utils';
import { navigateAtom } from './state.ts';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/** The one accent color, for what needs attention: running, waiting and failed. */
export const accent = {
  text: 'text-sky-600 dark:text-sky-400',
  border: 'border-sky-600 dark:border-sky-400',
  tint: 'bg-sky-50 dark:bg-sky-950',
};

const field =
  'rounded-md border border-zinc-300 bg-white text-zinc-900 transition-[border-color,box-shadow] duration-150 hover:border-zinc-400 focus:border-zinc-500 focus:shadow-[0_0_0_3px_--alpha(var(--color-zinc-500)/20%)] focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-500 dark:focus:border-zinc-500';

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

/** Animates its height as its content resizes, clipping only while it moves so dropdowns inside stay visible. */
export const AutoHeight = ({ className, children }: { className?: string; children: ReactNode }) => {
  const [height, setHeight] = useState<number>();
  const [moving, setMoving] = useState(false);
  const measure = useCallback((el: HTMLDivElement) => {
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const own = (to: boolean) => (e: TransitionEvent) => e.target === e.currentTarget && setMoving(to);
  return (
    <div
      className={cx('shrink-0 transition-[height] duration-200 ease-out', moving && 'overflow-hidden')}
      style={{ height }}
      onTransitionRun={own(true)}
      onTransitionEnd={own(false)}
      onTransitionCancel={own(false)}
    >
      <div ref={measure} className={className}>
        {children}
      </div>
    </div>
  );
};

export const Badge = ({ children }: { children: ReactNode }) => (
  <span className="inline-block rounded border border-zinc-300 px-[5px] text-[10px] leading-[14px] font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
    {children}
  </span>
);

export const Field = ({ name, children }: { name: ReactNode; children: ReactNode }) => (
  <>
    <dt className="text-zinc-500">{name}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </>
);

export const Fields = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5">{children}</dl>
);

export const Muted = ({ children }: { children: ReactNode }) => <p className="p-4 text-zinc-500">{children}</p>;

export const Live = <T,>({
  state: { value, failure, retry },
  children,
}: {
  state: { value?: T; failure?: string; retry?: () => void };
  children: (value: T) => ReactNode;
}) =>
  value === undefined ? (
    failure !== undefined ? (
      <div role="alert" className="space-y-2 p-4 text-zinc-500">
        <p>{failure}</p>
        {retry && <Button onClick={retry}>Retry</Button>}
      </div>
    ) : (
      <Loading />
    )
  ) : (
    <>
      {failure !== undefined && (
        <p role="alert" className="px-4 pt-2 text-xs text-amber-600">
          Could not refresh, showing earlier data. {failure}
        </p>
      )}
      {children(value)}
    </>
  );

/** Three pulsing dots that fade in only once a wait passes half a second, so quick loads never flash. */
export const Loading = () => (
  <p role="status" aria-label="Loading" className="agi-loading flex gap-1 p-4">
    {[0, 1, 2].map(i => (
      <span key={i} className="size-1 rounded-full bg-zinc-400 dark:bg-zinc-500" />
    ))}
  </p>
);

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
          className="size-3 shrink-0 text-zinc-400 transition-transform duration-150 [details[open]>summary>&]:rotate-90"
        >
          <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {summary}
      </summary>
      {shown && <div className="agi-in">{children}</div>}
    </details>
  );
};

const buttons = {
  small:
    'rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-zinc-600 transition-[border-color,transform] duration-150 hover:border-zinc-500 active:scale-95 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-400',
  quiet:
    'inline-flex size-5 items-center justify-center rounded text-zinc-400 transition-[background-color,color,transform] duration-150 active:scale-90 hover:bg-zinc-100 hover:text-zinc-700 aria-pressed:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:aria-pressed:text-zinc-100',
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

/** A tip shown after `delay` beside the rect `anchor` gives at that moment, and hidden again. */
export const useTip = () => {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = (anchor: () => DOMRect, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current && place(ref.current, anchor()), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (ref.current?.matches(':popover-open')) ref.current.hidePopover();
  };
  useEffect(() => hide, []);
  return { ref, show, hide };
};

/** The bubble of a tip, in the top layer so scrolling containers never clip it. */
export const TipBubble = ({
  ref,
  id,
  tip,
  action,
}: {
  ref: React.RefObject<HTMLSpanElement | null>;
  id?: string;
  tip?: ReactNode;
  action?: ReactNode;
}) => {
  const info = tip !== undefined && tip !== null && tip !== '';
  return (
    <span
      ref={ref}
      id={id}
      role="tooltip"
      popover="manual"
      className="agi-tip pointer-events-none fixed inset-auto m-0 max-w-xs rounded border-0 bg-zinc-900 px-2 py-1 text-[11px] leading-snug text-pretty whitespace-pre-line text-zinc-50 shadow-md dark:bg-zinc-100 dark:text-zinc-900"
    >
      {info && tip}
      {action && (
        <span className={cx('block', info && 'mt-1 text-[10px] text-zinc-400 dark:text-zinc-500')}>{action}</span>
      )}
    </span>
  );
};

/**
 * Explains what it wraps on hover and on keyboard focus: `tip` what it is, `action` what clicking it does. `focusable`
 * lets keyboard users reach content that is not interactive itself.
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
  const { ref, show, hide } = useTip();
  const element = isValidElement(children) && typeof children.type === 'string';
  const near = (target: HTMLElement) => () => target.getBoundingClientRect();
  return (
    <span
      className={cx('inline-flex min-w-0', className)}
      onMouseEnter={e => show(near(e.currentTarget), 100)}
      onMouseLeave={hide}
      onFocus={e => show(near(e.currentTarget), 0)}
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
      <TipBubble ref={ref} id={id} tip={tip} action={action} />
    </span>
  );
};

/** A small focusable "?" that explains the term beside it on hover or focus. */
export const Help = ({ tip }: { tip: ReactNode }) => (
  <Tooltip tip={tip} focusable>
    <span className="inline-flex size-3.5 cursor-help items-center justify-center rounded-full border border-zinc-300 text-[9px] leading-none font-medium text-zinc-500 normal-case dark:border-zinc-700">
      ?
    </span>
  </Tooltip>
);

export const Button = ({
  variant = 'small',
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

const attempt = <T,>(run: () => T) => {
  try {
    return run();
  } catch {
    return undefined;
  }
};

const localStore = createJSONStorage<string[]>(() => ({
  getItem: key => attempt(() => localStorage.getItem(key)) ?? null,
  setItem: (key, value) => attempt(() => localStorage.setItem(key, value)),
  removeItem: key => attempt(() => localStorage.removeItem(key)),
}));

export const makeHiddenKeysAtom = (name: string) =>
  atomWithStorage<string[]>(name, [], localStore, { getOnInit: true });

export const KeyPicker = ({
  label,
  keys,
  hidden,
  onChange,
}: {
  label: string;
  keys: string[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}) => (
  <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1 text-xs text-zinc-500">
    {label}
    {keys.map(key => (
      <Button
        key={key}
        aria-pressed={!hidden.includes(key)}
        className="aria-[pressed=false]:line-through aria-[pressed=false]:opacity-50"
        onClick={() => onChange(hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key])}
      >
        {key}
      </Button>
    ))}
  </div>
);

/** A labelled native select with its chevron spaced from the text. */
export const Select = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; title?: string | undefined }[];
  onChange: (value: string) => void;
}) => (
  <label className="flex items-center gap-1.5 text-xs text-zinc-500">
    {label}
    <span className="relative flex items-center">
      <select
        className={cx(field, 'max-w-96 appearance-none py-0.5 pr-7 pl-2')}
        value={value}
        title={options.find(o => o.value === value)?.title}
        onChange={e => onChange(e.target.value)}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="pointer-events-none absolute right-2 size-3 text-zinc-400">
        <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  </label>
);

export const useScrollFade = () =>
  useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const update = () => element.classList.toggle('agi-scroll-fade', element.scrollHeight > element.clientHeight);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    update();
    return () => observer.disconnect();
  }, []);

export const MultiSelect = ({
  label,
  values,
  selected,
  onChange,
}: {
  label: string;
  values: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) => {
  const fade = useScrollFade();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const picks = values.filter(v => selected.includes(v));
  const short = picks.map(v => v || '(empty)').join(', ');
  const summary = !picks.length ? 'none' : short.length <= 24 ? short : `${picks.length} of ${values.length}`;
  const shown = values.filter(v => v.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      panel.current?.hidePopover();
    };
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);
  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      <span id={`${id}-label`} className="block text-zinc-500">
        {label}
      </span>
      <Button
        ref={button}
        popoverTarget={id}
        aria-labelledby={`${id}-label ${id}-summary`}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span id={`${id}-summary`} className="truncate">
          {summary}
        </span>
        <span aria-hidden="true">▾</span>
      </Button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={`${id}-label`}
        onKeyDown={e => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.currentTarget.hidePopover();
          button.current?.focus();
        }}
        onToggle={e => {
          const next = e.newState === 'open';
          setOpen(next);
          if (!next) setSearch('');
          if (next && button.current) place(e.currentTarget, button.current.getBoundingClientRect());
        }}
        className="fixed inset-auto m-0 w-72 max-w-[calc(100vw-1rem)] rounded-md border border-zinc-300 bg-white p-2 text-xs text-zinc-900 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <input
          ref={input => input?.setAttribute('autofocus', '')}
          type="search"
          aria-label={`Search ${label}`}
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={cx(field, 'w-full px-2 py-1')}
        />
        <div className="my-2 flex gap-1">
          <Button onClick={() => onChange(values)}>all</Button>
          <Button onClick={() => onChange([])}>none</Button>
        </div>
        <div ref={fade} className="max-h-[min(15rem,40dvh)] overflow-y-auto">
          {shown.map(v => (
            <div
              key={v}
              className="group flex items-start gap-2 rounded px-1 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 break-all">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={selected.includes(v)}
                  onChange={e => onChange(e.target.checked ? [...picks, v] : picks.filter(s => s !== v))}
                />
                {v || '(empty)'}
              </label>
              <button
                type="button"
                aria-label={`Select only ${v || '(empty)'} for ${label}`}
                onClick={() => onChange([v])}
                className="shrink-0 rounded px-1 text-[11px] text-zinc-400 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200"
              >
                only
              </button>
            </div>
          ))}
          {!shown.length && <p className="p-1 text-zinc-500">No matches.</p>}
        </div>
      </div>
    </div>
  );
};

const pattern = (words: string[]) =>
  new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');

/** `text` with every occurrence of a word wrapped in a mark. */
const Marked = ({ text, words }: { text: string; words: string[] }) =>
  words.length === 0
    ? text
    : text.split(pattern(words)).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="bg-zinc-200 text-inherit dark:bg-zinc-700">
            {part}
          </mark>
        ) : (
          part
        )
      );

/** The first line of `detail`, or when a word matches further in, the stretch around the first match. */
const snippet = (detail: string, words: string[]) => {
  const flat = detail.replace(/\s+/g, ' ').trim();
  const at = words.length ? flat.search(pattern(words)) : -1;
  if (at < 0) return detail.split('\n').find(l => l.trim()) ?? '';
  return (at > 24 ? '... ' : '') + flat.slice(Math.max(0, at - 24));
};

/**
 * A labelled text field that lists `options` as you type. Every word of the query must appear in an option's label or
 * detail, label hits first; matches are highlighted and an option with a detail shows a line of it below the label.
 * Picking one reports its value; the clear button reports null.
 */
export const Combobox = ({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  options: { value: string; label: string; detail?: string }[];
  onChange: (value: string | null) => void;
}) => {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const current = options.find(o => o.value === value);
  const words = text?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const rank = (o: { label: string; detail?: string }) => {
    const all = (where: string) => words.every(w => where.toLowerCase().includes(w));
    return all(o.label) ? 0 : all(`${o.label} ${o.detail ?? ''}`) ? 1 : 2;
  };
  const shown =
    text === null
      ? []
      : options
          .filter(o => rank(o) < 2)
          .toSorted((a, b) => rank(a) - rank(b))
          .slice(0, 100);
  const pick = (option: { value: string } | undefined) => {
    onChange(option?.value ?? null);
    setText(null);
    input.current?.blur();
  };
  return (
    <label className="flex w-fit max-w-full min-w-0 items-center gap-1.5 text-xs text-zinc-500">
      {label}
      <span className="relative flex min-w-0 items-center">
        <input
          ref={input}
          role="combobox"
          aria-expanded={text !== null}
          aria-controls={id}
          aria-autocomplete="list"
          value={text ?? current?.label ?? ''}
          placeholder={current?.label ?? placeholder}
          onFocus={() => {
            setText('');
            setActive(0);
          }}
          onBlur={() => setText(null)}
          onChange={e => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const by = e.key === 'ArrowDown' ? 1 : -1;
              setActive(a => Math.max(0, Math.min(a + by, shown.length - 1)));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (shown[active]) pick(shown[active]);
            } else if (e.key === 'Escape') input.current?.blur();
          }}
          className={cx(field, 'w-64 min-w-0 py-0.5 pr-6 pl-2 placeholder:text-zinc-400')}
        />
        {value !== null && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onMouseDown={e => e.preventDefault()}
            onClick={() => pick(undefined)}
            className="absolute right-1.5 text-zinc-400 transition-colors duration-150 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3">
              <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {text !== null && (
          <ul
            id={id}
            role="listbox"
            className="agi-in absolute top-full left-0 z-50 mt-1 max-h-72 w-full min-w-96 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-md dark:border-zinc-700 dark:bg-zinc-900"
          >
            {shown.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={i === active}
                onMouseDown={e => {
                  e.preventDefault();
                  pick(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={cx(
                  'cursor-pointer truncate px-2 py-0.5 text-zinc-900 transition-colors duration-100 dark:text-zinc-100',
                  o.detail !== undefined && 'h-10',
                  i === active && 'bg-zinc-100 dark:bg-zinc-800',
                  o.value === value && 'font-medium'
                )}
              >
                <Marked text={o.label} words={words} />
                {o.detail !== undefined && (
                  <div className="truncate text-zinc-500">
                    <Marked text={snippet(o.detail, words)} words={words} />
                  </div>
                )}
              </li>
            ))}
            {!shown.length && <li className="px-2 py-0.5">No match.</li>}
          </ul>
        )}
      </span>
    </label>
  );
};
