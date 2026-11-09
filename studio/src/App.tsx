import { useAtomValue, useSetAtom } from 'jotai';
import { Component, lazy, type ReactNode, Suspense, useEffect } from 'react';
import { connectedAtom, dataParam, instances, navigateAtom, pageAtom, shown, studioPages } from './state.ts';
import { AgentgraphLogo } from './icons.tsx';
import { pages as declared } from 'virtual:agentgraph-pages';
import { accent, Button, cx, Link, Loading, Muted, Select } from './ui.tsx';

const pages = {
  graph: lazy(() => import('./graph/GraphPage.tsx').then(m => ({ default: m.GraphPage }))),
  runs: lazy(() => import('./runs/RunsPage.tsx').then(m => ({ default: m.RunsPage }))),
  docs: lazy(() => import('./docs/DocsPage.tsx').then(m => ({ default: m.DocsPage }))),
};

const instance = shown?.name ?? '';

const across = instances.length > 0 && !shown;

const own = declared.filter(page => page.instance === instance);

const custom = own.filter(page => !page.builtin);

const official = [
  ...(['graph', 'runs'] as const).map(r => ({ href: `/${r}`, title: r })),
  ...own.filter(page => page.builtin),
  { href: '/docs', title: 'docs' },
];

const NavTabs = ({
  label,
  links,
  here,
  className,
  reload,
}: {
  label: string;
  links: readonly { href: string; title: string }[];
  here: string;
  className: string;
  reload?: boolean;
}) => {
  const Anchor = reload ? 'a' : Link;
  return (
    <nav
      aria-label={label}
      className={cx('inline-flex min-w-0 gap-0.5 overflow-x-auto rounded-lg p-0.5 text-[13px] leading-5', className)}
    >
      {links.map(({ href, title }) => (
        <Anchor
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
        </Anchor>
      ))}
    </nav>
  );
};

const plugins = new Map([...own, ...(instance ? [] : studioPages)].map(page => [page.href, lazy(page.load)]));

const Unknown = () => (
  <Muted>
    This studio serves no instance named {location.pathname.split('/')[1]}. Open{' '}
    {instances.map(({ name }, i) => (
      <span key={name}>
        {i > 0 && ', '}
        <a className="underline" href={`/${name}/runs`}>
          {name}
        </a>
      </span>
    ))}
    .
  </Muted>
);

class Boundary extends Component<{ children: ReactNode }, { error?: Error | undefined }> {
  override state: { error?: Error | undefined } = {};
  static getDerivedStateFromError = (error: Error) => ({ error });
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-4">
        <p>{error.message}</p>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => this.setState({ error: undefined })}>Try again</Button>
          <Button onClick={() => location.reload()}>Reload</Button>
        </div>
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
  const data = useAtomValue(dataParam);
  const unknown = across && route !== 'plugins' && !(route === 'runs' && id && data);
  useEffect(() => {
    if (unknown && location.pathname === '/') location.replace(`/${instances[0]!.name}/runs`);
    else if (!route && !unknown) navigate({ href: '/runs', replace: true });
  }, [route, navigate, unknown]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 sm:gap-5 sm:px-4 dark:border-zinc-800">
        <Link
          href={across ? '/' : '/runs'}
          className="inline-flex shrink-0 items-center gap-1.5 font-semibold tracking-tight"
        >
          <AgentgraphLogo className="size-5" />
          agentgraph
        </Link>
        {!across && <NavTabs label="Pages" links={official} here={here} className="bg-zinc-100 dark:bg-zinc-900" />}
        {custom.length > 0 && (
          <NavTabs
            label="Plugin pages"
            links={custom}
            here={here}
            className="border border-dashed border-zinc-300 dark:border-zinc-700"
          />
        )}
        {studioPages.length > 0 && (
          <NavTabs
            label="Studio pages"
            links={studioPages}
            here={instance ? '' : here}
            reload={!!instance}
            className="border border-zinc-200 dark:border-zinc-800"
          />
        )}
        {(instances.length > 1 || across) && (
          <Select
            label="Instance"
            value={shown?.name ?? ''}
            options={[
              ...(across ? [{ value: '', label: 'all instances' }] : []),
              ...instances.map(({ name }) => ({ value: name, label: name })),
            ]}
            onChange={name => location.assign(`/${name}/${route === 'plugins' ? 'runs' : (route ?? 'runs')}`)}
          />
        )}
        {!connected && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-zinc-500" role="status">
            <span className={cx('size-2 rounded-full bg-current', accent.text)} />
            server unreachable, waiting to reload
          </span>
        )}
      </header>
      <main className="min-h-0 flex-1">
        <Boundary key={`${route}/${id ?? ''}`}>
          <Suspense fallback={<Loading />}>
            {unknown ? <Unknown /> : Page ? <Page /> : <p className="p-4">Page not found.</p>}
          </Suspense>
        </Boundary>
      </main>
    </div>
  );
};
