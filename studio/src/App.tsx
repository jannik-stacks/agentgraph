import { useAtomValue, useSetAtom } from 'jotai';
import { Component, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { connectedAtom, navigateAtom, pageAtom } from './state.ts';
import { AgentgraphLogo } from './icons.tsx';
import { pages as declared } from 'virtual:agentgraph-pages';
import { accent, cx, Link, Loading } from './ui.tsx';

const pages = {
  inbox: lazy(() => import('./runs/InboxPage.tsx').then(m => ({ default: m.InboxPage }))),
  graph: lazy(() => import('./graph/GraphPage.tsx').then(m => ({ default: m.GraphPage }))),
  runs: lazy(() => import('./runs/RunsPage.tsx').then(m => ({ default: m.RunsPage }))),
  docs: lazy(() => import('./docs/DocsPage.tsx').then(m => ({ default: m.DocsPage }))),
};

const nav = [
  ...(['inbox', 'graph', 'runs'] as const).map(r => ({ href: `/${r}`, title: r })),
  ...declared,
  { href: '/docs', title: 'docs' },
];

const plugins = new Map(declared.map(page => [page.href, lazy(page.load)]));

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError = (error: Error) => ({ error });
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-4">
        <p>{error.message}</p>
        <button className="mt-2 underline" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

export const App = () => {
  const { route, id } = useAtomValue(pageAtom);
  const here = route === 'plugins' ? `/plugins/${id ?? ''}` : `/${route ?? ''}`;
  const Page =
    plugins.get(here) ?? (route && Object.hasOwn(pages, route) ? pages[route as keyof typeof pages] : undefined);
  const navigate = useSetAtom(navigateAtom);
  const connected = useAtomValue(connectedAtom);
  useEffect(() => {
    if (!route) navigate({ href: '/runs', replace: true });
  }, [route, navigate]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 sm:gap-5 sm:px-4 dark:border-zinc-800">
        <Link href="/runs" className="inline-flex shrink-0 items-center gap-1.5 font-semibold tracking-tight">
          <AgentgraphLogo className="size-5" />
          agentgraph
        </Link>
        <nav className="inline-flex min-w-0 gap-0.5 overflow-x-auto rounded-lg bg-zinc-100 p-0.5 text-[13px] leading-5 dark:bg-zinc-900">
          {nav.map(({ href, title }) => (
            <Link
              key={href}
              href={href}
              aria-current={href === here ? 'page' : undefined}
              className={cx(
                'rounded-md px-2 py-0.5 capitalize',
                href === here
                  ? 'bg-white font-medium shadow-sm dark:bg-zinc-700'
                  : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
              )}
            >
              {title}
            </Link>
          ))}
        </nav>
        {!connected && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-zinc-500" role="status">
            <span className={cx('size-2 rounded-full bg-current', accent.text)} />
            server unreachable, waiting to reload
          </span>
        )}
      </header>
      <main className="min-h-0 flex-1">
        <Boundary key={`${route}/${id ?? ''}`}>
          <Suspense fallback={<Loading />}>{Page ? <Page /> : <p className="p-4">Page not found.</p>}</Suspense>
        </Boundary>
      </main>
    </div>
  );
};
