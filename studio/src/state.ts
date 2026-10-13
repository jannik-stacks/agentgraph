import { type Atom, atom, type Getter, type Setter } from 'jotai';
import { atomWithRefresh, atomWithStorage, createJSONStorage, unwrap } from 'jotai/utils';
import type { ApiInfo, needsHuman, readFiles } from '../../src/api.ts';
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

type To = { path?: string; query?: Record<string, string | null> };

/** The URL `to` leads to from `current`: `query` is merged into the current query string unless the path changes. */
const urlFor = (current: ReturnType<typeof readLocation>, to: To) => {
  const path = to.path ?? current.path;
  const query = new URLSearchParams(path === current.path ? current.query : undefined);
  for (const [key, value] of Object.entries(to.query ?? {})) {
    if (value === null) query.delete(key);
    else query.set(key, value);
  }
  return query.size ? `${path}?${query}` : path;
};

/** Turns a navigation into the URL it leads to from here, for links. */
export const hrefAtom = atom(get => {
  const current = get(locationAtom);
  return (to: To) => urlFor(current, to);
});

/** Pushes or replaces a history entry, to `href` or to where `path` and `query` lead from here. */
export const navigateAtom = atom(null, (get, set, to: To & { href?: string; replace?: boolean }) => {
  history[to.replace ? 'replaceState' : 'pushState'](null, '', to.href ?? urlFor(get(locationAtom), to));
  set(locationAtom, readLocation());
});

const segments = atom(get => get(locationAtom).path.split('/').filter(Boolean));
export const routeAtom = atom(get => routes.find(route => route === get(segments)[0]));

export const studioTabs = ['graph', 'notes', 'setup'] as const;
export type StudioTab = (typeof studioTabs)[number];
export const studioTabAtom = atom(get => studioTabs.find(tab => tab === get(segments)[1]) ?? 'graph');

export const docsSlugAtom = atom(get => get(segments).slice(1));

/**
 * The dashboard page: the run list, one run at `/dashboard/runs/<id>`, one event and its jobs at
 * `/dashboard/events/<id>`, `/dashboard/follow`, or the merge requests at `/dashboard/pulls` and one of them at
 * `/dashboard/pulls/<n>`.
 */
export const dashboardPageAtom = atom(get => {
  const [, page, id] = get(segments);
  if (page === 'runs' && id) return { run: decodeURIComponent(id) };
  if (page === 'events' && id) return { event: decodeURIComponent(id) };
  if (page === 'follow') return { follow: true as const };
  if (page === 'pulls') return { pulls: id && /^\d+$/.test(id) ? Number(id) : null };
  return {};
});

const queryParam = (key: string) =>
  atom(
    get => get(locationAtom).query.get(key),
    (_get, set, value: string | null) => set(navigateAtom, { query: { [key]: value } })
  );

/** Selects what sits under `/dashboard/<page>/`, keeping the list's filters. */
const selectAt = (page: string) => (get: Getter, set: Setter, id: string | null, replace?: boolean) => {
  const query = new URLSearchParams(get(locationAtom).query);
  query.delete('run');
  const path = id ? `/dashboard/${page}/${encodeURIComponent(id)}` : '/dashboard';
  set(navigateAtom, { href: query.size ? `${path}?${query}` : path, replace: !!replace });
};

/** The selected run, at `/dashboard/runs/<id>`. */
export const runIdAtom = atom(get => get(dashboardPageAtom).run ?? null, selectAt('runs'));

/** The selected event, at `/dashboard/events/<id>`. */
export const eventIdAtom = atom(get => get(dashboardPageAtom).event ?? null, selectAt('events'));

/** Local storage that answers nothing and keeps nothing where the browser refuses it. */
const local = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

/** A preference of this viewer, kept in this browser. */
const preference = <T>(key: string, initial: T) =>
  atomWithStorage(
    key,
    initial,
    createJSONStorage<T>(() => local),
    { getOnInit: true }
  );

/** Whether a selected run takes the whole page instead of sitting beside the run list. */
export const runPageAtom = preference('bhm.dashboard.run-page', false);

export const runViews = ['pane', 'modal'] as const;

/** Where a selected run or event opens: in the pane beside the run list, or in a dialog over it. */
export const runViewAtom = preference<(typeof runViews)[number]>('bhm.dashboard.view', 'pane');

export const selectedNodeAtom = queryParam('node');
export const statusFilterAtom = queryParam('status');
export const botFilterAtom = queryParam('bot');
export const sinceFilterAtom = queryParam('since');
export const sortAtom = queryParam('sort');
export const selectedFileAtom = queryParam('file');
export const editPathAtom = queryParam('edit');
export const listKindAtom = queryParam('list');

/** A server read: suspends until `path` answers, throws when it fails, and fetches again when written. */
export const apiAtom = <T>(path: string) => atomWithRefresh(() => getJson<T>(path));

/** The last answer of an `apiAtom` without suspending: `fallback` while it first loads or when it fails. */
export const latest = <T, F>(query: Atom<Promise<T>>, fallback: F) =>
  unwrap(
    atom(get => get(query).catch(() => fallback)),
    previous => previous ?? fallback
  );

export const hubAtom = apiAtom<{ config: Config } | { errors: ConfigError[] }>('/api/hub');

export const filesQueryAtom = apiAtom<Awaited<ReturnType<typeof readFiles>>>('/api/files');
export const filesAtom = latest(filesQueryAtom, undefined);

export const needsHumanQueryAtom = apiAtom<Awaited<ReturnType<typeof needsHuman>>>('/api/needs-human');
export const needsHumanAtom = latest(needsHumanQueryAtom, undefined);

export const infoQueryAtom = apiAtom<ApiInfo>('/api/info');
export const infoAtom = latest(infoQueryAtom, null);
