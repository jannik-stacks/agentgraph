import { atom, useAtomValue } from 'jotai';
import { type ReactNode, useMemo } from 'react';
import { pages } from 'virtual:agentgraph-pages';
import { instances, locationAtom, makeInstanceHref, runAtom, shown, studioPages } from './state.ts';

const official = new Set(['graph', 'runs', 'docs']);

const isServed = (path: string, instance: string | undefined, data = false) => {
  const [route, id] = path.split('/').filter(Boolean);
  const href = route === 'plugins' ? `/plugins/${id}` : `/${route}`;
  if (instance === undefined && instances.length)
    return (route === 'runs' && (!id || data)) || studioPages.some(page => page.href === href);
  return official.has(route ?? '') || pages.some(page => page.instance === (instance ?? '') && page.href === href);
};

const findServedPlaces = (path: string, data = false) => {
  const places = [...instances.map(one => one.name), ...(instances.length ? [undefined] : [])];
  const served = (p: string) =>
    places
      .filter(place => (p !== path || place !== shown?.name) && isServed(p, place, data))
      .map(place => ({ place, path: p }));
  const found = served(path);
  return found.length || shown ? found : served(path.replace(/^\/[^/]*/, '') || '/runs');
};

const readAskedRun = (path: string, query: URLSearchParams) => {
  const [route, id] = path.split('/').filter(Boolean);
  return route === 'runs' && id ? decodeURIComponent(id) : route === 'results' ? query.get('run') : null;
};

const label = (place: string | undefined) => place ?? 'all instances';

export const NotFound = ({ why }: { why?: ReactNode }) => {
  const { path, query } = useAtomValue(locationAtom);
  const data = query.get('data');
  const run = readAskedRun(path, query);
  const search = query.size ? `?${query}` : '';
  const { candidates, holding } = useMemo(() => {
    const candidates = findServedPlaces(path, !!data);
    const holding = atom(get =>
      candidates.map(({ place }) => {
        if (!run || place === undefined) return true;
        const { value, failure } = get(runAtom(run, data, place));
        return value !== undefined ? value : failure === undefined ? undefined : null;
      })
    );
    return { candidates, holding };
  }, [path, data, run]);
  const held = useAtomValue(holding);
  const open = candidates.filter((_, i) => held[i]);
  const asked = `${makeInstanceHref(path)}${search}`;
  const [first] = path.split('/').filter(Boolean);
  return (
    <div className="space-y-2 p-4 text-zinc-500">
      <p>
        {why ??
          (shown?.name
            ? `${shown.name} has no page at ${asked}.`
            : !instances.length
              ? `This studio has no page at ${asked}.`
              : instances.some(one => isServed(path, one.name))
                ? `${asked} needs an instance.`
                : `This studio serves no instance named ${first}.`)}
      </p>
      {open.length > 0 ? (
        <p>
          {run ? `Run ${run} is on ` : 'Open it on '}
          {open.map(({ place, path: p }, i) => (
            <span key={label(place)}>
              {i > 0 && ', '}
              <a className="underline" href={makeInstanceHref(`${p}${search}`, place ?? '')}>
                {label(place)}
              </a>
            </span>
          ))}
          .
        </p>
      ) : (
        !held.includes(undefined) && (
          <p>
            {run && `No served instance has run ${run}. `}
            <a className="underline" href={makeInstanceHref('/runs', instances.length ? '' : undefined)}>
              Open the runs
            </a>
            .
          </p>
        )
      )}
    </div>
  );
};
