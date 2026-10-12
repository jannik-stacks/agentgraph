import type * as PageTree from 'fumadocs-core/page-tree';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { useAtomValue } from 'jotai';
import { type CSSProperties, Suspense, use, useEffect, useState } from 'react';
import { locationAtom } from '../state.ts';
import { CodeLink, DocText, Tokens } from './components.tsx';
import { files, fileText } from './data.ts';
import { type FileMeta, lineHash, summary } from './model.ts';

const paths = Object.keys(files);

const tree: PageTree.Root = (() => {
  const root: PageTree.Root = { name: 'Source', children: [{ type: 'page', name: 'All files', url: '/source' }] };
  const folders = new Map<string, PageTree.Folder>();
  const folderOf = (dir: string): { children: PageTree.Node[] } => {
    if (!dir) return root;
    let folder = folders.get(dir);
    if (!folder) {
      const parent = folderOf(dir.split('/').slice(0, -1).join('/'));
      folder = { type: 'folder', name: dir.split('/').at(-1), children: [], defaultOpen: dir === 'src' };
      folders.set(dir, folder);
      parent.children.push(folder);
    }
    return folder;
  };
  for (const path of paths) {
    const parts = path.split('/');
    folderOf(parts.slice(0, -1).join('/')).children.push({ type: 'page', name: parts.at(-1), url: `/source/${path}` });
  }
  return root;
})();

const parseHash = (hash: string): [number, number] | undefined => {
  const m = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!m) return;
  const a = Number(m[1]);
  const b = Number(m[2] ?? m[1]);
  return [Math.min(a, b), Math.max(a, b)];
};

const useHash = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const sync = () => setHash(location.hash);
    addEventListener('hashchange', sync);
    return () => removeEventListener('hashchange', sync);
  }, []);
  return [hash, (next: string) => (history.replaceState(null, '', next), setHash(next))] as const;
};

const Viewer = ({ meta }: { meta: FileMeta }) => {
  const text = use(fileText(meta.path));
  const [hash, setHash] = useHash();
  const range = parseHash(hash);
  useEffect(() => {
    if (range) document.getElementById(`L${range[0]}`)?.scrollIntoView({ block: 'start' });
  }, [range?.[0], meta.path]);
  const select = (n: number, extend: boolean) =>
    setHash(lineHash(extend && range ? Math.min(range[0], n) : n, extend && range ? Math.max(range[0], n) : n));
  return (
    <figure className="shiki not-prose my-4 overflow-x-auto rounded-xl border bg-fd-card text-[0.8125rem] shadow-sm">
      <pre className="py-3">
        <code className="flex min-w-max flex-col">
          {text.lines.map((_, i) => {
            const n = i + 1;
            const on = range && n >= range[0] && n <= range[1];
            return (
              <span
                key={n}
                id={`L${n}`}
                className={on ? 'flex scroll-mt-28 bg-fd-primary/10' : 'flex scroll-mt-28'}
                style={{ minHeight: '1lh' } as CSSProperties}
              >
                <a
                  href={`#L${n}`}
                  onClick={e => {
                    e.preventDefault();
                    select(n, e.shiftKey);
                  }}
                  className="w-14 shrink-0 select-none pr-4 text-right text-fd-muted-foreground/60 hover:text-fd-primary"
                >
                  {n}
                </a>
                <span className="pr-4 whitespace-pre">
                  <Tokens text={text} line={n} />
                </span>
              </span>
            );
          })}
        </code>
      </pre>
    </figure>
  );
};

const FilePage = ({ meta }: { meta: FileMeta }) => {
  const toc = meta.decls.map(d => ({
    title: <span className="font-mono text-xs">{d.name}</span>,
    url: `#L${d.start}`,
    depth: d.exported ? 2 : 3,
  }));
  useEffect(() => {
    document.title = `${meta.path} | bothub source`;
    return () => void (document.title = 'BHM');
  }, [meta.path]);
  return (
    <DocsPage toc={toc}>
      <DocsTitle className="font-mono text-2xl">{meta.path}</DocsTitle>
      {meta.doc && (
        <DocsDescription>
          <DocText text={meta.doc} />
        </DocsDescription>
      )}
      <Suspense fallback={<p className="text-fd-muted-foreground">Loading.</p>}>
        <Viewer meta={meta} />
      </Suspense>
    </DocsPage>
  );
};

const Index = () => {
  const groups = new Map<string, FileMeta[]>();
  for (const f of Object.values(files)) {
    const dir = f.path.split('/').slice(0, -1).join('/');
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  return (
    <DocsPage>
      <DocsTitle>Source</DocsTitle>
      <DocsDescription>Every file under src and infra, read-only, with the doc comment that opens it.</DocsDescription>
      <DocsBody>
        {[...groups].map(([dir, metas]) => (
          <section key={dir}>
            <h2 className="font-mono">{dir}</h2>
            <ul>
              {metas.map(m => (
                <li key={m.path}>
                  <CodeLink href={`/source/${m.path}`} className="font-mono">
                    {m.path.split('/').at(-1)}
                  </CodeLink>
                  {m.doc && (
                    <span className="text-fd-muted-foreground">
                      {' '}
                      <DocText text={summary(m.doc)!} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </DocsBody>
    </DocsPage>
  );
};

/** `/source` lists every file; `/source/<path>#L10-L24` shows one with those lines marked. */
export default function SourceRoute() {
  const path = useAtomValue(locationAtom).path.split('/').filter(Boolean).slice(1).join('/');
  const meta = path ? files[path] : undefined;
  return (
    <DocsLayout
      tree={tree}
      nav={{ title: 'Source', url: '/source' }}
      themeSwitch={{ enabled: false }}
      searchToggle={{ enabled: false }}
      containerProps={{ style: { '--fd-banner-height': '3rem' } as CSSProperties }}
    >
      {!path ? (
        <Index />
      ) : meta ? (
        <FilePage key={meta.path} meta={meta} />
      ) : (
        <DocsPage>
          <DocsTitle>Not found</DocsTitle>
          <DocsDescription>No source file {path}.</DocsDescription>
        </DocsPage>
      )}
    </DocsLayout>
  );
}
