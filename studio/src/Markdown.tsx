import { createMarkdownRenderer } from 'fumadocs-core/content/md';
import { remarkGfm } from 'fumadocs-core/mdx-plugins/remark-gfm';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { type ComponentProps, type CSSProperties, memo, type ReactElement, type ReactNode, useMemo } from 'react';
import { useHighlighted } from './source/highlight.tsx';
import { cx } from './ui.tsx';

const { Markdown: Render } = createMarkdownRenderer({ remarkPlugins: [remarkGfm] });

const compact = { '--padding-left': 'calc(var(--spacing) * 3)' } as CSSProperties;

/** A code block in the docs' style, colored in place once shiki has loaded. */
export const Code = memo(function Code({
  code,
  lang = 'text',
  className,
}: {
  code: string;
  lang?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <CodeBlock
      className={cx('my-2 rounded-md shadow-none', className)}
      style={compact}
      viewportProps={{ className: 'py-2 text-[11.5px] leading-[1.6] max-h-96' }}
    >
      <Pre>{useHighlighted(code, lang)}</Pre>
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
 * Markdown the way the docs render it: GitHub extensions, the docs' prose styles and code blocks, the whole prose scaled
 * down for panels so inline code, links, lists and headings keep the docs' proportions.
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
        'prose max-w-none [--tw-prose-size:0.8125] [&_:where(p,ul,ol,blockquote)]:my-2 [&_:where(h1,h2,h3,h4)]:mt-3 [&_:where(h1,h2,h3,h4)]:mb-1.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0',
        className
      )}
    >
      <Render components={components}>{text}</Render>
    </div>
  );
});

export default Markdown;
