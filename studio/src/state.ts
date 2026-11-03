import { atom } from 'jotai';
import type { readRunResults } from '../../bin/results.ts';
import type { Step } from '../../bin/tune.ts';
import type { RunResults } from './results/result.ts';
import { type ServedRun, makeDataHref } from './runs/trace.ts';

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

export const pageAtom = atom(get => {
  const [route, id] = get(locationAtom).path.split('/').filter(Boolean);
  return { route, id: route && id ? decodeURIComponent(id) : null };
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

/** The step selected on the graph, as `workflow/step`, then what was opened from it, as `/check:name` and `/agent:name`. */
export const selectedStepAtom = queryParam('step');

const loads = new Map<() => void, readonly string[]>();

export const readChanged = (topics: readonly string[]) => {
  for (const [load, follows] of loads) if (follows.some(topic => topics.includes(topic))) load();
};

export const connectedAtom = atom(true);
connectedAtom.onMount = set => {
  const lost = () => set(false);
  import.meta.hot?.on('vite:ws:disconnect', lost);
  return () => import.meta.hot?.off('vite:ws:disconnect', lost);
};

export const makeLiveJsonAtom = <T>(
  path: string,
  topics: readonly string[],
  read: (value: unknown) => T | Promise<T> = value => value as T
) => {
  const value = atom<{ value?: T; failure?: string; retry?: () => void }>({});
  value.onMount = set => {
    let active = true;
    let busy = false;
    let again = false;
    const load = () => {
      if (busy) return void (again = true);
      busy = true;
      void fetch(path)
        .then(async r => {
          const body = (await r.json().catch(() => undefined)) as { error?: unknown } | null | undefined;
          if (r.ok || (r.status === 404 && body === null)) return read(body);
          throw new Error(typeof body?.error === 'string' ? body.error : `${path} answered ${r.status}`);
        })
        .then(
          next => {
            if (active) set({ value: next });
          },
          (e: Error) => {
            if (active) set(previous => ({ ...previous, failure: e.message, retry: load }));
          }
        )
        .finally(() => {
          busy = false;
          if (again && active) {
            again = false;
            load();
          }
        });
    };
    loads.set(load, topics);
    load();
    return () => {
      active = false;
      loads.delete(load);
    };
  };
  return value;
};

/** Every run of the served graph, with its trace, every text in it cut short. */
export const runsAtom = makeLiveJsonAtom<ServedRun[]>('/api/runs', ['data']);

type ServedResults = Omit<ReturnType<typeof readRunResults>, 'runs'> & { runs: (RunResults & { step?: Step })[] };

const opened = new Map<string, object>();
const openOnce = <T>(url: string, data?: string | null) => {
  if (!opened.has(url)) opened.set(url, makeLiveJsonAtom<T>(url, [data ? 'bench' : 'data']));
  return opened.get(url) as ReturnType<typeof makeLiveJsonAtom<T>>;
};

export const dataParam = queryParam('data');

export const runResultsAtom = (data?: string | null) =>
  openOnce<ServedResults>(makeDataHref('/api/results?from=runs', data), data);

export const runAtom = (id: string, data?: string | null) =>
  openOnce<ServedRun | null>(makeDataHref(`/api/runs/${encodeURIComponent(id)}`, data), data);
