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

/** The sidebar: the index, then each index section with the pages it links, then the rest alphabetically. */
const sections = (() => {
  const out: { label: string; names: string[] }[] = [{ label: '', names: ['index'] }];
  const seen = new Set(['index']);
  for (const line of (pages.index ?? '').split('\n')) {
    const heading = /^## (.+)$/.exec(line)?.[1];
    if (heading) out.push({ label: heading, names: [] });
    for (const m of line.matchAll(/\]\(([\w-]+)\.md\)/g)) {
      const n = m[1]!;
      if (!(n in pages) || seen.has(n)) continue;
      seen.add(n);
      out.at(-1)!.names.push(n);
    }
  }
  out.push({
    label: 'More',
    names: Object.keys(pages)
      .filter(n => !seen.has(n))
      .sort(),
  });
  return out.filter(s => s.names.length > 0);
})();

const title = (name: string) => /^# (.+)$/m.exec(pages[name]!)?.[1] ?? name;

export const DocsPage = () => {
  const { id: name } = useAtomValue(pageAtom);
  const text = name ? pages[name] : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <nav className="max-h-32 shrink-0 overflow-y-auto border-b md:max-h-none md:w-48 md:border-r md:border-b-0 border-zinc-200 p-3 text-[13px] dark:border-zinc-800">
        {sections.map(s => (
          <div key={s.label} className="mb-3">
            {s.label && (
              <div className="py-0.5 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">{s.label}</div>
            )}
            {s.names.map(n => (
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
          </div>
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
