import { useAtomValue, useSetAtom } from 'jotai';
import { Component, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { navigateAtom, pageAtom, routes } from './state.ts';
import { Mark } from './icons.tsx';
import { cx, Link, Loading, Tooltip } from './ui.tsx';

const GraphPage = lazy(() => import('./graph/GraphPage.tsx').then(m => ({ default: m.GraphPage })));
const RunsPage = lazy(() => import('./runs/RunsPage.tsx').then(m => ({ default: m.RunsPage })));

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

const DocsPage = lazy(() => import('./docs/DocsPage.tsx').then(m => ({ default: m.DocsPage })));

const BenchPage = lazy(() => import('./bench/BenchPage.tsx').then(m => ({ default: m.BenchPage })));

const CompoundPage = lazy(() => import('./compound/CompoundPage.tsx').then(m => ({ default: m.CompoundPage })));

const labels = { graph: 'Graph', runs: 'Runs', docs: 'Docs', bench: 'Bench', compound: 'Compound' };

const base = (dir: string | undefined, parts = 1) => dir?.split('/').filter(Boolean).slice(-parts).join('/');

/** The hub and data directory the dev server reads, by folder name; the full paths on hover. */
const Where = () => {
  const { VITE_BHM_HUB: hub, VITE_BHM_DATA: data } = import.meta.env as Record<string, string | undefined>;
  if (!hub && !data) return null;
  return (
    <Tooltip tip={[hub && `Hub: ${hub}`, data && `Data: ${data}`].filter(Boolean).join('\n')} focusable>
      <dl className="flex min-w-0 items-center gap-3 text-xs text-zinc-500">
        {[
          ['hub', base(hub)],
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
  const navigate = useSetAtom(navigateAtom);
  useEffect(() => {
    if (!route) navigate({ href: '/runs', replace: true });
  }, [route, navigate]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 sm:gap-5 sm:px-4 dark:border-zinc-800">
        <Link href="/runs" className="inline-flex shrink-0 items-center gap-1.5 font-semibold tracking-tight">
          <Mark className="size-5" />
          bothub
        </Link>
        <nav className="inline-flex gap-0.5 rounded-lg bg-zinc-100 p-0.5 text-[13px] leading-5 dark:bg-zinc-900">
          {routes.map(r => (
            <Link
              key={r}
              href={`/${r}`}
              aria-current={r === route ? 'page' : undefined}
              className={cx(
                'rounded-md px-2 py-0.5',
                r === route
                  ? 'bg-white font-medium shadow-sm dark:bg-zinc-700'
                  : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
              )}
            >
              {labels[r]}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden min-w-0 md:block">
          <Where />
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Boundary key={route}>
          <Suspense fallback={<Loading />}>
            {route === 'graph' && <GraphPage />}
            {route === 'runs' && <RunsPage />}
            {route === 'docs' && <DocsPage />}
            {route === 'bench' && <BenchPage />}
            {route === 'compound' && <CompoundPage />}
          </Suspense>
        </Boundary>
      </main>
    </div>
  );
};
