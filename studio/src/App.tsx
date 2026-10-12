import { useAtomValue, useSetAtom } from 'jotai';
import { Component, type ReactNode, Suspense, useEffect } from 'react';
import { DashboardView } from './dashboard/DashboardView.tsx';
import { navigateAtom, type Route, routeAtom, routes } from './state.ts';
import { StudioView } from './studio/StudioView.tsx';
import { cx, Muted } from './ui.tsx';

class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError = (error: Error) => ({ error });
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-4">
        <p className="text-red-600 dark:text-red-400">{error.message}</p>
        <button className="mt-2 underline" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

const labels: Record<Route, string> = { studio: 'Studio', dashboard: 'Dashboard' };

const Nav = ({ route }: { route: Route | undefined }) => {
  const navigate = useSetAtom(navigateAtom);
  return (
    <nav className="flex gap-1">
      {routes.map(r => (
        <a
          key={r}
          href={`/${r}`}
          aria-current={r === route ? 'page' : undefined}
          onClick={e => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate({ path: `/${r}` });
          }}
          className={cx(
            'rounded px-2.5 py-1',
            r === route
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
          )}
        >
          {labels[r]}
        </a>
      ))}
    </nav>
  );
};

export const App = () => {
  const route = useAtomValue(routeAtom);
  const navigate = useSetAtom(navigateAtom);
  useEffect(() => {
    if (!route) navigate({ path: '/studio', replace: true });
  }, [route, navigate]);
  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <h1 className="font-semibold" title="bothub manager">
          BHM
        </h1>
        <Nav route={route} />
      </header>
      <main className="min-h-0">
        <Boundary key={route}>
          <Suspense fallback={<Muted>Loading.</Muted>}>
            {route === 'studio' && <StudioView />}
            {route === 'dashboard' && <DashboardView />}
          </Suspense>
        </Boundary>
      </main>
    </div>
  );
};
