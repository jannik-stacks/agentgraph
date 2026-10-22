import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { Chunk, Context, Data, Effect, Layer, Schema, Stream, type Scope } from 'effect';
import type { Applied, Event } from './forge.ts';
import type { SessionEvent, SessionSpec, SessionStop } from './session.ts';
import type { CheckResult, Outcome, Run } from './workflow.ts';

/** The comment an aside answered, when the run noted it. */
export type Aside = { issue?: number; comment?: string; review?: true };

/**
 * One line of a run's trace. A `prompt` line holds everything a session is opened with and precedes its events. A
 * `saved` line holds the fields of `run.json` that a put changed, and `cleared` the ones it removed. A session's prompt,
 * event and session lines share its `key`, so sessions running at once stay apart.
 */
export type Trace = { at: string; step: string } & (
  | { prompt: SessionSpec; key?: string; item?: string; aside?: Aside }
  | { event: SessionEvent; key?: string }
  | {
      key?: string;
      session: {
        id?: string;
        resumed: boolean;
        aside?: true;
        ended: Extract<SessionEvent, { type: 'end' }>['ended'] | SessionStop['reason'];
        exit?: number;
        usd: number;
      };
    }
  | { check: CheckResult; item?: string; exit?: number; log?: Log }
  | { setup: { ms: number; exit: number } }
  | { applied: Applied }
  | { outcome: Outcome; run: Pick<Run, 'step' | 'status' | 'tries' | 'rounds'> }
  | { saved: Partial<Run>; cleared?: (keyof Run)[] }
  | { spoken: Event }
  | { told: { text: string; by: string } }
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

/** A check's full output in the store: its sha256 and its length in bytes. */
export type Log = { hash: string; bytes: number };

/** Which check output the store keeps: every run's, only failing ones', or none. */
export const checkLogs = ['all', 'failed', 'off'] as const;

export class StoreError extends Data.TaggedError('StoreError')<{ path: string; cause: unknown }> {}

/** Runs, traces and run files in the data dir. */
export class Store extends Context.Tag('agentgraph/Store')<
  Store,
  {
    get: (id: string) => Effect.Effect<Run | undefined, StoreError>;
    list: (filter?: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>>) => Effect.Effect<Run[], StoreError>;
    put: (run: Run) => Effect.Effect<void, StoreError>;
    trace: (id: string, ...lines: Trace[]) => Effect.Effect<void, StoreError>;
    read: (id: string, from?: number) => Stream.Stream<Trace, StoreError>;
    lock: (name: string) => Effect.Effect<void, StoreError, Scope.Scope>;
    log: (output: string, pass: boolean) => Effect.Effect<Log | undefined, StoreError>;
    logOf: (hash: string) => Effect.Effect<string | undefined, StoreError>;
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
  bot: 'agent',
};
const values: Record<string, Record<string, string>> = {
  kind: { reply: 'comment', pull: 'pull_request', refused: 'failed' },
  status: { asking: 'waiting' },
};

/** A run or trace line as older versions wrote it, read with today's field names and values. */
const current = (value: unknown, key = ''): unknown => {
  if (typeof value === 'string') return values[key]?.[value] ?? value;
  if (key === 'said' && value && !Array.isArray(value)) return [current(value)];
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
 * what changed. Locks are files whose holder is a pid. Check output is gzipped once per content at
 * `<dir>/logs/<sha256>.gz`, as `logs` says.
 */
export const fileStore = (dir: string, logs: (typeof checkLogs)[number] = 'all'): Layer.Layer<Store> => {
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
        if (holder && alive(holder)) throw new Error(`held by ${holder}`, { cause: e });
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

  const logFile = (hash: string) => join(dir, 'logs', `${hash}.gz`);
  const log = (output: string, pass: boolean) => {
    if (!output || logs === 'off' || (logs === 'failed' && pass)) return Effect.succeed(undefined);
    const hash = createHash('sha256').update(output).digest('hex');
    const path = logFile(hash);
    return io(path, async () => {
      if (!(await stat(path).catch(() => undefined))) {
        await mkdir(join(dir, 'logs'), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, await promisify(gzip)(output));
        await rename(tmp, path);
      }
      return { hash, bytes: Buffer.byteLength(output) };
    });
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
    log,
    logOf: hash =>
      /^[0-9a-f]{64}$/.test(hash)
        ? io(logFile(hash), () =>
            readFile(logFile(hash)).then(
              async gz => (await promisify(gunzip)(gz)).toString('utf8'),
              e => (missing(e) ? undefined : Promise.reject(e))
            )
          )
        : Effect.succeed(undefined),
  });
};

const Query = Schema.Struct({ gh: Schema.Trim.pipe(Schema.nonEmptyString()) });

/** A write of a run, at the time the studio opens it at, or an issue whose runs to show. */
export type Located = { run: string; step: string; at: string } | { issue: number };

/**
 * The write a GitHub link or comment id names: the newest `applied` line whose URL is the link or whose comment id is
 * the id, as its run, its step and the time the studio opens it at. A link with no comment in it, or a comment no run
 * wrote, names an issue instead: the one whose run opened it, else the number in the link.
 */
export const locate = (input: unknown) =>
  Effect.gen(function* () {
    const { gh } = yield* Schema.decodeUnknown(Query)(input);
    const store = yield* Store;
    const id = /(?:#discussion_r|#issuecomment-|#r|^)(\d+)$/.exec(gh)?.[1];
    const url = gh.replace(/\/+$/, '');
    let found: { run: Run; step: string; at: string } | undefined;
    for (const run of yield* store.list())
      for (const line of Chunk.toArray(yield* Stream.runCollect(store.read(run.id)))) {
        if (!('applied' in line)) continue;
        const { applied: a } = line;
        if (a.url !== url && !(id && a.proposal.kind === 'comment' && a.id === id)) continue;
        const at = a.at ?? line.at;
        if (!found || at > found.at) found = { run, step: line.step, at };
      }
    if (found && id) return { run: found.run.id, step: found.step, at: found.at };
    const issue = found?.run.issue ?? Number(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/.exec(gh)?.[1]);
    return issue ? { issue } : undefined;
  });

/** The check logs in `<dir>/logs` that no run's trace names; they are deleted only when `apply` is set. */
export const pruneLogs = async (dir: string, apply = false) => {
  const named = new Set<string>();
  for (const id of await readdir(dir).catch(() => [])) {
    const text = await readFile(join(dir, id, 'trace.jsonl'), 'utf8').catch(() => '');
    for (const [hash] of text.matchAll(/[0-9a-f]{64}/g)) named.add(hash);
  }
  const unused = { files: 0, bytes: 0 };
  for (const name of await readdir(join(dir, 'logs')).catch(() => [])) {
    const hash = /^([0-9a-f]{64})\.gz$/.exec(name)?.[1];
    if (!hash || named.has(hash)) continue;
    const path = join(dir, 'logs', name);
    unused.files++;
    unused.bytes += (await stat(path)).size;
    if (apply) await rm(path);
  }
  return unused;
};
