import { type FSWatcher, watch } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonl } from './jsonl.ts';
import { proseLine } from './outputs.ts';
import { fold, type Op, type Pull } from './pulls.ts';
import type { EventRecord, Outcome, Run } from './store.ts';
import { count, emptyTally, sum, type Tally } from './usage.ts';

/** What the run list needs from an outcome: no bodies or findings, just what landed and how checks went. */
export const briefOf = (outcome: Outcome) => ({
  applied: outcome.applied,
  kinds: outcome.proposals.map(p => p.kind),
  rejected: outcome.rejected.length,
  results: outcome.results.map(({ kind, status, url }) => ({ kind, status, ...(url && { url }) })),
  ...(outcome.checks && {
    checks: outcome.checks.map(({ findings: _, ...verdict }) => verdict),
  }),
  ...(outcome.branch && { branch: outcome.branch }),
  ...(outcome.pr !== undefined && { pr: outcome.pr }),
});

/** When a run's last event arrived, and the last thing it said or the last tool it called. */
export type Activity = { at: string; text?: string; tool?: string; input?: unknown };

const clip = (value: unknown) => (typeof value === 'string' && value.length > 160 ? `${value.slice(0, 160)}…` : value);

const activityOf = ({ ts, event }: EventRecord, previous: Activity | undefined): Activity => {
  if (event.type === 'text') return { at: ts, text: clip(proseLine(event.text) ?? '') as string };
  if (event.type === 'tool_call') {
    const { input } = event;
    return {
      at: ts,
      tool: event.tool,
      input:
        input && typeof input === 'object' && !Array.isArray(input)
          ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clip(value)]))
          : clip(input),
    };
  }
  return { ...previous, at: ts };
};

/**
 * A run as the dashboard lists it: the stored run, the totals of its events, its latest activity and a brief of its
 * outcome.
 */
export type RunRow = Run & { tally: Tally; activity?: Activity; brief?: ReturnType<typeof briefOf> };

/** One line in `pulls.jsonl` reduced to what links a request to the job that opened it. */
export type PullRow = Pick<Pull, 'number' | 'title' | 'branch' | 'into' | 'state' | 'origin'>;

/** One run that changed, or `pulls` when `pulls.jsonl` did. */
export type Change = { id: string; row?: RunRow; removed?: true; events?: true; outcome?: true } | { pulls: true };

/** Complete lines appended to `file` since byte `offset`, and the offset after the last of them. */
export const tail = async (file: string, offset: number) => {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return { lines: [], offset: 0, size: 0 };
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { lines: [], offset: Math.min(offset, size), size };
    const bytes = Buffer.alloc(size - offset);
    await handle.read(bytes, 0, bytes.length, offset);
    const end = bytes.lastIndexOf(10) + 1;
    if (!end) return { lines: [], offset, size };
    return { lines: bytes.toString('utf8', 0, end).split('\n').slice(0, -1), offset: offset + end, size };
  } finally {
    await handle.close();
  }
};

const signature = async (file: string) => {
  const s = await stat(file).catch(() => undefined);
  return s ? `${s.mtimeMs}:${s.size}` : '';
};

const parse = <T>(text: string) => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

const settledAfterMs = 10 * 60_000;
const files = ['run.json', 'events.jsonl', 'outcome.json'];

type Entry = { sigs: string[]; offset: number; row?: RunRow };

/**
 * Watches the runs under a data directory and keeps a row per run, with its event totals folded in as events are
 * appended. `fs.watch` covers the data directory, `runs/` and the directories of unsettled runs; a poll every
 * `pollMs` re-checks unsettled runs and `pulls.jsonl`, notices when `dir` (often a symlink) points somewhere new, and
 * every `sweepEvery` polls re-checks every run. Starts with its first subscriber and stops with its last.
 */
export const watchRuns = (dir: string, { pollMs = 1000, sweepEvery = 15, useWatch = true } = {}) => {
  const listeners = new Set<(changes: Change[] | 'reset') => void>();
  const entries = new Map<string, Entry>();
  const watchers = new Map<string, FSWatcher>();
  let root = '';
  let pulls: PullRow[] = [];
  let pullsSig = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;
  let ready: Promise<void> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Set<string>();
  let flushing: ReturnType<typeof setTimeout> | undefined;

  const serial = <T>(task: () => Promise<T>) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  const emit = (changes: Change[] | 'reset') => {
    if (changes === 'reset' || changes.length) for (const listener of listeners) listener(changes);
  };
  const later = (task: () => Promise<Change[] | 'reset'>) => void serial(task).then(emit, () => {});
  const runDir = (id: string) => join(root, 'runs', id);
  const settled = (row: RunRow | undefined) =>
    row !== undefined &&
    row.status !== 'queued' &&
    row.status !== 'running' &&
    Date.now() - new Date(row.endedAt ?? 0).getTime() > settledAfterMs;

  const observe = (key: string, path: string, onChange: (name: string | null) => void) => {
    if (!useWatch || watchers.has(key)) return;
    try {
      const watcher = watch(path, { persistent: false }, (_type, name) => onChange(name ? String(name) : null));
      watcher.on('error', () => {
        watcher.close();
        watchers.delete(key);
      });
      watchers.set(key, watcher);
    } catch {}
  };
  const unobserve = (key: string) => {
    watchers.get(key)?.close();
    watchers.delete(key);
  };

  const schedule = (id: string) => {
    pending.add(id);
    flushing ??= setTimeout(() => {
      flushing = undefined;
      const ids = [...pending];
      pending.clear();
      later(() => refresh(ids));
    }, 20);
  };

  const readPulls = async () => {
    const file = join(root, 'pulls.jsonl');
    const sig = await signature(file);
    if (sig === pullsSig) return false;
    pullsSig = sig;
    const ops = await readJsonl<Op>(file);
    pulls = fold(ops, n => `#${n}`).map(({ number, title, branch, into, state, origin }) => ({
      number,
      title,
      branch,
      into,
      state,
      ...(origin && { origin }),
    }));
    return true;
  };

  const refreshOne = async (id: string): Promise<Extract<Change, { id: string }> | undefined> => {
    const base = runDir(id);
    const sigs = await Promise.all(files.map(f => signature(join(base, f))));
    const entry = entries.get(id) ?? { sigs: ['', '', ''], offset: 0 };
    if (!sigs[0]) {
      if (!entry.row) return;
      entries.delete(id);
      unobserve(id);
      return { id, removed: true };
    }
    if (entry.row && sigs.every((sig, i) => sig === entry.sigs[i])) return;
    const change: Extract<Change, { id: string }> = { id };
    let row = entry.row;
    if (sigs[0] !== entry.sigs[0] || !row) {
      const run = parse<Run>(await readFile(join(base, 'run.json'), 'utf8').catch(() => ''));
      if (!run) return;
      row = {
        ...run,
        tally: row?.tally ?? emptyTally(),
        ...(row?.activity && { activity: row.activity }),
        ...(row?.brief && { brief: row.brief }),
      };
    }
    if (sigs[1] !== entry.sigs[1]) {
      let offset = entry.offset;
      let total = row.tally;
      let activity = row.activity;
      const size = Number(sigs[1]?.split(':')[1] ?? 0);
      if (size < offset) [offset, total, activity] = [0, emptyTally(), undefined];
      const read = await tail(join(base, 'events.jsonl'), offset);
      if (read.lines.length) {
        total = sum([total]);
        for (const line of read.lines) {
          const record = parse<EventRecord>(line);
          if (!record) continue;
          count(total, record.event);
          activity = activityOf(record, activity);
        }
        change.events = true;
      }
      const { activity: _, ...rest } = row;
      row = { ...rest, tally: total, ...(activity && { activity }) };
      entry.offset = read.offset;
    }
    if (sigs[2] !== entry.sigs[2]) {
      const outcome = parse<Outcome>(await readFile(join(base, 'outcome.json'), 'utf8').catch(() => ''));
      const { brief: _, ...rest } = row;
      row = outcome ? { ...rest, brief: briefOf(outcome) } : rest;
      change.outcome = true;
    }
    entry.sigs = sigs;
    entry.row = row;
    entries.set(id, entry);
    if (settled(row)) unobserve(id);
    else observe(id, base, name => (name === null || files.some(f => name.startsWith(f))) && schedule(id));
    return { ...change, row };
  };

  const refresh = async (ids: string[] | 'all') => {
    let list = ids;
    if (list === 'all') {
      const found = await readdir(join(root, 'runs')).catch(() => []);
      list = [...new Set([...found, ...entries.keys()])];
    }
    const changes = await Promise.all(list.map(refreshOne));
    return changes.filter(change => change !== undefined);
  };

  const observeRuns = () =>
    observe('runs', join(root, 'runs'), id => (id ? schedule(id) : later(() => refresh('all'))));
  /** Runs inside `serial`, like everything that reads or changes `entries`. */
  const start = async () => {
    root = await realpath(dir).catch(() => dir);
    observe('.', root, name => {
      if (name === null || name === 'runs') {
        observeRuns();
        later(() => refresh('all'));
      }
      if (name === null || name === 'pulls.jsonl')
        later(async () => ((await readPulls()) ? [{ pulls: true as const }] : []));
    });
    observeRuns();
    await readPulls();
    await refresh('all');
    for (const [id, entry] of entries) if (!settled(entry.row)) schedule(id);
  };

  const stop = () => {
    clearInterval(timer);
    clearTimeout(flushing);
    timer = flushing = undefined;
    pending.clear();
    for (const key of [...watchers.keys()]) unobserve(key);
  };

  const poll = async () => {
    ticks++;
    const now = await realpath(dir).catch(() => dir);
    if (now !== root) {
      for (const key of [...watchers.keys()]) unobserve(key);
      entries.clear();
      pullsSig = '';
      pulls = [];
      await start();
      return 'reset' as const;
    }
    const pullsChanged = await readPulls();
    const ids = ticks % sweepEvery ? [...entries].flatMap(([id, e]) => (settled(e.row) ? [] : [id])) : 'all';
    const changes: Change[] = await refresh(ids);
    if (ticks % sweepEvery) {
      const found = await readdir(join(root, 'runs')).catch(() => []);
      changes.push(...(await refresh(found.filter(id => !entries.has(id)))));
    }
    return pullsChanged ? [...changes, { pulls: true as const }] : changes;
  };

  return {
    /** Calls `listener` with each batch of changes, or `reset` when the data directory moved. Resolves once ready. */
    subscribe: (listener: (changes: Change[] | 'reset') => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        ready = serial(start);
        timer = setInterval(() => later(poll), pollMs);
      }
      return {
        ready,
        close: () => {
          listeners.delete(listener);
          if (!listeners.size) stop();
        },
      };
    },
    /** Every run, newest first. */
    rows: () => [...entries.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).flatMap(([, e]) => (e.row ? [e.row] : [])),
    pulls: () => pulls,
    /** Settles once every change seen so far has been read. */
    idle: () => serial(async () => {}),
  };
};

export type RunWatcher = ReturnType<typeof watchRuns>;

const sse = (event: string, data: unknown, id?: number) =>
  `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Server-Sent Events over a run watcher. Sends `snapshot` with every run and merge request, then `run` or `removed`
 * as runs change and `pulls` when requests do. A comment line every `pingMs` keeps proxies from closing an idle
 * stream.
 */
export const liveStream = ({
  watcher,
  dir,
  signal,
  pingMs = 15_000,
}: {
  watcher: RunWatcher;
  dir: string;
  signal: AbortSignal;
  pingMs?: number;
}) => {
  const encoder = new TextEncoder();
  let close = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      let queue: Promise<unknown> = Promise.resolve();
      const send = (text: string) => open && controller.enqueue(encoder.encode(text));
      const snapshot = () => send(sse('snapshot', { runs: watcher.rows(), pulls: watcher.pulls() }));
      const step = (task: () => unknown) => {
        queue = queue.then(() => (open ? task() : undefined)).catch(e => fail(e as Error));
      };
      const onChange = (changes: Change[] | 'reset') =>
        step(async () => {
          if (changes === 'reset') {
            send(sse('reset', { dir, real: await realpath(dir).catch(() => null) }));
            return snapshot();
          }
          for (const change of changes) {
            if ('pulls' in change) {
              send(sse('pulls', watcher.pulls()));
              continue;
            }
            if (change.removed) send(sse('removed', { id: change.id }));
            else if (change.row) send(sse('run', change.row));
          }
        });
      const subscription = watcher.subscribe(onChange);
      const ping = setInterval(() => send(': ping\n\n'), pingMs);
      close = () => {
        if (!open) return;
        open = false;
        clearInterval(ping);
        subscription.close();
        signal.removeEventListener('abort', end);
      };
      const end = () => {
        close();
        try {
          controller.close();
        } catch {}
      };
      const fail = (e: Error) => {
        close();
        controller.error(e);
      };
      signal.addEventListener('abort', end);
      step(async () => {
        await subscription.ready;
        snapshot();
      });
    },
    cancel: () => close(),
  });
};
