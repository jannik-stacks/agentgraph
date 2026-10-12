import { useAtomValue, useSetAtom } from 'jotai';
import { Component, type ComponentType, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { DashboardView } from './dashboard/DashboardView.tsx';
import { Logo } from './Logo.tsx';
import { Link } from './Providers.tsx';
import { labAtom, navigateAtom, type Route, routeAtom, routes } from './state.ts';
import { StudioView } from './studio/StudioView.tsx';
import { cx, Muted } from './ui.tsx';

let Docs: ComponentType | undefined;
const loadDocs = () => import('./docs/DocsView.tsx').then(m => (Docs = m.default));
const LazyDocs = lazy(() => loadDocs().then(() => ({ default: Docs! })));
if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void loadDocs());
else setTimeout(() => void loadDocs(), 1);
const DocsView = () => (Docs ? <Docs /> : <LazyDocs />);
const LabView = lazy(() => import('./lab/LabView.tsx'));

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

const labels: Record<Route, string> = { studio: 'Studio', dashboard: 'Dashboard', docs: 'Docs' };

const Nav = ({ route }: { route: Route | undefined }) => (
  <nav className="flex gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900">
    {routes.map(r => (
      <Link
        key={r}
        href={`/${r}`}
        aria-current={r === route ? 'page' : undefined}
        className={cx(
          'rounded-md px-2.5 py-1 text-[13px] leading-5 transition-colors',
          r === route
            ? 'bg-white font-medium text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white'
            : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
        )}
      >
        {labels[r]}
      </Link>
    ))}
  </nav>
);

const hubDir: string | undefined = import.meta.env.VITE_BHM_HUB;
const dataDir: string | undefined = import.meta.env.VITE_BHM_DATA;
const base = (dir: string) => dir.split('/').filter(Boolean).at(-1) ?? dir;

const Where = () =>
  hubDir || dataDir ? (
    <dl className="ml-auto hidden min-w-0 items-center gap-3 text-xs text-zinc-500 md:flex">
      {[
        ['hub', hubDir],
        ['data', dataDir],
      ].map(([name, dir]) =>
        dir ? (
          <div key={name} className="flex min-w-0 gap-1" title={dir}>
            <dt>{name}</dt>
            <dd className="truncate font-mono text-zinc-700 dark:text-zinc-300">{base(dir)}</dd>
          </div>
        ) : null
      )}
    </dl>
  ) : null;

const Header = ({ route }: { route: Route | undefined }) => (
  <header className="sticky top-0 z-40 flex h-12 items-center gap-3 border-b border-zinc-200 bg-white/90 px-3 backdrop-blur sm:gap-5 sm:px-4 dark:border-zinc-800 dark:bg-zinc-950/90">
    <Link href="/studio" title="bothub manager" className="shrink-0 text-zinc-900 dark:text-zinc-100">
      <Logo />
    </Link>
    <Nav route={route} />
    <Where />
  </header>
);

export const App = () => {
  const route = useAtomValue(routeAtom);
  const lab = useAtomValue(labAtom);
  const navigate = useSetAtom(navigateAtom);
  useEffect(() => {
    if (!route) navigate({ path: '/studio', replace: true });
  }, [route, navigate]);
  return (
    <div className="min-h-full">
      <Header route={route} />
      <main className={route === 'docs' ? undefined : 'h-[calc(100dvh-3rem)] min-h-0'}>
        <Boundary key={route}>
          <Suspense fallback={<Muted>Loading.</Muted>}>
            {route === 'studio' && (lab ? <LabView /> : <StudioView />)}
            {route === 'dashboard' && <DashboardView />}
            {route === 'docs' && <DocsView />}
          </Suspense>
        </Boundary>
      </main>
    </div>
  );
};
