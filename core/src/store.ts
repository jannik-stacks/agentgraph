import { appendFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Data, Effect, Layer, Stream, type Scope } from 'effect';
import type { CheckResult } from './check.ts';
import type { Applied } from './forge.ts';
import type { SessionEvent, SessionSpec, SessionStop } from './session.ts';
import type { Outcome, Run } from './workflow.ts';

/**
 * One line of a run's trace. A `prompt` line holds everything a session is opened with and precedes its events. A
 * `saved` line holds the fields of `run.json` that a put changed, and `cleared` the ones it removed.
 */
export type Trace = { at: string; step: string } & (
  | { prompt: SessionSpec; item?: string }
  | { event: SessionEvent }
  | {
      session: {
        id?: string;
        resumed: boolean;
        ended: Extract<SessionEvent, { type: 'end' }>['ended'] | SessionStop['reason'];
        exit?: number;
        usd: number;
      };
    }
  | { check: CheckResult; item?: string; exit?: number }
  | { applied: Applied }
  | { outcome: Outcome; run: Pick<Run, 'step' | 'status' | 'tries' | 'rounds'> }
  | { saved: Partial<Run>; cleared?: (keyof Run)[] }
);

/** The trace line for a put of `next` over `before`, or none when nothing changed. */
const changes = (before: Run | undefined, next: Run): Trace | undefined => {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(next)])] as (keyof Run)[];
  const changed = keys.filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(next[k]));
  if (changed.length === 0) return;
  const cleared = changed.filter(k => next[k] === undefined);
  return {
    at: new Date().toISOString(),
    step: next.step,
    saved: Object.fromEntries(changed.filter(k => next[k] !== undefined).map(k => [k, next[k]])),
    ...(cleared.length > 0 && { cleared }),
  };
};

export class StoreError extends Data.TaggedError('StoreError')<{ path: string; cause: unknown }> {}

/** Runs, traces and run files in the data dir. */
export class Store extends Context.Tag('bothub/Store')<
  Store,
  {
    get: (id: string) => Effect.Effect<Run | undefined, StoreError>;
    list: (filter?: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>>) => Effect.Effect<Run[], StoreError>;
    put: (run: Run) => Effect.Effect<void, StoreError>;
    trace: (id: string, ...lines: Trace[]) => Effect.Effect<void, StoreError>;
    read: (id: string, from?: number) => Stream.Stream<Trace, StoreError>;
    lock: (name: string) => Effect.Effect<void, StoreError, Scope.Scope>;
  }
>() {}

const renamed: Record<string, string> = {
  brief: 'prompt',
  carry: 'feedback',
  thread: 'issue',
  into: 'base',
  verdict: 'check',
  failing: 'checks',
  rejected: 'proposals',
};
const values: Record<string, Record<string, string>> = {
  kind: { reply: 'comment', pull: 'pull_request', refused: 'failed' },
  status: { asking: 'waiting' },
};

/** A run or trace line as older versions wrote it, read with today's field names and values. */
const current = (value: unknown, key = ''): unknown => {
  if (typeof value === 'string') return values[key]?.[value] ?? value;
  if (Array.isArray(value))
    return value.map(v => (key === 'cleared' && typeof v === 'string' ? (renamed[v] ?? v) : current(v)));
  if (!value || typeof value !== 'object' || 'event' in value || key === 'rounds' || key === 'sessions') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [renamed[k] ?? k, current(v, k)]));
};

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A run is `<dir>/<id>/run.json` and its trace `<dir>/<id>/trace.jsonl`; every put that changes the run also traces
 * what changed. Locks are files whose holder is a pid.
 */
export const fileStore = (dir: string): Layer.Layer<Store> => {
  const io = <A>(path: string, f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: cause => new StoreError({ path, cause }) });
  const runFile = (id: string) => join(dir, id, 'run.json');
  const traceFile = (id: string) => join(dir, id, 'trace.jsonl');
  const readRun = (id: string) =>
    io(runFile(id), () =>
      readFile(runFile(id), 'utf8').then(
        text => current(JSON.parse(text)) as Run,
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

  const trace = (id: string, ...lines: Trace[]) =>
    io(traceFile(id), async () => {
      await mkdir(join(dir, id), { recursive: true });
      await appendFile(traceFile(id), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
    });

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
      Effect.gen(function* () {
        const line = changes(yield* readRun(run.id), run);
        yield* io(runFile(run.id), async () => {
          await mkdir(join(dir, run.id), { recursive: true });
          const tmp = `${runFile(run.id)}.tmp`;
          await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`);
          await rename(tmp, runFile(run.id));
        });
        if (line) yield* trace(run.id, line);
      }),
    trace,
    read: (id, from = 0) =>
      Stream.fromIterableEffect(
        io(traceFile(id), () =>
          readFile(traceFile(id), 'utf8').then(
            text =>
              text
                .split('\n')
                .filter(Boolean)
                .slice(from)
                .map(line => current(JSON.parse(line)) as Trace),
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
