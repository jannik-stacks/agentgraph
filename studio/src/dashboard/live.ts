import { atom, useAtomValue, useSetAtom } from 'jotai';
import { atomWithRefresh, unwrap } from 'jotai/utils';
import { startTransition, useEffect, useState } from 'react';
import type { PullRow, RunRow } from '../../../src/live.ts';
import type { EventRecord, Outcome } from '../../../src/store.ts';
import type { Price } from '../../../src/usage.ts';
import { refreshInfoAtom } from '../info.ts';
import { usePolling } from '../ui.tsx';
import { noteSeen } from './bits.tsx';

export const runRowsAtom = atom<RunRow[] | undefined>(undefined);
export const pullsAtom = atom<PullRow[]>([]);
export const connectedAtom = atom(false);

/** Why the run list cannot be loaded, while neither the stream nor the fallback poll gets an answer. */
export const failureAtom = atom<string | undefined>(undefined);

/** A short-lived message about something that changed under the dashboard, like the data directory moving. */
export const noticeAtom = atom<{ text: string; at: number } | undefined>(undefined);

/** The run whose events stream in, with every record so far and its outcome once it has one. */
export const followedAtom = atom<{ id: string; records: EventRecord[]; outcome: Outcome | null } | undefined>(
  undefined
);

const pricesQueryAtom = atomWithRefresh(async () => {
  const response = await fetch('/api/prices');
  return response.ok ? ((await response.json()) as Record<string, Price & { model: string }>) : {};
});
export const pricesAtom = unwrap(pricesQueryAtom, previous => previous ?? {});

const upsert = (rows: RunRow[] | undefined, row: RunRow) => {
  const list = rows ?? [];
  const at = list.findIndex(r => r.id === row.id);
  if (at >= 0) return list.with(at, row);
  return [row, ...list].sort((a, b) => (a.id < b.id ? 1 : -1));
};

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
 * seconds. While it is disconnected the snapshot is polled, and a poll that fails says why in `failureAtom`.
 */
export const useLiveStream = (run: string | undefined) => {
  const setRows = useSetAtom(runRowsAtom);
  const setPulls = useSetAtom(pullsAtom);
  const setConnected = useSetAtom(connectedAtom);
  const setFollowed = useSetAtom(followedAtom);
  const setFailure = useSetAtom(failureAtom);
  const setNotice = useSetAtom(noticeAtom);
  const refreshInfo = useSetAtom(refreshInfoAtom);
  const connected = useAtomValue(connectedAtom);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFollowed(run ? { id: run, records: [], outcome: null } : undefined);
    const source = new EventSource(run ? `/api/stream?run=${encodeURIComponent(run)}` : '/api/stream');
    const opened = Date.now();
    let buffer: EventRecord[] = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = buffer;
      buffer = [];
      setFollowed(f => {
        if (!f || f.id !== run) return f;
        const last = f.records.at(-1)?.seq ?? -1;
        const fresh = batch.filter(r => r.seq > last);
        return fresh.length ? { ...f, records: [...f.records, ...fresh] } : f;
      });
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      setConnected(true);
      setFailure(undefined);
    };
    source.onerror = () => {
      setConnected(source.readyState === EventSource.OPEN);
      if (source.readyState === EventSource.CLOSED) retry ??= setTimeout(() => setAttempt(n => n + 1), 3000);
    };
    source.addEventListener('reset', message => {
      const { dir, real } = parse<{ dir: string; real: string | null }>(message);
      setNotice({ text: `The data directory changed: ${dir} now points to ${real ?? 'nothing'}`, at: Date.now() });
      refreshInfo();
    });
    source.addEventListener('snapshot', message => {
      const { runs, pulls } = parse<{ runs: RunRow[]; pulls: PullRow[] }>(message);
      noteList(runs);
      startTransition(() => {
        setRows(runs);
        setPulls(pulls);
      });
    });
    source.addEventListener('run', message => {
      const row = parse<RunRow>(message);
      noteSeen(keysOf([row]), false);
      startTransition(() => setRows(rows => upsert(rows, row)));
    });
    source.addEventListener('removed', message => {
      const { id } = parse<{ id: string }>(message);
      startTransition(() => setRows(rows => rows?.filter(r => r.id !== id)));
    });
    source.addEventListener('pulls', message => {
      const pulls = parse<PullRow[]>(message);
      startTransition(() => setPulls(pulls));
    });
    source.addEventListener('outcome', message => {
      const { id, outcome } = parse<{ id: string; outcome: Outcome | null }>(message);
      setFollowed(f => (f?.id === id ? { ...f, outcome } : f));
    });
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
      setConnected(false);
    };
  }, [run, attempt, setRows, setPulls, setConnected, setFollowed, setFailure, setNotice, refreshInfo]);

  usePolling(
    () => {
      void fetch('/api/live')
        .then(async r => {
          if (r.ok) return r.json() as Promise<{ runs: RunRow[]; pulls: PullRow[] }>;
          throw new Error(`the API answered ${r.status} ${r.statusText}`.trim());
        })
        .then(body => {
          setFailure(undefined);
          noteList(body.runs);
          startTransition(() => {
            setRows(body.runs);
            setPulls(body.pulls);
          });
        })
        .catch((e: Error) =>
          setFailure(e.message === 'Failed to fetch' ? 'the API server does not answer' : e.message)
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
