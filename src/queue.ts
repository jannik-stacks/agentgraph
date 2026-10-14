import { createHash } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { missing } from './jsonl.ts';
import { alive, self, type Owner } from './store.ts';

/**
 * A queued item: its id, who took it, how often it failed (`tries`), the last `error` and the time before which it
 * waits (`after`, ms since the epoch).
 */
export type Queued<T> = { id: string; item: T; taken?: Owner; tries?: number; error?: string; after?: number };

/**
 * Work waiting to run, in the order it was pushed. `push` is a no-op for an id already waiting or taken, `take` claims
 * the oldest waiting item `accept` agrees to for this process and `done` removes a taken one. `retry` puts a taken item
 * back to wait `delay` ms with its error, `fail` moves it to the failed items `failed` lists.
 */
export type Queue<T> = {
  push: (id: string, item: T) => Promise<boolean>;
  take: (accept?: (entry: Queued<T>) => boolean) => Promise<Queued<T> | undefined>;
  done: (id: string) => Promise<void>;
  retry: (id: string, error: string, delay: number) => Promise<void>;
  fail: (id: string, error: string) => Promise<void>;
  list: () => Promise<Queued<T>[]>;
  failed: () => Promise<Queued<T>[]>;
};

const hashed = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);
const pending = /^(\d{13}-\d{6})-([0-9a-f]{24})\.json$/;
const claimed = /^(\d{13}-\d{6})-([0-9a-f]{24})\.json\.(\d+)-(.+)$/;
let seq = 0;

/**
 * A queue of JSON files in `dir`, one per item, named so they sort in push order. Taking renames the file to carry its
 * owner, so two processes never take the same item; the first call returns items taken by a process that is gone to
 * the waiting ones. Failed items move to `dir/failed`.
 */
export const fileQueue = <T>(dir: string, owner: Owner = self): Queue<T> => {
  const failedDir = join(dir, 'failed');
  const names = async (at = dir) => (await readdir(at).catch(() => [])).sort();
  const find = async (id: string) =>
    (await names()).find(name => (pending.exec(name) ?? claimed.exec(name))?.[2] === hashed(id));
  const read = async (name: string, at = dir) => JSON.parse(await readFile(join(at, name), 'utf8')) as Queued<T>;
  const mine = async (id: string) => {
    const name = await find(id);
    const m = name && claimed.exec(name);
    return m ? { name, waiting: `${m[1]}-${m[2]}.json`, entry: await read(name) } : undefined;
  };
  const stored = ({ id, item, tries, error, after }: Queued<T>) =>
    JSON.stringify({ id, item, ...(tries && { tries }), ...(error && { error }), ...(after && { after }) });
  const replace = async (at: string, name: string, text: string) => {
    const tmp = join(at, `.${name}.${owner.token}.tmp`);
    await writeFile(tmp, text);
    await rename(tmp, join(at, name));
  };

  let recovered: Promise<void> | undefined;
  const ready = () =>
    (recovered ??= (async () => {
      await mkdir(dir, { recursive: true });
      for (const name of await names()) {
        const m = claimed.exec(name);
        if (m && !alive({ pid: Number(m[3]), token: m[4] ?? '' }, owner))
          await rename(join(dir, name), join(dir, `${m[1]}-${m[2]}.json`)).catch(e => {
            if (!missing(e)) throw e;
          });
      }
    })());

  return {
    push: async (id, item) => {
      await ready();
      if (await find(id)) return false;
      const name = `${String(Date.now()).padStart(13, '0')}-${String(seq++ % 1e6).padStart(6, '0')}-${hashed(id)}.json`;
      const tmp = join(dir, `.${name}.${owner.token}.tmp`);
      await writeFile(tmp, JSON.stringify({ id, item }));
      try {
        await link(tmp, join(dir, name));
        return true;
      } finally {
        await rm(tmp, { force: true });
      }
    },
    take: async (accept = () => true) => {
      await ready();
      for (const name of await names()) {
        if (!pending.test(name)) continue;
        const entry = await read(name).catch(e => {
          if (missing(e)) return;
          throw e;
        });
        if (!entry || !accept(entry)) continue;
        const taken = `${name}.${owner.pid}-${owner.token}`;
        try {
          await rename(join(dir, name), join(dir, taken));
        } catch (e) {
          if (missing(e)) continue;
          throw e;
        }
        return { ...(await read(taken)), taken: owner };
      }
      return undefined;
    },
    done: async id => {
      const name = await find(id);
      if (name && claimed.test(name)) await rm(join(dir, name), { force: true });
    },
    retry: async (id, error, delay) => {
      const found = await mine(id);
      if (!found) return;
      const { name, waiting, entry } = found;
      await replace(dir, name, stored({ ...entry, tries: (entry.tries ?? 0) + 1, error, after: Date.now() + delay }));
      await rename(join(dir, name), join(dir, waiting));
    },
    fail: async (id, error) => {
      const found = await mine(id);
      if (!found) return;
      const { name, waiting, entry } = found;
      await mkdir(failedDir, { recursive: true });
      const { after: _, ...rest } = entry;
      await replace(failedDir, waiting, stored({ ...rest, tries: (entry.tries ?? 0) + 1, error }));
      await rm(join(dir, name), { force: true });
    },
    list: async () => {
      await ready();
      const items = await Promise.all(
        (await names()).map(async name => {
          const m = claimed.exec(name);
          if (!m && !pending.test(name)) return;
          const entry = await read(name).catch(e => {
            if (missing(e)) return;
            throw e;
          });
          return entry && { ...entry, ...(m && { taken: { pid: Number(m[3]), token: m[4] ?? '' } }) };
        })
      );
      return items.filter(entry => entry !== undefined);
    },
    failed: async () =>
      Promise.all((await names(failedDir)).filter(name => pending.test(name)).map(name => read(name, failedDir))),
  };
};

/**
 * How a worker runs: at most `concurrency` items at once, never two with the same `key` (items with one key run in
 * push order), and a failing item is tried again after `backoff(tries)` ms, until `tries` failures move it to the
 * failed items.
 */
export type WorkerOptions<T> = {
  concurrency?: number;
  key?: (entry: Queued<T>) => string;
  tries?: number;
  backoff?: (tries: number) => number;
};

/**
 * Runs queued items while there are any (see `WorkerOptions`). `wake` starts taking after a push, `idle` resolves once
 * nothing runs, waits or is left to take, and `stop` lets the running items finish and takes no more. `onError` hears
 * every failure, with how it goes on.
 */
export const worker = <T>(
  queue: Queue<T>,
  run: (item: T) => Promise<void>,
  onError: (e: Error) => void,
  { concurrency = 1, key = entry => entry.id, tries = 5, backoff = n => 5000 * 2 ** (n - 1) }: WorkerOptions<T> = {}
) => {
  const running = new Map<string, Promise<void>>();
  const busy = new Set<string>();
  const later = new Map<ReturnType<typeof setTimeout>, { at: number; waited: Promise<void> }>();
  let taking: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const wakeAt = (at: number) => {
    if ([...later.values()].some(alarm => alarm.at <= at)) return;
    let timer: ReturnType<typeof setTimeout>;
    const waited = new Promise<void>(done => {
      timer = setTimeout(() => {
        later.delete(timer);
        done();
        void wake();
      }, at - Date.now());
    });
    later.set(timer!, { at, waited });
  };

  const start = (entry: Queued<T>) => {
    const lane = key(entry);
    busy.add(lane);
    const finished = (async () => {
      try {
        await run(entry.item);
        await queue.done(entry.id);
      } catch (e) {
        const message = (e as Error).message;
        const failures = (entry.tries ?? 0) + 1;
        if (failures >= tries) {
          await queue.fail(entry.id, message);
          onError(new Error(`${entry.id}: ${message}; failed ${failures} times, moved to the failed items`));
        } else {
          const delay = backoff(failures);
          await queue.retry(entry.id, message, delay);
          onError(new Error(`${entry.id}: ${message}; trying again in ${Math.round(delay / 1000)}s`));
        }
      }
    })()
      .catch(onError)
      .finally(() => {
        busy.delete(lane);
        running.delete(entry.id);
        void wake();
      });
    running.set(entry.id, finished);
  };

  const take = async () => {
    let due = Infinity;
    do {
      again = false;
      while (!stopped && running.size < concurrency) {
        const blocked = new Set(busy);
        const now = Date.now();
        const next = await queue.take(entry => {
          const lane = key(entry);
          if (blocked.has(lane)) return false;
          if ((entry.after ?? 0) > now) {
            due = Math.min(due, entry.after!);
            blocked.add(lane);
            return false;
          }
          return true;
        });
        if (!next) break;
        start(next);
      }
    } while (again && !stopped);
    if (due < Infinity && !stopped) wakeAt(due);
  };

  const wake = () => {
    if (taking) {
      again = true;
      return taking;
    }
    return (taking = take()
      .catch(onError)
      .finally(() => {
        taking = undefined;
      }));
  };

  return {
    wake,
    idle: async () => {
      while (taking || running.size || later.size)
        await Promise.all([taking, ...running.values(), ...[...later.values()].map(alarm => alarm.waited)]);
    },
    stop: async () => {
      stopped = true;
      for (const timer of later.keys()) clearTimeout(timer);
      later.clear();
      await taking;
      await Promise.all(running.values());
    },
  };
};
