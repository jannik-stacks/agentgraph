import { useAtomValue, useSetAtom } from 'jotai';
import { Component, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { navigateAtom, pageAtom, routes } from './state.ts';
import { AgentgraphLogo } from './icons.tsx';
import { cx, Link, Loading, Tooltip } from './ui.tsx';

const pages = {
  inbox: lazy(() => import('./runs/InboxPage.tsx').then(m => ({ default: m.InboxPage }))),
  graph: lazy(() => import('./graph/GraphPage.tsx').then(m => ({ default: m.GraphPage }))),
  runs: lazy(() => import('./runs/RunsPage.tsx').then(m => ({ default: m.RunsPage }))),
  docs: lazy(() => import('./docs/DocsPage.tsx').then(m => ({ default: m.DocsPage }))),
  bench: lazy(() => import('./bench/BenchPage.tsx').then(m => ({ default: m.BenchPage }))),
  results: lazy(() => import('./results/ResultsPage.tsx').then(m => ({ default: m.ResultsPage }))),
};

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

const base = (dir: string | undefined, parts = 1) => dir?.split('/').filter(Boolean).slice(-parts).join('/');

/** The graph and data directory the dev server reads, by folder name; the full paths on hover. */
const Where = () => {
  const { VITE_AGI_DIR: graph, VITE_AGI_DATA: data } = import.meta.env as Record<string, string | undefined>;
  if (!graph && !data) return null;
  return (
    <Tooltip tip={[graph && `Graph: ${graph}`, data && `Data: ${data}`].filter(Boolean).join('\n')} focusable>
      <dl className="flex min-w-0 items-center gap-3 text-xs text-zinc-500">
        {[
          ['graph', base(graph)],
          ['data', base(data, 2)],
        ].map(([name, dir]) =>
          dir ? (
            <div key={name} className="flex min-w-0 gap-1">
              <dt>{name}</dt>
              <dd className="truncate font-mono text-zinc-700 dark:text-zinc-300">{dir}</dd>
            </div>
          ) : null
        )}
      </dl>
    </Tooltip>
  );
};

export const App = () => {
  const { route } = useAtomValue(pageAtom);
  const Page = route && pages[route];
  const navigate = useSetAtom(navigateAtom);
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
          {routes.map(r => (
            <Link
              key={r}
              href={`/${r}`}
              aria-current={r === route ? 'page' : undefined}
              className={cx(
                'rounded-md px-2 py-0.5 capitalize',
                r === route
                  ? 'bg-white font-medium shadow-sm dark:bg-zinc-700'
                  : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
              )}
            >
              {r}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden min-w-0 md:block">
          <Where />
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Boundary key={route}>
          <Suspense fallback={<Loading />}>{Page && <Page />}</Suspense>
        </Boundary>
      </main>
    </div>
  );
};
