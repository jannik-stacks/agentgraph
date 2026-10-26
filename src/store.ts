import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { open, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { Chunk, Context, Data, Effect, Layer, Schema, Stream, type Scope } from 'effect';
import { createLock } from './owner.ts';
import type { CheckEntry, Log, Trace } from './trace.ts';
import { isRunDone, type Run } from './workflow.ts';

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

export const writeFileAtomic = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, typeof v === 'string' || v instanceof Uint8Array ? v : `${JSON.stringify(v, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};

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
    addChecks: (id: string, ...entries: CheckEntry[]) => Effect.Effect<void, StoreError>;
    readChecks: (id: string) => Effect.Effect<CheckEntry[], StoreError>;
    lock: (name: string) => Effect.Effect<void, StoreError, Scope.Scope>;
    log: (output: string, pass: boolean) => Effect.Effect<Log | undefined, StoreError>;
    readLog: (hash: string) => Effect.Effect<string | undefined, StoreError>;
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

/**
 * A run is `<dir>/<id>/run.json`, stamped `ended` when first stored done or stopped, its trace `<dir>/<id>/trace.jsonl` and its check record `<dir>/<id>/checks.jsonl`;
 * every put that changes the run first traces what changed, so a trace may hold a change its run.json missed. Locks carry a process owner and an acquisition id.
 * Check output is gzipped once per content at `<dir>/logs/<sha256>.gz`, as `logs` says.
 */
export const fileStore = (dir: string, logs: (typeof checkLogs)[number] = 'all'): Layer.Layer<Store> => {
  const io = <A>(path: string, f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: cause => new StoreError({ path, cause }) });
  const runFile = (id: string) => join(dir, id, 'run.json');
  const traceFile = (id: string) => join(dir, id, 'trace.jsonl');
  const checksFile = (id: string) => join(dir, id, 'checks.jsonl');
  const readLines = <A>(path: string) =>
    io(path, () =>
      readFile(path, 'utf8').then(
        text =>
          text.split('\n').flatMap((line, i, lines): A[] => {
            if (!line) return [];
            try {
              return [current(JSON.parse(line)) as A];
            } catch (e) {
              if (i === lines.length - 1) return [];
              throw e;
            }
          }),
        e => (missing(e) ? [] : Promise.reject(e))
      )
    );
  const readRun = (id: string) =>
    io(runFile(id), () =>
      readFile(runFile(id), 'utf8').then(
        text => current(JSON.parse(text)) as Run,
        e => (missing(e) ? undefined : Promise.reject(e))
      )
    );
  const writers = new Map<string, ReturnType<typeof Effect.unsafeMakeSemaphore>>();
  const append = (path: string, lines: unknown[]) => {
    const writer = writers.get(path) ?? Effect.unsafeMakeSemaphore(1);
    writers.set(path, writer);
    return writer.withPermits(1)(
      io(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        const file = await open(path, 'a+');
        try {
          const { size } = await file.stat();
          if (size > 0) {
            const last = Buffer.alloc(1);
            await file.read(last, 0, 1, size - 1);
            if (last[0] !== 10) {
              const content = await file.readFile();
              const cut = content.lastIndexOf(10) + 1;
              const tail = content.subarray(cut);
              let complete = true;
              try {
                JSON.parse(tail.toString('utf8'));
              } catch {
                complete = false;
              }
              if (complete) await file.appendFile('\n');
              else {
                await writeFile(`${path}.${randomUUID()}.partial`, tail);
                await file.truncate(cut);
              }
            }
          }
          await file.appendFile(lines.map(line => `${JSON.stringify(line)}\n`).join(''));
        } finally {
          await file.close();
        }
      })
    );
  };
  const trace = (id: string, ...lines: Trace[]) => append(traceFile(id), lines);

  const logFile = (hash: string) => join(dir, 'logs', `${hash}.gz`);
  const log = (output: string, pass: boolean) => {
    if (!output || logs === 'off' || (logs === 'failed' && pass)) return Effect.succeed(undefined);
    const hash = createHash('sha256').update(output).digest('hex');
    const path = logFile(hash);
    return io(path, async () => {
      if (!(await stat(path).catch(() => undefined))) writeFileAtomic(path, await promisify(gzip)(output));
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
    put: next =>
      Effect.gen(function* () {
        const before = yield* readRun(next.id);
        const { ended: _ended, ...open } = next;
        const ended = next.ended ?? before?.ended ?? new Date().toISOString();
        const run: Run = isRunDone(next) ? { ...next, ended } : open;
        const line = changes(before, run);
        if (line) yield* trace(run.id, line);
        yield* io(runFile(run.id), async () => writeFileAtomic(runFile(run.id), run));
      }),
    trace,
    read: (id, from = 0) =>
      Stream.fromIterableEffect(Effect.map(readLines<Trace>(traceFile(id)), lines => lines.slice(from))),
    addChecks: (id, ...entries) => append(checksFile(id), entries),
    readChecks: id => readLines<CheckEntry>(checksFile(id)),
    lock: name => {
      const path = join(dir, '.locks', `${name.replaceAll('/', '_')}.lock`);
      return Effect.asVoid(
        Effect.acquireRelease(
          io(path, () => mkdir(join(dir, '.locks'), { recursive: true }).then(() => createLock(path))),
          release => Effect.promise(release)
        )
      );
    },
    log,
    readLog: hash =>
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
 * @public
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

/** The check logs in `<dir>/logs` that no run's trace or check record names; they are deleted only when `apply` is set. */
export const pruneLogs = async (dir: string, apply = false) => {
  const named = new Set<string>();
  for (const id of await readdir(dir).catch(() => []))
    for (const file of ['trace.jsonl', 'checks.jsonl']) {
      const text = await readFile(join(dir, id, file), 'utf8').catch(() => '');
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
