import { createHash } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { alive, self, type Owner } from './store.ts';

export type Queued<T> = { id: string; item: T; taken?: Owner };

/**
 * Work waiting to run, in the order it was pushed. `push` is a no-op for an id already waiting or taken, `take` claims
 * the oldest waiting item for this process and `done` removes a taken one.
 */
export type Queue<T> = {
  push: (id: string, item: T) => Promise<boolean>;
  take: () => Promise<Queued<T> | undefined>;
  done: (id: string) => Promise<void>;
  list: () => Promise<Queued<T>[]>;
};

const hashed = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 24);
const pending = /^(\d{13}-\d{6})-([0-9a-f]{24})\.json$/;
const claimed = /^(\d{13}-\d{6})-([0-9a-f]{24})\.json\.(\d+)-(.+)$/;
const gone = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * A queue of JSON files in `dir`, one per item, named so they sort in push order. Taking renames the file to carry its
 * owner, so two processes never take the same item; the first call returns items taken by a process that is gone to
 * the waiting ones.
 */
export const fileQueue = <T>(dir: string, owner: Owner = self): Queue<T> => {
  let seq = 0;
  const names = async () => (await readdir(dir).catch(() => [])).sort();
  const find = async (id: string) =>
    (await names()).find(name => (pending.exec(name) ?? claimed.exec(name))?.[2] === hashed(id));
  const read = async (name: string) => JSON.parse(await readFile(join(dir, name), 'utf8')) as Queued<T>;

  let recovered: Promise<void> | undefined;
  const ready = () =>
    (recovered ??= (async () => {
      await mkdir(dir, { recursive: true });
      for (const name of await names()) {
        const m = claimed.exec(name);
        if (m && !alive({ pid: Number(m[3]), token: m[4] ?? '' }, owner))
          await rename(join(dir, name), join(dir, `${m[1]}-${m[2]}.json`)).catch(e => {
            if (!gone(e)) throw e;
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
    take: async () => {
      await ready();
      for (const name of await names()) {
        if (!pending.test(name)) continue;
        const mine = `${name}.${owner.pid}-${owner.token}`;
        try {
          await rename(join(dir, name), join(dir, mine));
        } catch (e) {
          if (gone(e)) continue;
          throw e;
        }
        return { ...(await read(mine)), taken: owner };
      }
      return undefined;
    },
    done: async id => {
      const name = await find(id);
      if (name && claimed.test(name)) await rm(join(dir, name), { force: true });
    },
    list: async () => {
      await ready();
      const items = await Promise.all(
        (await names()).map(async name => {
          const m = claimed.exec(name);
          if (!m && !pending.test(name)) return;
          const entry = await read(name).catch(e => {
            if (gone(e)) return;
            throw e;
          });
          return entry && { ...entry, ...(m && { taken: { pid: Number(m[3]), token: m[4] ?? '' } }) };
        })
      );
      return items.filter(entry => entry !== undefined);
    },
  };
};

/**
 * Runs queued items one after another while there are any. `wake` starts draining after a push, `idle` resolves once
 * the queue is drained and `stop` lets the running item finish and takes no more.
 */
export const worker = <T>(queue: Queue<T>, run: (item: T) => Promise<void>, onError: (e: Error) => void) => {
  let draining: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  const drain = async () => {
    do {
      again = false;
      for (let next; !stopped && (next = await queue.take());) {
        try {
          await run(next.item);
        } catch (e) {
          onError(e as Error);
        } finally {
          await queue.done(next.id);
        }
      }
    } while (again && !stopped);
  };
  const wake = () => {
    if (draining) {
      again = true;
      return draining;
    }
    return (draining = drain()
      .catch(onError)
      .finally(() => {
        draining = undefined;
      }));
  };
  return {
    wake,
    idle: async () => {
      while (draining) await draining;
    },
    stop: async () => {
      stopped = true;
      await draining;
    },
  };
};
