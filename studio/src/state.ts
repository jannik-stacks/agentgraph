import { atom } from 'jotai';
import { Effect } from 'effect';
import { runActions } from '../../src/actions.ts';
import type { readRunResults } from '../../bin/results.ts';
import { type ServedRun, makeDataHref, type makeRunSummary } from './runs/trace.ts';
import { served } from 'virtual:served';
import { type RunRecord } from '../../src/types.ts';
import { pages } from 'virtual:agentgraph-pages';

export const instances = served.filter(one => one.name);

export const studioPages = pages.filter(page => page.instance === undefined);

export const shown = instances.length ? instances.find(one => one.name === location.pathname.split('/')[1]) : served[0];

const prefix = shown?.name ? `/${shown.name}` : '';

export const makeInstanceHref = (href: string) => prefix + href;

const makeApiHref = (href: string) =>
  shown?.name ? `${href}${href.includes('?') ? '&' : '?'}instance=${shown.name}` : href;

export const runAction = <A, E>(use: Parameters<typeof runActions<A, E>>[2], data?: string | null) =>
  Effect.runPromise(
    runActions(
      new URL(makeApiHref(makeDataHref('/api/actions', data)), location.href).href,
      (input, init) => fetch(input, init),
      use
    )
  );

const readLocation = () => ({
  path: location.pathname.slice(prefix.length) || '/',
  query: new URLSearchParams(location.search),
});

/** The current location; tests set it. @public */
export const locationAtom = atom(readLocation());
locationAtom.onMount = set => {
  const sync = () => set(readLocation());
  addEventListener('popstate', sync);
  return () => removeEventListener('popstate', sync);
};

/** Pushes or replaces a history entry. */
export const navigateAtom = atom(null, (_get, set, to: { href: string; replace?: boolean }) => {
  history[to.replace ? 'replaceState' : 'pushState'](null, '', makeInstanceHref(to.href));
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

export const readChanged = (changed?: readonly string[]) => {
  const topics = changed?.flatMap(topic => {
    const [own, scoped] = topic.split(':');
    return scoped === undefined ? [own!] : own === shown?.name ? [scoped] : [];
  });
  for (const [load, follows] of loads) if (!topics || follows.some(topic => topics.includes(topic))) load();
};

export const connectedAtom = atom(true);
connectedAtom.onMount = set => {
  const lost = () => set(false);
  import.meta.hot?.on('vite:ws:disconnect', lost);
  return () => import.meta.hot?.off('vite:ws:disconnect', lost);
};

export const makeLiveJsonAtom = <T>(
  path: string | (() => Promise<unknown>),
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
      void (
        typeof path === 'function'
          ? path().then(read)
          : fetch(makeApiHref(path)).then(async r => {
              if (r.ok) return read(await r.json());
              const body = (await r.json().catch(() => undefined)) as { error?: unknown } | null | undefined;
              throw new Error(
                typeof body?.error === 'string' && body.error ? body.error : `${path} answered ${r.status}`
              );
            })
      )
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

/** Every run of the served graph as the run list reads it, with its trail and no trace. */
export const runsAtom = makeLiveJsonAtom<(ServedRun & Pick<ReturnType<typeof makeRunSummary>, 'trail'>)[]>(
  () => runAction(actions => actions.runs({})),
  ['data']
);

const opened = new Map<string, object>();
const openOnce = <T>(key: string, data: string | null | undefined, load: () => Promise<T>) => {
  if (!opened.has(key))
    opened.set(key, makeLiveJsonAtom<T>(load, data ? studioPages.map(page => page.name) : ['data']));
  return opened.get(key) as ReturnType<typeof makeLiveJsonAtom<T>>;
};

export const dataParam = queryParam('data');

export const runResultsAtom = (data?: string | null) =>
  openOnce(
    makeDataHref('results', data),
    data,
    () => runAction(actions => actions.results(), data) as Promise<ReturnType<typeof readRunResults>>
  );

export const runAtom = (id: string, data?: string | null) =>
  openOnce(
    makeDataHref(`run ${id}`, data),
    data,
    () => runAction(actions => actions.runs({ id }), data) as Promise<(ServedRun & { run: RunRecord }) | null>
  );

export const getVerdictsAtom = (fixture: string, step: string, check: string) =>
  openOnce(`verdicts ${fixture} ${step} ${check}`, undefined, () =>
    fixture.startsWith(`${shown?.title}/`)
      ? runAction(actions => actions.verdicts({ workflow: fixture.slice(fixture.indexOf('/') + 1), step, check }))
      : Promise.resolve([])
  );
