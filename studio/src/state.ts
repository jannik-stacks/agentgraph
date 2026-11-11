import { atom } from 'jotai';
import { Effect } from 'effect';
import { runActions } from '../../src/actions.ts';
import { getRunLineCount, makeDataHref, mergeLines, type OpenedRun } from './runs/trace.ts';
import { served } from 'virtual:served';
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

const isFollowed = (topic: string, { follows, instance }: NonNullable<ReturnType<typeof loads.get>>) =>
  follows.includes(instance && topic.startsWith(`${instance}:`) ? topic.slice(instance.length + 1) : topic);

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
  let pending: Promise<T> | undefined;
  const fetchOnce = () =>
    (pending ??= (
      typeof path === 'function'
        ? path().then(read)
        : fetch(makeApiHref(path, instance)).then(async r => {
            if (r.ok) return read(await r.json());
            const body = (await r.json().catch(() => undefined)) as { error?: unknown } | null | undefined;
            throw new Error(
              typeof body?.error === 'string' && body.error ? body.error : `${path} answered ${r.status}`
            );
          })
    ).finally(() => {
      pending = undefined;
    }));
  value.onMount = set => {
    let active = true;
    let busy = false;
    let again = false;
    const load = () => {
      if (busy) return void (again = true);
      busy = true;
      void fetchOnce()
        .then(
          next => {
            if (active) set({ value: next });
          },
          (e: { message?: unknown } | undefined) => {
            const failure = typeof e?.message === 'string' ? e.message : String(e);
            if (active) set(previous => ({ ...previous, failure, retry: load }));
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
const openOnce = <T>(
  key: string,
  data: string | null | undefined,
  load: () => Promise<T>,
  instance = shown?.name,
  follows = ['data']
) => {
  const full = JSON.stringify([instance ?? '', makeDataHref(key, data)]);
  if (!opened.has(full))
    opened.set(
      full,
      makeLiveJsonAtom<T>(load, data ? studioPages.map(page => page.name) : follows, undefined, instance)
    );
  return opened.get(full) as ReturnType<typeof makeLiveJsonAtom<T>>;
};

/** Every run of one instance as the run list reads it, with its trail and no trace. */
export const getRunsAtom = (instance = shown?.name) =>
  openOnce('runs', undefined, () => runAction(actions => actions.runs(), undefined, instance), instance);

export const dataParam = queryParam('data');

export const runResultsAtom = (data?: string | null, instance = shown?.name, run?: string) =>
  openOnce(
    run ? `results ${run}` : 'results',
    data,
    () => runAction(actions => actions.results(), data, instance),
    instance,
    [run ? `data:${run}` : 'data']
  );

const makeRunLoad = (id: string, data: string | null | undefined, instance: string | undefined) => {
  let last: OpenedRun | null = null;
  return async () => {
    const held = last;
    const after = held && getRunLineCount(held.trace);
    const next = await runAction(actions => actions.run({ id, ...(after && { after }) }), data, instance);
    return (last = held && next ? { ...next, trace: mergeLines(held.trace, next.trace) } : next);
  };
};

export const runAtom = (id: string, data?: string | null, instance = shown?.name) =>
  openOnce(`run ${id}`, data, makeRunLoad(id, data, instance), instance, [`data:${id}`]);

export const getVerdictsAtom = (fixture: string, step: string, check: string) =>
  openOnce(`verdicts ${fixture} ${step} ${check}`, undefined, () =>
    fixture.startsWith(`${shown?.title}/`)
      ? runAction(actions => actions.verdicts({ workflow: fixture.slice(fixture.indexOf('/') + 1), step, check }))
      : Promise.resolve([])
  );
