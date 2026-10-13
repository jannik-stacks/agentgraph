import { useAtomValue, useSetAtom } from 'jotai';
import { Component, type ComponentType, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { Logo } from './Logo.tsx';
import { Link } from './Providers.tsx';
import { StaleApi } from './StaleApi.tsx';
import { infoAtom, navigateAtom, type Route, routeAtom, routes } from './state.ts';
import { cx, Muted, Segmented, Tooltip } from './ui.tsx';

const StudioView = lazy(() => import('./studio/StudioView.tsx').then(m => ({ default: m.StudioView })));
const DashboardView = lazy(() => import('./dashboard/DashboardView.tsx').then(m => ({ default: m.DashboardView })));

let Docs: ComponentType | undefined;
const loadDocs = () => import('./docs/DocsView.tsx').then(m => (Docs = m.default));
const LazyDocs = lazy(() => loadDocs().then(() => ({ default: Docs! })));
if (typeof requestIdleCallback === 'function') requestIdleCallback(() => void loadDocs());
else setTimeout(() => void loadDocs(), 1);
const DocsView = () => (Docs ? <Docs /> : <LazyDocs />);

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
  <nav>
    <Segmented
      options={routes}
      value={route}
      label={r => labels[r]}
      href={r => `/${r}`}
      className="text-[13px] leading-5"
    />
  </nav>
);

const hubDir: string | undefined = import.meta.env.VITE_BHM_HUB;
const dataDir: string | undefined = import.meta.env.VITE_BHM_DATA;
const base = (dir: string) => dir.split('/').filter(Boolean).at(-1) ?? dir;

/**
 * The hub and data directory the API serves, as `/api/info` reports them, so a page answered by another server
 * shows it. Before the API answers, the directories this page was started with.
 */
const Where = () => {
  const info = useAtomValue(infoAtom);
  const hub = info?.hub ?? hubDir;
  const data = info?.data ?? dataDir;
  if (!hub && !data) return null;
  const other = info && dataDir && info.data !== dataDir;
  const tip = [
    hub && `Hub: ${hub}`,
    data && `Data: ${data}`,
    info?.dataReal && info.dataReal !== info.data && `which is ${info.dataReal}`,
    info && `API process ${info.pid}`,
    other && `This page was started for ${dataDir}, but the API serves another data directory`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <Tooltip tip={tip} focusable className="ml-auto hidden md:flex">
      <dl className={cx('flex min-w-0 items-center gap-3 text-xs', other ? 'text-amber-600' : 'text-zinc-500')}>
        {[
          ['hub', hub],
          ['data', info?.dataReal ?? data],
        ].map(([name, dir]) =>
          dir ? (
            <div key={name} className="flex min-w-0 gap-1">
              <dt>{name}</dt>
              <dd className="truncate font-mono text-zinc-700 dark:text-zinc-300">{base(dir)}</dd>
            </div>
          ) : null
        )}
      </dl>
    </Tooltip>
  );
};

const Header = ({ route }: { route: Route | undefined }) => (
  <header className="sticky top-0 z-40 flex h-12 items-center gap-3 border-b border-zinc-200 bg-white/90 px-3 backdrop-blur sm:gap-5 sm:px-4 dark:border-zinc-800 dark:bg-zinc-950/90">
    <Link href="/studio" title="bothub manager" className="shrink-0 text-zinc-900 dark:text-zinc-100">
      <Logo />
    </Link>
    <Nav route={route} />
    {import.meta.env.DEV && <Where />}
  </header>
);

export const App = () => {
  const route = useAtomValue(routeAtom);
  const navigate = useSetAtom(navigateAtom);
  useEffect(() => {
    if (!route) navigate({ path: '/studio', replace: true });
  }, [route, navigate]);
  return (
    <div className="min-h-full">
      <Header route={route} />
      {import.meta.env.DEV && <StaleApi />}
      <main className={route === 'docs' ? undefined : 'h-[calc(100dvh-3rem)] min-h-0'}>
        <Boundary key={route}>
          <Suspense fallback={<Muted>Loading.</Muted>}>
            {route === 'studio' && <StudioView />}
            {route === 'dashboard' && <DashboardView />}
            {route === 'docs' && <DocsView />}
          </Suspense>
        </Boundary>
      </main>
    </div>
  );
};
