import { createMarkdownRenderer } from 'fumadocs-core/content/md';
import { remarkGfm } from 'fumadocs-core/mdx-plugins/remark-gfm';
import { type ComponentProps, memo, type ReactNode, useMemo } from 'react';

const { Markdown } = createMarkdownRenderer({ remarkPlugins: [remarkGfm] });

/** Markdown with GitHub extensions. `code` may turn an inline code span into something richer, like a link. */
export default memo(function Prose({ text, code }: { text: string; code?: (text: string) => ReactNode }) {
  const components = useMemo(
    () => ({
      code: ({ children, className, ...props }: ComponentProps<'code'>) =>
        (!className && typeof children === 'string' && code?.(children)) || (
          <code className={className} {...props}>
            {children}
          </code>
        ),
    }),
    [code]
  );
  return (
    <div className="prose max-w-none text-[13px] leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <Markdown components={components}>{text}</Markdown>
    </div>
  );
});
