import { atom, useAtomValue, useSetAtom } from 'jotai';
import { atomWithReducer } from 'jotai/utils';
import { startTransition, useEffect, useState } from 'react';
import type { PullRow, RunRow } from '../../../src/live.ts';
import type { EventRecord, Outcome } from '../../../src/store.ts';
import { apiAtom, infoQueryAtom, latest } from '../state.ts';
import { usePolling } from '../ui.tsx';
import { noteSeen } from './bits.tsx';
import type { Prices } from './model.ts';

type Live = {
  rows: RunRow[] | undefined;
  pulls: PullRow[];
  connected: boolean;
  /** Why the run list cannot be loaded, while neither the stream nor the fallback poll gets an answer. */
  failure: string | undefined;
  /** A short-lived message about something that changed under the dashboard, like the data directory moving. */
  notice: { text: string; at: number } | undefined;
  /** The run whose events stream in, with every record so far and its outcome once it has one. */
  followed: { id: string; records: EventRecord[]; outcome: Outcome | null } | undefined;
};

type Action =
  | { type: 'follow'; run: string | undefined }
  | { type: 'link'; connected: boolean }
  | { type: 'failure'; failure: string }
  | { type: 'notice'; text: string }
  | { type: 'snapshot'; runs: RunRow[]; pulls: PullRow[] }
  | { type: 'run'; row: RunRow }
  | { type: 'removed'; id: string }
  | { type: 'pulls'; pulls: PullRow[] }
  | { type: 'outcome'; id: string; outcome: Outcome | null }
  | { type: 'records'; run: string; records: EventRecord[] };

const upsert = (rows: RunRow[] | undefined, row: RunRow) => {
  const list = rows ?? [];
  const at = list.findIndex(r => r.id === row.id);
  if (at >= 0) return list.with(at, row);
  return [row, ...list].sort((a, b) => (a.id < b.id ? 1 : -1));
};

const append = (followed: Live['followed'], run: string, records: EventRecord[]) => {
  if (followed?.id !== run) return followed;
  const last = followed.records.at(-1)?.seq ?? -1;
  const fresh = records.filter(r => r.seq > last);
  return fresh.length ? { ...followed, records: [...followed.records, ...fresh] } : followed;
};

const reduce = (live: Live, action: Action): Live => {
  switch (action.type) {
    case 'follow':
      return { ...live, followed: action.run ? { id: action.run, records: [], outcome: null } : undefined };
    case 'link':
      return action.connected ? { ...live, connected: true, failure: undefined } : { ...live, connected: false };
    case 'failure':
      return { ...live, failure: action.failure };
    case 'notice':
      return { ...live, notice: { text: action.text, at: Date.now() } };
    case 'snapshot':
      return { ...live, rows: action.runs, pulls: action.pulls, failure: undefined };
    case 'run':
      return { ...live, rows: upsert(live.rows, action.row) };
    case 'removed':
      return { ...live, rows: live.rows?.filter(r => r.id !== action.id) };
    case 'pulls':
      return { ...live, pulls: action.pulls };
    case 'outcome':
      return live.followed?.id === action.id
        ? { ...live, followed: { ...live.followed, outcome: action.outcome } }
        : live;
    case 'records': {
      const followed = append(live.followed, action.run, action.records);
      return followed === live.followed ? live : { ...live, followed };
    }
  }
};

const liveAtom = atomWithReducer<Live, Action>(
  { rows: undefined, pulls: [], connected: false, failure: undefined, notice: undefined, followed: undefined },
  reduce
);

const field = <K extends keyof Live>(key: K) => atom(get => get(liveAtom)[key]);

/** The dashboard's live state, one read per field so a view only renders again when its field changes. */
export const live = {
  rows: field('rows'),
  pulls: field('pulls'),
  connected: field('connected'),
  failure: field('failure'),
  notice: field('notice'),
  followed: field('followed'),
};

export const pricesAtom = latest(apiAtom<Prices>('/api/prices'), {});

const keysOf = (rows: RunRow[]) => rows.flatMap(row => [`run:${row.id}`, `event:${row.event.id}`]);
let loaded = false;

/** Notes a full list; only the first one the page gets counts as already there. */
const noteList = (rows: RunRow[]) => {
  noteSeen(keysOf(rows), !loaded);
  loaded = true;
};

/** The key a step's enter animation is tied to. */
export const recordKey = (run: string, seq: number) => `record:${run}:${seq}`;

/** Records written this long before the stream opened are replayed history, not news. */
const replayed = 2000;

const parse = <T>(message: MessageEvent) => JSON.parse(message.data as string) as T;

/**
 * Keeps the run list, merge requests and, when `run` is given, that run's records live from `/api/stream`. The
 * browser reconnects on its own and resumes after the last record; when it gives up, the stream is reopened every few
 * seconds. While it is disconnected the snapshot is polled, and a poll that fails says why in `live.failure`.
 */
export const useLiveStream = (run: string | undefined) => {
  const dispatch = useSetAtom(liveAtom);
  const refreshInfo = useSetAtom(infoQueryAtom);
  const connected = useAtomValue(live.connected);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    dispatch({ type: 'follow', run });
    const source = new EventSource(run ? `/api/stream?run=${encodeURIComponent(run)}` : '/api/stream');
    const opened = Date.now();
    let buffer: EventRecord[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (run) dispatch({ type: 'records', run, records: buffer });
      buffer = [];
    };
    const later = (action: Action) => startTransition(() => dispatch(action));
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => dispatch({ type: 'link', connected: true });
    source.onerror = () => {
      dispatch({ type: 'link', connected: source.readyState === EventSource.OPEN });
      if (source.readyState === EventSource.CLOSED) retry ??= setTimeout(() => setAttempt(n => n + 1), 3000);
    };
    source.addEventListener('reset', message => {
      const { dir, real } = parse<{ dir: string; real: string | null }>(message);
      dispatch({ type: 'notice', text: `The data directory changed: ${dir} now points to ${real ?? 'nothing'}` });
      refreshInfo();
    });
    source.addEventListener('snapshot', message => {
      const { runs, pulls } = parse<{ runs: RunRow[]; pulls: PullRow[] }>(message);
      noteList(runs);
      later({ type: 'snapshot', runs, pulls });
    });
    source.addEventListener('run', message => {
      const row = parse<RunRow>(message);
      noteSeen(keysOf([row]), false);
      later({ type: 'run', row });
    });
    source.addEventListener('removed', message => later({ type: 'removed', id: parse<{ id: string }>(message).id }));
    source.addEventListener('pulls', message => later({ type: 'pulls', pulls: parse<PullRow[]>(message) }));
    source.addEventListener('outcome', message =>
      dispatch({ type: 'outcome', ...parse<{ id: string; outcome: Outcome | null }>(message) })
    );
    source.addEventListener('record', message => {
      const record = parse<EventRecord>(message);
      if (run) noteSeen([recordKey(run, record.seq)], new Date(record.ts).getTime() < opened - replayed);
      buffer.push(record);
      frame ||= requestAnimationFrame(flush);
    });
    return () => {
      source.close();
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      dispatch({ type: 'link', connected: false });
    };
  }, [run, attempt, dispatch, refreshInfo]);

  usePolling(
    () => {
      void fetch('/api/live')
        .then(async r => {
          if (r.ok) return r.json() as Promise<{ runs: RunRow[]; pulls: PullRow[] }>;
          throw new Error(`the API answered ${r.status} ${r.statusText}`.trim());
        })
        .then(({ runs, pulls }) => {
          noteList(runs);
          startTransition(() => dispatch({ type: 'snapshot', runs, pulls }));
        })
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

const eventCache = new Map<string, Promise<EventRecord[]>>();

/** A run's records, fetched once per status it is seen in. */
export const fetchEvents = (id: string, status: string) => {
  const key = `${id}@${status}`;
  let cached = eventCache.get(key);
  if (!cached) {
    cached = fetch(`/api/runs/${encodeURIComponent(id)}/events`).then(r =>
      r.ok ? (r.json() as Promise<EventRecord[]>) : []
    );
    eventCache.set(key, cached);
  }
  return cached;
};

const outcomeCache = new Map<string, Promise<Outcome | null>>();

/** A run's outcome, fetched once per status it is seen in. */
export const fetchOutcome = (id: string, status: string) => {
  const key = `${id}@${status}`;
  let cached = outcomeCache.get(key);
  if (!cached) {
    cached = fetch(`/api/runs/${encodeURIComponent(id)}`).then(async r =>
      r.ok ? ((await r.json()) as { outcome: Outcome | null }).outcome : null
    );
    outcomeCache.set(key, cached);
  }
  return cached;
};
