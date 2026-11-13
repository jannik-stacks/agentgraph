import { createMarkdownRenderer } from 'fumadocs-core/content/md';
import { remarkGfm } from 'fumadocs-core/mdx-plugins/remark-gfm';
import { remarkHeading } from 'fumadocs-core/mdx-plugins/remark-heading';
import type { Root as RenderTree } from 'hast';
import {
  type ComponentProps,
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SKIP, visit } from 'unist-util-visit';
import { useHighlighted } from './source/highlight.tsx';
import { Icon } from './icons.tsx';
import { cx, IconButton, Link } from './ui.tsx';

const remarkStatus = () => (tree: Parameters<ReturnType<typeof remarkHeading>>[0]) => {
  visit(tree, 'html', (node, index, parent) => {
    const status = /^<!--\s*(unfinished|untested)\s*-->$/.exec(node.value)?.[1];
    if (!status || index === undefined || (parent?.type !== 'heading' && parent?.type !== 'paragraph')) return;
    const before = parent.children[index - 1];
    if (before?.type === 'text' && index === parent.children.length - 1) before.value = before.value.trimEnd();
    parent.children.splice(index, 1);
    parent.data ??= {};
    parent.data.hProperties = { ...parent.data.hProperties, 'data-doc-status': status };
    return index;
  });
};

const rehypeStatus = () => (tree: RenderTree) => {
  visit(tree, 'element', node => {
    const status = node.properties['data-doc-status'];
    if (typeof status !== 'string') return;
    delete node.properties['data-doc-status'];
    node.properties.className = ['flex', 'items-baseline', 'gap-3'];
    node.children = [
      { type: 'element', tagName: 'span', properties: { className: ['min-w-0'] }, children: node.children },
      {
        type: 'element',
        tagName: 'span',
        properties: {
          className: [
            'ml-auto',
            'shrink-0',
            'rounded-full',
            'border',
            'border-zinc-200/60',
            'bg-zinc-100/50',
            'px-2',
            'py-0.5',
            'text-[10px]',
            'leading-4',
            'font-medium',
            'text-zinc-500',
            'dark:border-zinc-800/60',
            'dark:bg-zinc-900/50',
            'dark:text-zinc-400',
          ],
          'data-doc-status': status,
        },
        children: [{ type: 'text', value: status }],
      },
    ];
    return SKIP;
  });
};

const { Markdown: Render } = createMarkdownRenderer({
  remarkPlugins: [remarkGfm, remarkStatus, [remarkHeading, { generateToc: false }]],
  rehypePlugins: [rehypeStatus],
});

export const codeSurface =
  'rounded-md border border-zinc-200 bg-(--agi-code-bg) text-zinc-700 dark:border-zinc-800 dark:text-zinc-300';

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
      <div className="absolute top-1 right-1 z-2 flex items-center gap-0.5 rounded bg-(--agi-code-bg)">
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
          compact ? 'py-1.5 text-[11px] leading-4' : 'py-2 text-[11.5px] leading-[1.25]',
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
          className="absolute inset-x-0 bottom-0 flex h-8 items-end rounded-b-[inherit] bg-(--agi-code-bg) px-3 pb-1 text-left text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
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

const makeAnchor =
  (base: string | undefined) =>
  ({ href = '', ...props }: ComponentProps<'a'>) => {
    const page = /^([\w-]+)\.md(#.*)?$/.exec(href);
    if (page) return <Link {...props} href={`/docs/${page[1]}${page[2] ?? ''}`} />;
    if (href.startsWith('#')) return <a href={href} {...props} />;
    const absolute = /^([a-z][\w+.-]*:|\/\/)/i.test(href);
    if (!absolute && !base) return <span>{props.children}</span>;
    return <a href={absolute ? href : new URL(href, base).href} {...props} target="_blank" rel="noreferrer" />;
  };

export const Markdown = memo(function Markdown({
  text,
  className,
  base,
}: {
  text: string;
  className?: string | undefined;
  base?: string;
}) {
  const components = useMemo(() => ({ pre, a: makeAnchor(base) }), [base]);
  return (
    <div className={cx('agi-md', className)}>
      <Render components={components}>{text}</Render>
    </div>
  );
});
