import { atom, useAtomValue, useSetAtom } from 'jotai';
import { atomWithReducer } from 'jotai/utils';
import { useEffect, useState } from 'react';
import type { PullRow, RunRow } from '../../../src/live.ts';
import type { EventRecord, Outcome } from '../../../src/store.ts';
import { apiAtom, latest } from '../state.ts';
import { usePolling } from '../ui.tsx';
import type { Prices } from './model.ts';

type Live = {
  rows: RunRow[] | undefined;
  pulls: PullRow[];
  connected: boolean;
  /** Why the run list cannot be loaded, while neither the stream nor the fallback poll gets an answer. */
  failure: string | undefined;
};

type Action =
  | { type: 'link'; connected: boolean }
  | { type: 'failure'; failure: string }
  | { type: 'snapshot'; runs: RunRow[]; pulls: PullRow[] }
  | { type: 'run'; row: RunRow }
  | { type: 'removed'; id: string }
  | { type: 'pulls'; pulls: PullRow[] };

/** What a row is redrawn for: its status and closure. Tallies and activity alone never redraw anything. */
const keyOf = (row: RunRow) => `${row.id}:${row.status}:${row.closure ?? ''}`;
const keysOf = (rows: RunRow[] | undefined) => rows?.map(keyOf).join() ?? '';

const upsert = (rows: RunRow[] | undefined, row: RunRow) => {
  const list = rows ?? [];
  const at = list.findIndex(r => r.id === row.id);
  if (at < 0) return [row, ...list].sort((a, b) => (a.id < b.id ? 1 : -1));
  return keyOf(list[at]!) === keyOf(row) ? list : list.with(at, row);
};

const reduce = (live: Live, action: Action): Live => {
  switch (action.type) {
    case 'link':
      return action.connected ? { ...live, connected: true, failure: undefined } : { ...live, connected: false };
    case 'failure':
      return { ...live, failure: action.failure };
    case 'snapshot': {
      const rows = keysOf(live.rows) === keysOf(action.runs) ? live.rows : action.runs;
      return { ...live, rows, pulls: action.pulls, failure: undefined };
    }
    case 'run': {
      const rows = upsert(live.rows, action.row);
      return rows === live.rows ? live : { ...live, rows };
    }
    case 'removed':
      return { ...live, rows: live.rows?.filter(r => r.id !== action.id) };
    case 'pulls':
      return { ...live, pulls: action.pulls };
  }
};

const liveAtom = atomWithReducer<Live, Action>(
  { rows: undefined, pulls: [], connected: false, failure: undefined },
  reduce
);

const field = <K extends keyof Live>(key: K) => atom(get => get(liveAtom)[key]);

/** The live run list and merge requests, one read per field. Rows change only when a run's status does. */
export const live = {
  rows: field('rows'),
  pulls: field('pulls'),
  connected: field('connected'),
  failure: field('failure'),
};

export const pricesAtom = latest(apiAtom<Prices>('/api/prices'), {});

const parse = <T>(message: MessageEvent) => JSON.parse(message.data as string) as T;

/**
 * Keeps the run list and merge requests live from `/api/stream`. When the stream gives up it is reopened every few
 * seconds, and meanwhile the snapshot is polled; a poll that fails says why in `live.failure`.
 */
export const useLiveStream = () => {
  const dispatch = useSetAtom(liveAtom);
  const connected = useAtomValue(live.connected);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => dispatch({ type: 'link', connected: true });
    source.onerror = () => {
      dispatch({ type: 'link', connected: source.readyState === EventSource.OPEN });
      if (source.readyState === EventSource.CLOSED) retry ??= setTimeout(() => setAttempt(n => n + 1), 3000);
    };
    source.addEventListener('snapshot', message =>
      dispatch({ type: 'snapshot', ...parse<{ runs: RunRow[]; pulls: PullRow[] }>(message) })
    );
    source.addEventListener('run', message => dispatch({ type: 'run', row: parse<RunRow>(message) }));
    source.addEventListener('removed', message => dispatch({ type: 'removed', id: parse<{ id: string }>(message).id }));
    source.addEventListener('pulls', message => dispatch({ type: 'pulls', pulls: parse<PullRow[]>(message) }));
    return () => {
      source.close();
      clearTimeout(retry);
      dispatch({ type: 'link', connected: false });
    };
  }, [attempt, dispatch]);

  usePolling(
    () => {
      void fetch('/api/live')
        .then(async r => {
          if (r.ok) return r.json() as Promise<{ runs: RunRow[]; pulls: PullRow[] }>;
          throw new Error(`the API answered ${r.status} ${r.statusText}`.trim());
        })
        .then(({ runs, pulls }) => dispatch({ type: 'snapshot', runs, pulls }))
        .catch((e: Error) =>
          dispatch({
            type: 'failure',
            failure: e.message === 'Failed to fetch' ? 'the API server does not answer' : e.message,
          })
        );
    },
    connected ? null : 3000
  );
};

const cache = new Map<string, Promise<unknown>>();

const once = <T>(key: string, load: () => Promise<T>) => {
  let found = cache.get(key) as Promise<T> | undefined;
  if (!found) cache.set(key, (found = load()));
  return found;
};

/** A run's records, fetched once per status it is seen in, and again for each `version`. */
export const fetchEvents = (id: string, status: string, version = 0) =>
  once(`events:${id}@${status}#${version}`, () =>
    fetch(`/api/runs/${encodeURIComponent(id)}/events`).then(r => (r.ok ? (r.json() as Promise<EventRecord[]>) : []))
  );

/** A run's outcome, fetched once per status it is seen in. */
export const fetchOutcome = (id: string, status: string) =>
  once(`outcome:${id}@${status}`, () =>
    fetch(`/api/runs/${encodeURIComponent(id)}`).then(async r =>
      r.ok ? ((await r.json()) as { outcome: Outcome | null }).outcome : null
    )
  );
