import { atom } from 'jotai';
import type { CoreRun } from './runs/trace.ts';

export const routes = ['graph', 'runs', 'docs', 'bench', 'compound'] as const;
const readLocation = () => ({ path: location.pathname, query: new URLSearchParams(location.search) });

/** The current location; tests set it. @public */
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

/** The route: `/graph`, `/runs[/<id>]`, `/docs[/<page>]`, `/bench` or `/compound`. */
export const pageAtom = atom(get => {
  const [page, id] = get(locationAtom).path.split('/').filter(Boolean);
  if (page === 'graph') return { route: 'graph' as const, run: null };
  if (page === 'runs') return { route: 'runs' as const, run: id ? decodeURIComponent(id) : null };
  if (page === 'bench') return { route: 'bench' as const, run: null };
  if (page === 'compound') return { route: 'compound' as const, run: null };
  if (page === 'docs') return { route: 'docs' as const, run: id ? decodeURIComponent(id) : null };
  return { route: undefined, run: null };
});

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

/** The step selected on the graph, as `workflow/step`. */
export const selectedStepAtom = queryParam('step');

/** Answers `path` as JSON while something reads it, and again whenever the server reports the data dir changed. */
export const live = <T>(path: string) => {
  const value = atom<{ value?: T; failure?: string }>({});
  value.onMount = set => {
    const load = () =>
      fetch(path)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${path} answered ${r.status}`))))
        .then(
          v => set({ value: v as T }),
          (e: Error) => set(previous => ({ ...previous, failure: e.message }))
        );
    const events = new EventSource('/core/events');
    events.onmessage = load;
    events.onopen = load;
    return () => events.close();
  };
  return value;
};

/** Every run of the served hub, with its trace, every text in it cut short. */
export const runsAtom = live<CoreRun[]>('/core/runs');
