import { Fragment, type ReactNode, useEffect, useState } from 'react';

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

/**
 * The `<code>` element for a block, plain at once and colored in place once shiki has loaded. Render it inside an
 * element with the `shiki` class. Each highlighted block is cached.
 */
export const useHighlighted = (code: string, lang = 'text'): ReactNode => {
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
  return node ?? <PlainLines code={code} />;
};
