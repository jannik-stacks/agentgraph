import { appendFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Data, Effect, Layer, Stream, type Scope } from 'effect';
import type { Verdict } from './check.ts';
import type { Applied } from './forge.ts';
import type { AgentEvent, SessionStop } from './session.ts';
import type { Outcome, Run } from './workflow.ts';

/** One line of a run's trace. */
export type Trace = { at: string; step: string } & (
  | { event: AgentEvent }
  | {
      session: {
        id?: string;
        resumed: boolean;
        ended: Extract<AgentEvent, { type: 'end' }>['ended'] | SessionStop['reason'];
        exit?: number;
        usd: number;
      };
    }
  | { verdict: Verdict; item?: string; exit?: number }
  | { applied: Applied }
  | { outcome: Outcome; run: Pick<Run, 'step' | 'status' | 'tries' | 'rounds'> }
);

export class StoreError extends Data.TaggedError('StoreError')<{ path: string; cause: unknown }> {}

/** Runs, traces and run files in the data dir. */
export class Store extends Context.Tag('bothub/Store')<
  Store,
  {
    get: (id: string) => Effect.Effect<Run | undefined, StoreError>;
    list: (filter?: Partial<Pick<Run, 'workflow' | 'thread' | 'status'>>) => Effect.Effect<Run[], StoreError>;
    put: (run: Run) => Effect.Effect<void, StoreError>;
    trace: (id: string, ...lines: Trace[]) => Effect.Effect<void, StoreError>;
    read: (id: string, from?: number) => Stream.Stream<Trace, StoreError>;
    lock: (name: string) => Effect.Effect<void, StoreError, Scope.Scope>;
  }
>() {}

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A run is `<dir>/<id>/run.json` and its trace `<dir>/<id>/trace.jsonl`. Locks are files whose holder is a pid. */
export const fileStore = (dir: string): Layer.Layer<Store> => {
  const io = <A>(path: string, f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: cause => new StoreError({ path, cause }) });
  const runFile = (id: string) => join(dir, id, 'run.json');
  const traceFile = (id: string) => join(dir, id, 'trace.jsonl');
  const readRun = (id: string) =>
    io(runFile(id), () =>
      readFile(runFile(id), 'utf8').then(
        text => JSON.parse(text) as Run,
        e => (missing(e) ? undefined : Promise.reject(e))
      )
    );
  const take = async (path: string) => {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const file = await open(path, 'wx');
        await file.writeFile(String(process.pid));
        await file.close();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const holder = Number(await readFile(path, 'utf8').catch(() => '0'));
        if (holder && alive(holder)) throw new Error(`held by ${holder}`);
        await rm(path, { force: true });
      }
    }
    throw new Error('lock contended');
  };

  return Layer.succeed(Store, {
    get: readRun,
    list: filter =>
      io(dir, () => readdir(dir).catch(e => (missing(e) ? [] : Promise.reject(e)))).pipe(
        Effect.flatMap(ids => Effect.forEach(ids, readRun)),
        Effect.map(runs =>
          runs.filter(
            (run): run is Run =>
              run !== undefined && Object.entries(filter ?? {}).every(([key, value]) => run[key as keyof Run] === value)
          )
        )
      ),
    put: run =>
      io(runFile(run.id), async () => {
        await mkdir(join(dir, run.id), { recursive: true });
        const tmp = `${runFile(run.id)}.tmp`;
        await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`);
        await rename(tmp, runFile(run.id));
      }),
    trace: (id, ...lines) =>
      io(traceFile(id), async () => {
        await mkdir(join(dir, id), { recursive: true });
        await appendFile(traceFile(id), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
      }),
    read: (id, from = 0) =>
      Stream.fromIterableEffect(
        io(traceFile(id), () =>
          readFile(traceFile(id), 'utf8').then(
            text =>
              text
                .split('\n')
                .filter(Boolean)
                .slice(from)
                .map(line => JSON.parse(line) as Trace),
            e => (missing(e) ? [] : Promise.reject(e))
          )
        )
      ),
    lock: name => {
      const path = join(dir, '.locks', `${name.replaceAll('/', '_')}.lock`);
      return Effect.acquireRelease(
        io(path, () => mkdir(join(dir, '.locks'), { recursive: true }).then(() => take(path))),
        () => Effect.promise(() => rm(path, { force: true }))
      );
    },
  });
};
