import { useAtomValue } from 'jotai';
import { Markdown } from '../Markdown.tsx';
import { pageAtom } from '../state.ts';
import { cx, Link, Muted } from '../ui.tsx';

const files = import.meta.glob<string>('../../../docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const pages = Object.fromEntries(Object.entries(files).map(([path, text]) => [/([^/]+)\.md$/.exec(path)![1]!, text]));

/** Index first, then in the order the index links the pages, then the rest alphabetically. */
const names = (() => {
  const linked = [...(pages.index ?? '').matchAll(/\]\(([\w-]+)\.md\)/g)].map(m => m[1]!);
  const rest = Object.keys(pages).filter(n => n !== 'index' && !linked.includes(n));
  return ['index', ...linked, ...rest.sort()].filter(n => n in pages);
})();

const title = (name: string) => /^# (.+)$/m.exec(pages[name]!)?.[1] ?? name;

export const DocsPage = () => {
  const { run: name } = useAtomValue(pageAtom);
  const text = name ? pages[name] : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav className="max-h-32 shrink-0 overflow-y-auto border-b md:max-h-none md:w-48 md:border-r md:border-b-0 border-zinc-200 p-3 text-[13px] dark:border-zinc-800">
        {names.map(n => (
          <Link
            key={n}
            href={`/docs/${n}`}
            className={cx(
              'block py-0.5',
              n === (name ?? 'index') ? 'font-medium' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
            )}
          >
            {title(n)}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {name && !text ? (
          <Muted>No docs page named {name}.</Muted>
        ) : (
          <Markdown text={text ?? pages.index ?? ''} className="max-w-3xl" />
        )}
      </div>
    </div>
  );
};
