import { createMarkdownRenderer } from 'fumadocs-core/content/md';
import { remarkGfm } from 'fumadocs-core/mdx-plugins/remark-gfm';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import {
  type ComponentProps,
  type CSSProperties,
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useHighlighted } from './source/highlight.tsx';
import { Icon } from './studio/icons.tsx';
import { cx, IconButton } from './ui.tsx';

const { Markdown: Render } = createMarkdownRenderer({ remarkPlugins: [remarkGfm] });

const padded = { '--padding-left': 'calc(var(--spacing) * 3)' } as CSSProperties;

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
 * A code block, colored in place once shiki has loaded. `actions` sit beside the copy button. With `lines`, a longer
 * block shows only that many lines and fades out over a button to the rest. `compact` sets it smaller for tool calls;
 * `wrap` breaks long lines instead of scrolling.
 */
export const Code = memo(function Code({
  code,
  lang = 'text',
  className,
  actions,
  lines,
  compact = false,
  wrap = false,
}: {
  code: string;
  lang?: string | undefined;
  className?: string | undefined;
  actions?: ReactNode;
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
    <CodeBlock
      className={cx('my-1.5 shadow-none', codeSurface, className)}
      style={padded}
      allowCopy={false}
      Actions={() => (
        <div className="absolute top-1 right-1 z-2 flex items-center gap-0.5 rounded bg-(--bhm-code-bg)/80 backdrop-blur-sm">
          {actions}
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
      )}
      viewportProps={{
        className: cx(
          compact ? 'py-1.5 text-[11px] leading-4' : 'py-2 text-[11.5px] leading-[1.6]',
          open ? 'max-h-[40rem]' : 'max-h-96',
          wrap && '[&_pre]:w-auto [&_:is(pre,code)]:whitespace-pre-wrap [&_:is(pre,code)]:break-all'
        ),
      }}
    >
      <div
        ref={box}
        className={cx(folded && 'overflow-y-clip')}
        style={folded ? { maxHeight: `calc(${lines} * 1lh)` } : undefined}
      >
        <Pre>{useHighlighted(shown, lang)}</Pre>
      </div>
      {folded && (hidden > 0 || clipped) && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="absolute inset-x-0 bottom-0 flex h-10 items-end bg-linear-to-t from-(--bhm-code-bg) from-50% to-transparent px-3 pb-1 text-left text-[11px] text-zinc-500 hover:text-sky-700 dark:hover:text-sky-300"
        >
          {hidden > 0 ? `${hidden} more ${hidden === 1 ? 'line' : 'lines'}` : 'show all'}
        </button>
      )}
    </CodeBlock>
  );
});

type CodeElement = ReactElement<{ className?: string; children?: ReactNode }>;

type Fences = Record<string, (code: string) => ReactNode>;

const preWith =
  (fences: Fences | undefined) =>
  ({ children }: ComponentProps<'pre'>) => {
    const { className = '', children: text } = (children as CodeElement).props;
    const code = String(text ?? '').replace(/\n$/, '');
    const lang = /language-(\S+)/.exec(className)?.[1];
    const fence = lang ? fences?.[lang] : undefined;
    return fence ? fence(code) : <Code code={code} lang={lang} />;
  };

const a = (props: ComponentProps<'a'>) => <a {...props} target="_blank" rel="noreferrer" />;

/**
 * Markdown the way the docs render it: GitHub extensions, the docs' prose styles and code blocks, the whole prose scaled
 * down for panels so inline code, links, lists and headings keep the docs' proportions.
 * Parsing is synchronous, so the first paint is already final; only code colors arrive later, in place. `code` may
 * turn an inline code span into something richer, like a link; `fences` draws fenced blocks of a language its own way.
 */
export const Markdown = memo(function Markdown({
  text,
  code,
  fences,
  className,
}: {
  text: string;
  code?: ((text: string) => ReactNode) | undefined;
  fences?: Fences | undefined;
  className?: string | undefined;
}) {
  const components = useMemo(
    () => ({
      table: defaultMdxComponents.table,
      pre: preWith(fences),
      a,
      ...(code && {
        code: ({ children, className, ...props }: ComponentProps<'code'>) =>
          (!className && typeof children === 'string' && code(children)) || (
            <code className={className} {...props}>
              {children}
            </code>
          ),
      }),
    }),
    [code, fences]
  );
  return (
    <div
      className={cx(
        'prose max-w-none [--tw-prose-size:0.8125] [&_:where(p,ul,ol,blockquote)]:my-2 [&_:where(h1,h2,h3,h4)]:mt-3 [&_:where(h1,h2,h3,h4)]:mb-1.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0',
        className
      )}
    >
      <Render components={components}>{text}</Render>
    </div>
  );
});

export default Markdown;
