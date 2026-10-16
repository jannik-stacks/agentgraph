import { useAtomValue, useSetAtom } from 'jotai';
import { Component, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { navigateAtom, pageAtom, routes } from './state.ts';
import { cx, Link, Muted } from './ui.tsx';

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

const labels = { graph: 'Graph', runs: 'Runs', docs: 'Docs' };

export const App = () => {
  const { route } = useAtomValue(pageAtom);
  const navigate = useSetAtom(navigateAtom);
  useEffect(() => {
    if (!route) navigate({ href: '/runs', replace: true });
  }, [route, navigate]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-4 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <span className="font-semibold">bothub</span>
        <nav className="flex gap-3 text-[13px]">
          {routes.map(r => (
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
      <main className="min-h-0 flex-1">
        <Boundary key={route}>
          <Suspense fallback={<Muted>Loading.</Muted>}>
            {route === 'graph' && <GraphPage />}
            {route === 'runs' && <RunsPage />}
            {route === 'docs' && <DocsPage />}
          </Suspense>
        </Boundary>
      </main>
    </div>
  );
};
