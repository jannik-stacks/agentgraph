import { createMarkdownRenderer } from 'fumadocs-core/content/md';
import { remarkGfm } from 'fumadocs-core/mdx-plugins/remark-gfm';
import {
  type ComponentProps,
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useHighlighted } from './source/highlight.tsx';
import { Icon } from './icons.tsx';
import { cx, IconButton } from './ui.tsx';

const { Markdown: Render } = createMarkdownRenderer({ remarkPlugins: [remarkGfm] });

/** The one surface every code block sits on: close to the page, a hairline border, no shadow. */
export const codeSurface =
  'rounded-md border border-zinc-200 bg-(--bhm-code-bg) text-zinc-700 dark:border-zinc-800 dark:text-zinc-300';

/** Copies `code`, showing a tick for a moment after. */
const CopyCode = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      tip={copied ? 'Copied' : 'Copy'}
      variant="quiet"
      onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}
    >
      <Icon name={copied ? 'tick' : 'copy'} className="size-3" />
    </IconButton>
  );
};

/**
 * A code block, colored in place once shiki has loaded. With `lines`, a longer
 * block shows only that many lines and fades out over a button to the rest. `compact` sets it smaller for tool calls;
 * `wrap` breaks long lines instead of scrolling.
 */
export const Code = memo(function Code({
  code,
  lang = 'text',
  className,
  lines,
  compact = false,
  wrap = false,
}: {
  code: string;
  lang?: string | undefined;
  className?: string | undefined;
  lines?: number | undefined;
  compact?: boolean;
  wrap?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const all = code.split('\n');
  const folded = lines !== undefined && !open;
  const shown = folded && all.length > lines ? all.slice(0, lines).join('\n') : code;
  const hidden = folded ? Math.max(0, all.length - lines) : 0;
  useLayoutEffect(() => {
    const el = box.current;
    setClipped(!!el && folded && el.scrollHeight > el.clientHeight + 1);
  }, [shown, folded]);
  const more = hidden > 0 || clipped || open;
  return (
    <div className={cx('relative my-1.5', codeSurface, className)}>
      <div className="absolute top-1 right-1 z-2 flex items-center gap-0.5 rounded bg-(--bhm-code-bg)">
        {more && (
          <IconButton
            tip={open ? 'Show fewer lines' : 'Show every line'}
            variant="quiet"
            aria-pressed={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? 'collapse' : 'expand'} className="size-3" />
          </IconButton>
        )}
        <CopyCode code={code} />
      </div>
      <div
        ref={box}
        className={cx(
          'overflow-auto px-3',
          compact ? 'py-1.5 text-[11px] leading-4' : 'py-2 text-[11.5px] leading-[1.6]',
          open ? 'max-h-[40rem]' : 'max-h-96',
          folded && 'overflow-y-clip',
          wrap && '[&_:is(pre,code)]:break-all [&_:is(pre,code)]:whitespace-pre-wrap'
        )}
        style={folded ? { maxHeight: `calc(${lines} * 1lh + 1rem)` } : undefined}
      >
        <pre className="shiki">{useHighlighted(shown, lang)}</pre>
      </div>
      {folded && (hidden > 0 || clipped) && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="absolute inset-x-0 bottom-0 flex h-8 items-end bg-(--bhm-code-bg) px-3 pb-1 text-left text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          {hidden > 0 ? `${hidden} more ${hidden === 1 ? 'line' : 'lines'}` : 'show all'}
        </button>
      )}
    </div>
  );
});

type CodeElement = ReactElement<{ className?: string; children?: ReactNode }>;

const pre = ({ children }: ComponentProps<'pre'>) => {
  const { className = '', children: text } = (children as CodeElement).props;
  return <Code code={String(text ?? '').replace(/\n$/, '')} lang={/language-(\S+)/.exec(className)?.[1]} />;
};

const a = (props: ComponentProps<'a'>) => <a {...props} target="_blank" rel="noreferrer" />;
const components = { pre, a };

/** Markdown with GitHub extensions and highlighted code blocks, sized for panels. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string | undefined }) {
  return (
    <div className={cx('bhm-md', className)}>
      <Render components={components}>{text}</Render>
    </div>
  );
});
