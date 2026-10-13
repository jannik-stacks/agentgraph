import { atom } from 'jotai';
import { atomWithRefresh, unwrap } from 'jotai/utils';
import type { needsHuman, readFiles } from '../../src/api.ts';
import type { Config, ConfigError } from '../../src/config.ts';

const last = new Map<string, { text: string; value: unknown }>();

/** Fetches JSON, answering with the previous value when the response text has not changed. */
const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  const text = await response.text();
  const previous = last.get(path);
  if (previous?.text === text) return previous.value as T;
  const value = JSON.parse(text) as T;
  last.set(path, { text, value });
  return value;
};

export const routes = ['studio', 'dashboard', 'docs'] as const;
export type Route = (typeof routes)[number];

const readLocation = () => ({ path: location.pathname, query: new URLSearchParams(location.search) });

export const locationAtom = atom(readLocation());
locationAtom.onMount = set => {
  const sync = () => set(readLocation());
  addEventListener('popstate', sync);
  return () => removeEventListener('popstate', sync);
};

/** Pushes or replaces a history entry. `query` is merged into the current query string unless the path changes. */
export const navigateAtom = atom(
  null,
  (get, set, to: { path?: string; query?: Record<string, string | null>; replace?: boolean }) => {
    const current = get(locationAtom);
    const path = to.path ?? current.path;
    const query = new URLSearchParams(path === current.path ? current.query : undefined);
    for (const [key, value] of Object.entries(to.query ?? {})) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    const search = query.size ? `?${query}` : '';
    history[to.replace ? 'replaceState' : 'pushState'](null, '', `${path}${search}`);
    set(locationAtom, readLocation());
  }
);

const segments = atom(get => get(locationAtom).path.split('/').filter(Boolean));
export const routeAtom = atom(get => routes.find(route => route === get(segments)[0]));

export const studioTabs = ['graph', 'notes', 'setup', 'lab'] as const;
export type StudioTab = (typeof studioTabs)[number];
export const studioTabAtom = atom(get => studioTabs.find(tab => tab === get(segments)[1]) ?? 'graph');

export const docsSlugAtom = atom(get => get(segments).slice(1));

/** The dashboard page: the run list, one run's page at `/dashboard/runs/<id>`, or `/dashboard/follow`. */
export const dashboardPageAtom = atom(get => {
  const [, page, id] = get(segments);
  if (page === 'runs' && id) return { run: decodeURIComponent(id) };
  if (page === 'follow') return { follow: true as const };
  return {};
});

const queryParam = (key: string) =>
  atom(
    get => get(locationAtom).query.get(key),
    (_get, set, value: string | null) => set(navigateAtom, { query: { [key]: value } })
  );

export const selectedNodeAtom = queryParam('node');
export const runIdAtom = queryParam('run');
export const statusFilterAtom = queryParam('status');
export const botFilterAtom = queryParam('bot');
export const sinceFilterAtom = queryParam('since');
export const sortAtom = queryParam('sort');
export const selectedFileAtom = queryParam('file');
export const editPathAtom = queryParam('edit');
export const sampleAtom = atom(get => get(locationAtom).query.has('sample'));

export const hubAtom = atomWithRefresh(() => getJson<{ config: Config } | { errors: ConfigError[] }>('/api/hub'));

export const filesQueryAtom = atomWithRefresh(() => getJson<Awaited<ReturnType<typeof readFiles>>>('/api/files'));
export const filesAtom = unwrap(filesQueryAtom, previous => previous);

export const needsHumanQueryAtom = atomWithRefresh(() =>
  getJson<Awaited<ReturnType<typeof needsHuman>>>('/api/needs-human')
);
export const needsHumanAtom = unwrap(needsHumanQueryAtom, previous => previous);
