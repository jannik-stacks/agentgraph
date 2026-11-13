import { getSha } from './hash.ts';
import { parseJson, readOrUndefined } from './read.ts';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { gunzip, gzip, zstdCompress, zstdDecompress, zstdDecompressSync } from 'node:zlib';
import { Context, Effect, Result, Layer, Schema, Stream, type Scope, Semaphore } from 'effect';
import { createLock, LockHeldError, waitForLock } from './owner.ts';
import { isRunDone } from './workflow.ts';
import { isOnIssue } from './graph.ts';
import { PluginMetadata, getRunOrigin } from './meta.ts';
import { CheckEntry, type Log, type Run, RunRecord, StoreError, Trace, type InstanceHost } from './types.ts';

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

export const checkLogs = ['all', 'failed', 'off'] as const;

export class Store extends Context.Service<
  Store,
  InstanceHost['store'] & {
    get: (id: string) => Effect.Effect<Run | undefined, StoreError>;
    put: (run: RunRecord) => Effect.Effect<void, StoreError>;
    trace: (id: string, ...lines: Trace[]) => Effect.Effect<void, StoreError>;
    addChecks: (id: string, ...entries: CheckEntry[]) => Effect.Effect<void, StoreError>;
    lock: (name: string) => Effect.Effect<void, StoreError, Scope.Scope>;
    log: (output: string, pass: boolean) => Effect.Effect<Log | undefined, StoreError>;
    putFile: (bytes: Uint8Array, signal: AbortSignal) => Effect.Effect<string, StoreError>;
    readFile: (hash: string) => Effect.Effect<Uint8Array, StoreError>;
  }
>()('agentgraph/Store') {}

const absent = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((e as NodeJS.ErrnoException).code));

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
  for (const id of await readdir(dir).catch(e => readOrUndefined(e) ?? [])) {
    const idle: string[] = [];
    for (const path of [getRecordPath(dir, id, 'trace'), getRecordPath(dir, id, 'checks')]) {
      const modified = await stat(path).then(
        s => s.mtimeMs,
        e => (absent(e) ? undefined : Promise.reject(e))
      );
      if (modified !== undefined && modified <= before) idle.push(path);
    }
    if (idle.length === 0) continue;
    if (!readRunSync(dir, id)?.ended) continue;
    for (const path of idle) {
      writeFileAtomic(`${path}.zst`, await promisify(zstdCompress)(await readFile(path)));
      await rm(path);
    }
  }
};

export const parseJsonlRows = <S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  text: string,
  schema: S
): S['Type'][] =>
  text.split('\n').flatMap((line, i, lines) => {
    if (!line) return [];
    if (i === lines.length - 1)
      try {
        JSON.parse(line);
      } catch (e) {
        console.error(`${path}: 1 skipped incomplete JSONL row at line ${i + 1}: ${String(e)}`);
        return [];
      }
    return [parseJson(schema, line, `${path}:${i + 1}`)];
  });

export const readJsonlRows = <S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S) =>
  parseJsonlRows(path, readRecordSync(path), schema);

const recordFiles = { run: 'run.json', trace: 'trace.jsonl', checks: 'checks.jsonl' } as const;

export const getRecordPath = (dir: string, id: string, record: keyof typeof recordFiles) =>
  join(dir, id, recordFiles[record]);

export const readRunSync = (dir: string, id: string) => {
  const path = getRecordPath(dir, id, 'run');
  return existsSync(path) ? parseJson(RunRecord, readFileSync(path, 'utf8'), path) : undefined;
};

export const readTraceSync = (dir: string, id: string) => readJsonlRows(getRecordPath(dir, id, 'trace'), Trace);

export const readChecksSync = (dir: string, id: string) => readJsonlRows(getRecordPath(dir, id, 'checks'), CheckEntry);

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

export const fileStore = (dir: string, logs: (typeof checkLogs)[number] = 'all'): Layer.Layer<Store> => {
  const io = <A>(path: string, f: () => Promise<A>) =>
    Effect.tryPromise({ try: f, catch: cause => new StoreError({ path, cause }) });
  const runFile = (id: string) => getRecordPath(dir, id, 'run');
  const traceFile = (id: string) => getRecordPath(dir, id, 'trace');
  const checksFile = (id: string) => getRecordPath(dir, id, 'checks');
  const readLines = <S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S) =>
    io(path, async () => parseJsonlRows(path, await readRecord(path), schema));
  const readRun = (id: string) =>
    io(runFile(id), () =>
      readFile(runFile(id), 'utf8').then(text => parseJson(RunRecord, text, runFile(id)), readOrUndefined)
    );
  const listRecords = (filter: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>> = {}) =>
    io(dir, () => readdir(dir).catch(e => readOrUndefined(e) ?? [])).pipe(
      Effect.flatMap(ids =>
        Effect.forEach(
          ids,
          id => Effect.catch(readRun(id), e => Effect.as(Effect.logWarning(`1 skipped run ${e.message}`), undefined)),
          { concurrency: 8 }
        )
      ),
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
    const hash = getSha(output);
    const path = logFile(hash);
    return io(path, async () => {
      if (!(await stat(path).catch(readOrUndefined))) writeFileAtomic(path, await promisify(gzip)(output));
      return { hash, bytes: Buffer.byteLength(output) };
    });
  };

  return Layer.succeed(Store, {
    putFile: (input, signal) =>
      io(join(dir, 'files'), async () => {
        signal.throwIfAborted();
        const bytes = new Uint8Array(input);
        const hash = getSha(bytes);
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
        if (getSha(bytes) !== hash) throw new Error('file hash mismatch');
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
      Stream.fromIterableEffect(Effect.map(readLines(traceFile(id), Trace), lines => lines.slice(from))),
    addChecks: (id, ...entries) => appendJsonlRows(checksFile(id), entries),
    readChecks: id => readLines(checksFile(id), CheckEntry),
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
            readFile(logFile(hash)).then(async gz => (await promisify(gunzip)(gz)).toString('utf8'), readOrUndefined)
          )
        : Effect.succeed(undefined),
  });
};

const Query = Schema.Struct({ gh: Schema.Trim.check(Schema.isNonEmpty()) });

export type Located = { run: string; step: string; at: string } | { issue: number };

/** @public */
export const locate = (input: unknown, store: Pick<Store['Service'], 'list' | 'read'>) =>
  Effect.gen(function* () {
    const { gh } = yield* Schema.decodeUnknownEffect(Query)(input);
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

export const pruneLogs = async (dir: string, apply = false) => {
  const named = new Set<string>();
  for (const id of await readdir(dir).catch(e => readOrUndefined(e) ?? []))
    for (const record of ['trace', 'checks'] as const)
      for (const [hash] of (await readRecord(getRecordPath(dir, id, record))).matchAll(/[0-9a-f]{64}/g))
        named.add(hash);
  const unused = { files: 0, bytes: 0 };
  for (const name of await readdir(join(dir, 'logs')).catch(e => readOrUndefined(e) ?? [])) {
    const hash = /^([0-9a-f]{64})\.gz$/.exec(name)?.[1];
    if (!hash || named.has(hash)) continue;
    const path = join(dir, 'logs', name);
    unused.files++;
    unused.bytes += (await stat(path)).size;
    if (apply) await rm(path);
  }
  return unused;
};
