import { type Atom, atom } from 'jotai';
import { atomWithRefresh, unwrap } from 'jotai/utils';
import type { ApiInfo } from '../../src/api.ts';
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

export const routes = ['graph', 'views', 'runs'] as const;
const readLocation = () => ({ path: location.pathname, query: new URLSearchParams(location.search) });

export const locationAtom = atom(readLocation());
locationAtom.onMount = set => {
  const sync = () => set(readLocation());
  addEventListener('popstate', sync);
  return () => removeEventListener('popstate', sync);
};

/** Pushes or replaces a history entry. */
export const navigateAtom = atom(null, (_get, set, to: { href: string; replace?: boolean }) => {
  history[to.replace ? 'replaceState' : 'pushState'](null, '', to.href);
  set(locationAtom, readLocation());
});

const segments = atom(get => get(locationAtom).path.split('/').filter(Boolean));

/**
 * The page: the graph at `/graph`, the graph views over core's fixtures at `/views`, the run list at `/runs` with one
 * run at `/runs/<id>`, and the merge requests at `/pulls` with one at `/pulls/<n>`. Merge requests sit under the runs
 * route.
 */
export const pageAtom = atom(get => {
  const [page, id] = get(segments);
  if (page === 'graph') return { route: 'graph' as const };
  if (page === 'views') return { route: 'views' as const };
  if (page === 'runs') return { route: 'runs' as const, run: id ? decodeURIComponent(id) : null };
  if (page === 'pulls') return { route: 'runs' as const, pull: id && /^\d+$/.test(id) ? Number(id) : null };
  return { route: undefined };
});

/** The selected run, at `/runs/<id>`. */
export const runIdAtom = atom(
  get => {
    const page = get(pageAtom);
    return 'run' in page ? page.run : null;
  },
  (get, set, id: string | null) => {
    const query = get(locationAtom).query;
    const path = id ? `/runs/${encodeURIComponent(id)}` : '/runs';
    set(navigateAtom, { href: query.size ? `${path}?${query}` : path });
  }
);

/** One query parameter of the location, written in place. */
export const queryParam = (key: string) =>
  atom(
    get => get(locationAtom).query.get(key),
    (get, set, value: string | null) => {
      const { path, query } = get(locationAtom);
      const next = new URLSearchParams(query);
      if (value === null) next.delete(key);
      else next.set(key, value);
      set(navigateAtom, { href: next.size ? `${path}?${next}` : path, replace: true });
    }
  );

/** The step selected on the graph, as `workflow/job`. */
export const selectedStepAtom = queryParam('step');

/** The run list's status filter. */
export const statusFilterAtom = queryParam('status');

/** A server read: suspends until `path` answers, throws when it fails, and fetches again when written. */
export const apiAtom = <T>(path: string) => atomWithRefresh(() => getJson<T>(path));

/** The last answer of an `apiAtom` without suspending: `fallback` while it first loads or when it fails. */
export const latest = <T, F>(query: Atom<Promise<T>>, fallback: F) =>
  unwrap(
    atom(get => get(query).catch(() => fallback)),
    previous => previous ?? fallback
  );

export const hubAtom = apiAtom<{ config: Config } | { errors: ConfigError[] }>('/api/hub');

export const infoAtom = latest(apiAtom<ApiInfo>('/api/info'), null);
