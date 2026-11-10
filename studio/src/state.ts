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

export const makeInstanceHref = (href: string, instance = shown?.name) =>
  (instance ? `/${encodeURIComponent(instance)}` : '') + href;

const prefix = makeInstanceHref('');

const makeApiHref = (href: string, instance = shown?.name) =>
  instance ? `${href}${href.includes('?') ? '&' : '?'}instance=${encodeURIComponent(instance)}` : href;

export const runAction = <A, E>(
  use: Parameters<typeof runActions<A, E>>[2],
  data?: string | null,
  instance = shown?.name
) =>
  Effect.runPromise(
    runActions(
      new URL(makeApiHref(makeDataHref('/api/actions', data), instance), location.href).href,
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

const loads = new Map<() => void, { follows: readonly string[]; instance: string | undefined }>();

const isFollowed = (topic: string, { follows, instance }: NonNullable<ReturnType<typeof loads.get>>) => {
  const [own, scoped] = topic.split(':');
  return scoped === undefined ? follows.includes(own!) : own === instance && follows.includes(scoped);
};

export const readChanged = (changed?: readonly string[]) => {
  for (const [load, follow] of loads) if (!changed || changed.some(topic => isFollowed(topic, follow))) load();
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
  read: (value: unknown) => T | Promise<T> = value => value as T,
  instance = shown?.name
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
          : fetch(makeApiHref(path, instance)).then(async r => {
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
    loads.set(load, { follows: topics, instance });
    load();
    return () => {
      active = false;
      loads.delete(load);
    };
  };
  return value;
};

const opened = new Map<string, object>();
const openOnce = <T>(key: string, data: string | null | undefined, load: () => Promise<T>, instance = shown?.name) => {
  const full = JSON.stringify([instance ?? '', makeDataHref(key, data)]);
  if (!opened.has(full))
    opened.set(
      full,
      makeLiveJsonAtom<T>(load, data ? studioPages.map(page => page.name) : ['data'], undefined, instance)
    );
  return opened.get(full) as ReturnType<typeof makeLiveJsonAtom<T>>;
};

/** Every run of one instance as the run list reads it, with its trail and no trace. */
export const getRunsAtom = (instance = shown?.name) =>
  openOnce(
    'runs',
    undefined,
    () =>
      runAction(actions => actions.runs({}), undefined, instance) as Promise<
        (ServedRun & Pick<ReturnType<typeof makeRunSummary>, 'trail'>)[]
      >,
    instance
  );

export const dataParam = queryParam('data');

export const runResultsAtom = (data?: string | null, instance = shown?.name) =>
  openOnce(
    'results',
    data,
    () => runAction(actions => actions.results(), data, instance) as Promise<ReturnType<typeof readRunResults>>,
    instance
  );

export const runAtom = (id: string, data?: string | null, instance = shown?.name) =>
  openOnce(
    `run ${id}`,
    data,
    () =>
      runAction(actions => actions.runs({ id }), data, instance) as Promise<(ServedRun & { run: RunRecord }) | null>,
    instance
  );

export const getVerdictsAtom = (fixture: string, step: string, check: string) =>
  openOnce(`verdicts ${fixture} ${step} ${check}`, undefined, () =>
    fixture.startsWith(`${shown?.title}/`)
      ? runAction(actions => actions.verdicts({ workflow: fixture.slice(fixture.indexOf('/') + 1), step, check }))
      : Promise.resolve([])
  );
