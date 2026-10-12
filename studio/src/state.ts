import { atom } from 'jotai';
import { atomWithRefresh, unwrap } from 'jotai/utils';
import type { needsHuman, readFiles } from '../../src/api.ts';
import type { Config, ConfigError } from '../../src/config.ts';
import type { Outcome, Run } from '../../src/store.ts';

const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json() as Promise<T>;
};

export const routes = ['studio', 'dashboard'] as const;
export type Route = (typeof routes)[number];

const readLocation = () => ({ path: location.pathname, query: new URLSearchParams(location.search) });

const locationAtom = atom(readLocation());
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

export const studioTabs = ['graph', 'setup'] as const;
export type StudioTab = (typeof studioTabs)[number];
export const studioTabAtom = atom(get => studioTabs.find(tab => tab === get(segments)[1]) ?? 'graph');

const queryParam = (key: string) =>
  atom(
    get => get(locationAtom).query.get(key),
    (_get, set, value: string | null) => set(navigateAtom, { query: { [key]: value } })
  );

export const selectedNodeAtom = queryParam('node');
export const runIdAtom = queryParam('run');
export const statusFilterAtom = queryParam('status');
export const botFilterAtom = queryParam('bot');
export const selectedFileAtom = queryParam('file');
export const sampleAtom = atom(get => get(locationAtom).query.has('sample'));

export const hubAtom = atomWithRefresh(() => getJson<{ config: Config } | { errors: ConfigError[] }>('/api/hub'));

export const filesQueryAtom = atomWithRefresh(() => getJson<Awaited<ReturnType<typeof readFiles>>>('/api/files'));
export const filesAtom = unwrap(filesQueryAtom, previous => previous);

export const runsQueryAtom = atomWithRefresh(() => getJson<Run[]>('/api/runs'));
export const runsAtom = unwrap(runsQueryAtom, previous => previous);

export const needsHumanQueryAtom = atomWithRefresh(() =>
  getJson<Awaited<ReturnType<typeof needsHuman>>>('/api/needs-human')
);
export const needsHumanAtom = unwrap(needsHumanQueryAtom, previous => previous);

export const runDetailQueryAtom = atomWithRefresh(async get => {
  const id = get(runIdAtom);
  return id ? getJson<{ run: Run; outcome: Outcome | null }>(`/api/runs/${encodeURIComponent(id)}`) : null;
});
export const runDetailAtom = unwrap(runDetailQueryAtom, previous => previous ?? null);
