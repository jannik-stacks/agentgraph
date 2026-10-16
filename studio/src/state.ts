import { atom } from 'jotai';
import type { CoreRun } from './runs/trace.ts';

export const routes = ['graph', 'runs'] as const;
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

/** The route: `/graph` or `/runs[/<id>]`. */
export const pageAtom = atom(get => {
  const [page, id] = get(locationAtom).path.split('/').filter(Boolean);
  if (page === 'graph') return { route: 'graph' as const, run: null };
  if (page === 'runs') return { route: 'runs' as const, run: id ? decodeURIComponent(id) : null };
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

/**
 * Answers `path` as JSON while something reads it: again every few seconds while the tab is visible and `again` holds
 * for the last answer.
 */
export const polled = <T>(path: string, again: (value: T) => boolean = () => true) => {
  const value = atom<{ value?: T; failure?: string }>({});
  value.onMount = set => {
    let last: { value: T } | undefined;
    const load = () => {
      if (document.hidden || (last && !again(last.value))) return;
      fetch(path)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`${path} answered ${r.status}`))))
        .then(
          v => {
            last = { value: v as T };
            set(last);
          },
          (e: Error) => set(previous => ({ ...previous, failure: e.message }))
        );
    };
    load();
    const timer = setInterval(load, 3000);
    document.addEventListener('visibilitychange', load);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  };
  return value;
};

/** Every run of the served hub, with its trace short of prompts and session events. */
export const runsAtom = polled<CoreRun[]>('/core/runs');
