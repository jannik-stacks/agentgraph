import { createMarkdownRenderer } from 'fumadocs-core/content/md';
import { remarkGfm } from 'fumadocs-core/mdx-plugins/remark-gfm';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import {
  type ComponentProps,
  type CSSProperties,
  Fragment,
  memo,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { cx } from './ui.tsx';

const { Markdown: Render } = createMarkdownRenderer({ remarkPlugins: [remarkGfm] });

const themes = { light: 'github-light', dark: 'github-dark' } as const;
const highlighted = new Map<string, ReactNode>();
const pending = new Map<string, Promise<ReactNode>>();

const highlight = (key: string, code: string, lang: string) => {
  let job = pending.get(key);
  if (!job) {
    job = import('fumadocs-core/highlight')
      .then(({ highlight }) =>
        highlight(code, {
          lang,
          fallbackLanguage: 'text',
          themes,
          defaultColor: false,
          components: { pre: ({ children }) => children },
        })
      )
      .then(node => {
        highlighted.set(key, node);
        return node;
      });
    pending.set(key, job);
  }
  return job;
};

/** The same lines shiki produces, uncolored, so highlighting swaps in without moving anything. */
const PlainLines = ({ code }: { code: string }) => (
  <code>
    {code.split('\n').map((line, i) => (
      <Fragment key={i}>
        {i > 0 && '\n'}
        <span className="line">{line}</span>
      </Fragment>
    ))}
  </code>
);

const compact = { '--padding-left': 'calc(var(--spacing) * 3)' } as CSSProperties;

/**
 * A code block in the docs' style. It renders plain at once and is colored in place once shiki has loaded, with each
 * highlighted block cached.
 */
export const Code = memo(function Code({
  code,
  lang = 'text',
  className,
}: {
  code: string;
  lang?: string | undefined;
  className?: string | undefined;
}) {
  const key = `${lang}\0${code}`;
  const colored = lang !== 'text';
  const [done, setDone] = useState<{ key: string; node: ReactNode }>();
  const node = highlighted.get(key) ?? (done?.key === key ? done.node : undefined);
  useEffect(() => {
    if (!colored || highlighted.has(key)) return;
    let live = true;
    void highlight(key, code, lang).then(node => live && setDone({ key, node }));
    return () => {
      live = false;
    };
  }, [key, code, lang, colored]);
  return (
    <CodeBlock
      className={cx('my-2 rounded-md shadow-none', className)}
      style={compact}
      viewportProps={{ className: 'py-2 text-[11.5px] leading-[1.6] max-h-96' }}
    >
      <Pre>{node ?? <PlainLines code={code} />}</Pre>
    </CodeBlock>
  );
});

type CodeElement = ReactElement<{ className?: string; children?: ReactNode }>;

const pre = ({ children }: ComponentProps<'pre'>) => {
  const { className = '', children: code } = (children as CodeElement).props;
  return <Code code={String(code ?? '').replace(/\n$/, '')} lang={/language-(\S+)/.exec(className)?.[1]} />;
};

const a = (props: ComponentProps<'a'>) => <a {...props} target="_blank" rel="noreferrer" />;

/**
 * Markdown the way the docs render it: GitHub extensions, the docs' prose styles and code blocks, sized for panels.
 * Parsing is synchronous, so the first paint is already final; only code colors arrive later, in place. `code` may
 * turn an inline code span into something richer, like a link.
 */
export const Markdown = memo(function Markdown({
  text,
  code,
  className,
}: {
  text: string;
  code?: ((text: string) => ReactNode) | undefined;
  className?: string | undefined;
}) {
  const components = useMemo(
    () => ({
      table: defaultMdxComponents.table,
      pre,
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
    [code]
  );
  return (
    <div
      className={cx(
        'prose max-w-none text-[13px] leading-relaxed [&_:where(p,ul,ol,blockquote)]:my-2 [&_:where(h1,h2,h3,h4)]:mt-3 [&_:where(h1,h2,h3,h4)]:mb-1.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0',
        className
      )}
    >
      <Render components={components}>{text}</Render>
    </div>
  );
});

export default Markdown;
