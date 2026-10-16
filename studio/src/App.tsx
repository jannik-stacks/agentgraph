import { useAtomValue, useSetAtom } from 'jotai';
import { Component, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { StaleApi } from './StaleApi.tsx';
import { navigateAtom, pageAtom, routes } from './state.ts';
import { cx, Link, Muted } from './ui.tsx';

const GraphPage = lazy(() => import('./graph/GraphPage.tsx').then(m => ({ default: m.GraphPage })));
const ViewsPage = lazy(() => import('./graph/views/ViewsPage.tsx').then(m => ({ default: m.ViewsPage })));
const RunsPage = lazy(() => import('./runs/RunsPage.tsx').then(m => ({ default: m.RunsPage })));
const CorePage = lazy(() => import('./runs/CorePage.tsx').then(m => ({ default: m.CorePage })));

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

const labels = { graph: 'Graph', views: 'Views', runs: 'Runs', core: 'Core runs' };

const core = !!import.meta.env.VITE_BHM_CORE;

/** The routes in the header: a core-format hub has only the views and core's runs, v1 hubs everything else. */
export const shown = routes.filter(r => (core ? r === 'views' || r === 'core' : r !== 'core'));

export const App = () => {
  const { route } = useAtomValue(pageAtom);
  const navigate = useSetAtom(navigateAtom);
  useEffect(() => {
    if (!route || !shown.includes(route)) navigate({ href: core ? '/core' : '/runs', replace: true });
  }, [route, navigate]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-4 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <span className="font-semibold">bothub</span>
        <nav className="flex gap-3 text-[13px]">
          {shown.map(r => (
            <Link
              key={r}
              href={`/${r}`}
              aria-current={r === route ? 'page' : undefined}
              className={cx(r === route ? 'font-medium' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100')}
            >
              {labels[r]}
            </Link>
          ))}
        </nav>
      </header>
      {import.meta.env.DEV && <StaleApi />}
      <main className="min-h-0 flex-1">
        <Boundary key={route}>
          <Suspense fallback={<Muted>Loading.</Muted>}>
            {route === 'graph' && <GraphPage />}
            {route === 'views' && <ViewsPage />}
            {route === 'runs' && <RunsPage />}
            {route === 'core' && <CorePage />}
          </Suspense>
        </Boundary>
      </main>
    </div>
  );
};
