import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { gunzip, gzip, zstdCompress, zstdDecompress, zstdDecompressSync } from 'node:zlib';
import { Context, Data, Effect, Result, Layer, Schema, Stream, type Scope, Semaphore } from 'effect';
import { createLock, LockHeldError, waitForLock } from './owner.ts';
import type { CheckEntry, Log, Trace } from './trace.ts';
import { isRunDone, type Run, type RunRecord } from './workflow.ts';
import { isOnIssue } from './graph.ts';
import { PluginMetadata, getRunOrigin } from './meta.ts';
import { ResultSheet } from './results.ts';
import { formatCause } from './sandbox.ts';

/** The trace line for a put of `next` over `before`, or none when nothing changed. */
const changes = (before: RunRecord | undefined, next: RunRecord): Trace | undefined => {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(next)])] as (keyof RunRecord)[];
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

const syncDirectory = async (path: string) => {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
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

const parseResultSheet = (value: unknown) => {
  const decoded = Schema.decodeUnknownResult(ResultSheet, { onExcessProperty: 'error' })(value);
  if (Result.isFailure(decoded)) throw new Error('invalid result sheet');
  return decoded.success;
};

export const readResultSheet = (path: string) => {
  if (statSync(path).size > 16_777_216) throw new Error('result sheet exceeds 16 MiB');
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > 16_777_216) throw new Error('result sheet exceeds 16 MiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('invalid result sheet JSON');
  }
  return parseResultSheet(value);
};

export const writeResultSheet = (path: string, value: typeof ResultSheet.Type) => {
  const checked = parseResultSheet(value);
  const text = `${JSON.stringify(checked, null, 2)}\n`;
  if (Buffer.byteLength(text) > 16_777_216) throw new Error('result sheet exceeds 16 MiB');
  writeFileAtomic(path, text);
};

export const readResultSheets = (roots: readonly string[]) => {
  const found: { key: string; sheet: ReturnType<typeof readResultSheet> }[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let rows = 0;
  const visit = (dir: string, root: string, index: number, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0 && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        visit(path, root, index, depth - 1);
      if (!entry.isFile() || entry.name !== 'results.json') continue;
      const real = realpathSync(path);
      if (seen.has(real)) continue;
      seen.add(real);
      bytes += statSync(path).size;
      if (found.length >= 256 || bytes > 33_554_432) throw new Error('result exports exceed 256 files or 32 MiB');
      const sheet = readResultSheet(path);
      rows += sheet.runs.length;
      if (rows > 10000) throw new Error('result exports exceed 10000 rows');
      found.push({ key: `${index}/${relative(root, path)}`, sheet });
    }
  };
  roots.forEach((root, index) => visit(root, root, index, 2));
  return found;
};

/** Which check output the store keeps: every run's, only failing ones', or none. */
export const checkLogs = ['all', 'failed', 'off'] as const;

export class StoreError extends Data.TaggedError('StoreError')<{ path: string; cause: unknown }> {
  override get message() {
    return `${this.path}: ${formatCause(this.cause)}`;
  }
}

/** Runs, traces and run files in the data dir. */
export class Store extends Context.Service<
  Store,
  {
    get: (id: string) => Effect.Effect<Run | undefined, StoreError>;
    getRecord: (id: string) => Effect.Effect<RunRecord | undefined, StoreError>;
    list: (filter?: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>>) => Effect.Effect<Run[], StoreError>;
    listRecords: (
      filter?: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>>
    ) => Effect.Effect<RunRecord[], StoreError>;
    put: (run: RunRecord) => Effect.Effect<void, StoreError>;
    trace: (id: string, ...lines: Trace[]) => Effect.Effect<void, StoreError>;
    read: (id: string, from?: number) => Stream.Stream<Trace, StoreError>;
    addChecks: (id: string, ...entries: CheckEntry[]) => Effect.Effect<void, StoreError>;
    readChecks: (id: string) => Effect.Effect<CheckEntry[], StoreError>;
    lock: (name: string) => Effect.Effect<void, StoreError, Scope.Scope>;
    log: (output: string, pass: boolean) => Effect.Effect<Log | undefined, StoreError>;
    readLog: (hash: string) => Effect.Effect<string | undefined, StoreError>;
    putFile: (bytes: Uint8Array, signal: AbortSignal) => Effect.Effect<string, StoreError>;
    readFile: (hash: string) => Effect.Effect<Uint8Array, StoreError>;
  }
>()('agentgraph/Store') {}

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
  if (key === 'meta') return value;
  if (typeof value === 'string') return values[key]?.[value] ?? value;
  if (key === 'said' && value && !Array.isArray(value)) return [current(value)];
  if (Array.isArray(value))
    return value.map(v => (key === 'cleared' && typeof v === 'string' ? (renamed[v] ?? v) : current(v)));
  if (!value || typeof value !== 'object' || 'event' in value || key === 'rounds' || key === 'sessions') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [renamed[k] ?? k, current(v, k)]));
};

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

const absent = (e: unknown) => missing(e) || (e as NodeJS.ErrnoException).code === 'ENOTDIR';

export const readRecordSync = (path: string) => {
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return existsSync(`${path}.zst`) ? zstdDecompressSync(readFileSync(`${path}.zst`)).toString('utf8') : '';
};

const catchAbsent = <A>(read: Promise<A>, otherwise: () => Promise<A>) =>
  read.catch(e => (absent(e) ? otherwise() : Promise.reject(e)));

const readRecord = (path: string): Promise<string> =>
  catchAbsent(readFile(path, 'utf8'), () =>
    catchAbsent(
      readFile(`${path}.zst`).then(async packed => (await promisify(zstdDecompress)(packed)).toString('utf8')),
      // UNEXPECTED: an append can unpack the record between the plain and the compressed read.
      () => catchAbsent(readFile(path, 'utf8'), async () => '')
    )
  );

export const writeIdleRunsCompressed = async (dir: string, days: number) => {
  if (!days) return;
  const before = Date.now() - days * 86_400_000;
  for (const id of await readdir(dir).catch(e => (missing(e) ? [] : Promise.reject(e)))) {
    const idle: string[] = [];
    for (const path of ['trace.jsonl', 'checks.jsonl'].map(file => join(dir, id, file))) {
      const modified = await stat(path).then(
        s => s.mtimeMs,
        e => (absent(e) ? undefined : Promise.reject(e))
      );
      if (modified !== undefined && modified <= before) idle.push(path);
    }
    if (idle.length === 0) continue;
    const run = await readRecord(join(dir, id, 'run.json'));
    if (!run || !JSON.parse(run).ended) continue;
    for (const path of idle) {
      writeFileAtomic(`${path}.zst`, await promisify(zstdCompress)(await readFile(path)));
      await rm(path);
    }
  }
};

const parseJsonlRows = (path: string, text: string): unknown[] =>
  text.split('\n').flatMap((line, i, lines) => {
    if (!line) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (e) {
      if (i === lines.length - 1) {
        console.error(`${path}: 1 skipped incomplete JSONL row at line ${i + 1}: ${String(e)}`);
        return [];
      }
      throw e;
    }
  });

export const readJsonlRows = (path: string) => parseJsonlRows(path, readRecordSync(path));

const writers = new Map<string, Semaphore.Semaphore>();

export const appendJsonlRows = (path: string, lines: unknown[]) => {
  const writer = writers.get(path) ?? Semaphore.makeUnsafe(1);
  writers.set(path, writer);
  return writer.withPermits(1)(
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        const release = await waitForLock(
          `${basename(dirname(path))}.${basename(path)}`,
          join(dirname(path), '..', '.locks')
        );
        try {
          if (existsSync(`${path}.zst`)) {
            writeFileAtomic(path, await readRecord(path));
            await rm(`${path}.zst`);
          }
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
            await file.sync();
          } finally {
            await file.close();
          }
          await syncDirectory(dirname(path));
        } finally {
          await release();
        }
      },
      catch: cause => new StoreError({ path, cause }),
    })
  );
};

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
    io(path, async () => parseJsonlRows(path, await readRecord(path)).map(row => current(row) as A));
  const readRun = (id: string) =>
    io(runFile(id), () =>
      readFile(runFile(id), 'utf8').then(
        text => current(JSON.parse(text)) as RunRecord,
        e => (missing(e) ? undefined : Promise.reject(e))
      )
    );
  const listRecords = (filter: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>> = {}) =>
    io(dir, () => readdir(dir).catch(e => (missing(e) ? [] : Promise.reject(e)))).pipe(
      Effect.flatMap(ids => Effect.forEach(ids, readRun)),
      Effect.map(runs =>
        runs.filter(
          (run): run is RunRecord =>
            run !== undefined && Object.entries(filter).every(([key, value]) => run[key as keyof Run] === value)
        )
      )
    );
  const trace = (id: string, ...lines: Trace[]) => appendJsonlRows(traceFile(id), lines);

  const logFile = (hash: string) => join(dir, 'logs', `${hash}.gz`);
  const log = (output: string, pass: boolean) => {
    if (!output || logs === 'off' || (logs === 'failed' && pass)) return Effect.succeed(undefined);
    const hash = createHash('sha256').update(output).digest('hex');
    const path = logFile(hash);
    return io(path, async () => {
      if (!(await stat(path).catch(e => (missing(e) ? undefined : Promise.reject(e)))))
        writeFileAtomic(path, await promisify(gzip)(output));
      return { hash, bytes: Buffer.byteLength(output) };
    });
  };

  return Layer.succeed(Store, {
    putFile: (input, signal) =>
      io(join(dir, 'files'), async () => {
        signal.throwIfAborted();
        const bytes = new Uint8Array(input);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const folder = join(dir, 'files');
        const path = join(folder, hash);
        const temporary = `${path}.${randomUUID()}.tmp`;
        await mkdir(folder, { recursive: true });
        try {
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(bytes, { signal });
            await file.sync();
          } finally {
            await file.close();
          }
          signal.throwIfAborted();
          await rename(temporary, path);
          await syncDirectory(folder);
          await syncDirectory(dir);
          return hash;
        } finally {
          await rm(temporary, { force: true });
        }
      }),
    readFile: hash =>
      io(join(dir, 'files', hash), async () => {
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid file hash');
        const bytes = await readFile(join(dir, 'files', hash));
        if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('file hash mismatch');
        return bytes;
      }),
    getRecord: readRun,
    get: id => readRun(id).pipe(Effect.map(run => (run && isOnIssue(run) ? run : undefined))),
    listRecords,
    list: filter => listRecords(filter).pipe(Effect.map(runs => runs.filter(isOnIssue))),
    put: next =>
      Effect.gen(function* () {
        const before = yield* readRun(next.id);
        yield* io(runFile(next.id), async () => {
          if (next.meta !== undefined && Result.isFailure(Schema.decodeUnknownResult(PluginMetadata)(next.meta)))
            throw new Error('invalid run metadata');
          if (before && !isDeepStrictEqual(getRunOrigin(before.meta), getRunOrigin(next.meta)))
            throw new Error('engine origin cannot change after run creation');
        });
        const { ended: _ended, ...open } = next;
        const ended = next.ended ?? before?.ended ?? new Date().toISOString();
        const run: RunRecord = isRunDone(next) ? { ...next, ended } : open;
        const line = changes(before, run);
        if (line) yield* trace(run.id, line);
        yield* io(runFile(run.id), async () => writeFileAtomic(runFile(run.id), run));
      }),
    trace,
    read: (id, from = 0) =>
      Stream.fromIterableEffect(Effect.map(readLines<Trace>(traceFile(id)), lines => lines.slice(from))),
    addChecks: (id, ...entries) => appendJsonlRows(checksFile(id), entries),
    readChecks: id => readLines<CheckEntry>(checksFile(id)),
    lock: name => {
      const path = join(dir, '.locks', `${name.replaceAll('/', '_')}.lock`);
      return Effect.asVoid(
        Effect.acquireRelease(
          io(path, () => mkdir(join(dir, '.locks'), { recursive: true }).then(() => createLock(path))),
          release => Effect.promise(release)
        )
      ).pipe(
        Effect.tapError(e => (e.cause instanceof LockHeldError ? Effect.void : Effect.logError(`lock ${path}`, e)))
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

const Query = Schema.Struct({ gh: Schema.Trim.check(Schema.isNonEmpty()) });

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
    const { gh } = yield* Schema.decodeUnknownEffect(Query)(input);
    const store = yield* Store;
    const id = /(?:#discussion_r|#issuecomment-|#r|^)(\d+)$/.exec(gh)?.[1];
    const url = gh.replace(/\/+$/, '');
    let found: { run: Run; step: string; at: string } | undefined;
    for (const run of yield* store.list())
      for (const line of yield* Stream.runCollect(store.read(run.id))) {
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
  for (const id of await readdir(dir).catch(e => (missing(e) ? [] : Promise.reject(e))))
    for (const file of ['trace.jsonl', 'checks.jsonl'])
      for (const [hash] of (await readRecord(join(dir, id, file))).matchAll(/[0-9a-f]{64}/g)) named.add(hash);
  const unused = { files: 0, bytes: 0 };
  for (const name of await readdir(join(dir, 'logs')).catch(e => (missing(e) ? [] : Promise.reject(e)))) {
    const hash = /^([0-9a-f]{64})\.gz$/.exec(name)?.[1];
    if (!hash || named.has(hash)) continue;
    const path = join(dir, 'logs', name);
    unused.files++;
    unused.bytes += (await stat(path)).size;
    if (apply) await rm(path);
  }
  return unused;
};
