import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { compile, type ConfigError } from './config.ts';
import { listPulls, pullDiff, runDiff } from './diffs.ts';
import { fingerprint, srcDir as ownSrc } from './fingerprint.ts';
import { hubWriteRoutes } from './hub-write.ts';
import { liveStream, watchRuns } from './live.ts';
import { readHub } from './load.ts';
import { fail, isLocal, localJson } from './local-json.ts';
import { Missing } from './pulls.ts';
import { Invalid, comment } from './review.ts';
import { alive, type Run, type RunStatus, type Store } from './store.ts';
import type { Price } from './usage.ts';

export type Handler = (req: Request) => Promise<Response>;

/** What `GET /api/info` answers: the hub and data directories, where the data directory really is, and the process. */
export type ApiInfo = {
  hub: string;
  data: string;
  dataReal: string | null;
  pid: number;
  version: string;
  hubErrors: ConfigError[];
};

/** What `GET /api/build` answers: the source fingerprint the server runs, the one on disk, and whether they differ. */
export type ApiBuild = { running: string; disk: string; stale: boolean };

const live: RunStatus[] = ['queued', 'running'];
const failed: RunStatus[] = ['failed', 'timed-out', 'interrupted'];

/** Queued or running, and owned by a process that may still be running it. */
export const isLive = (run: Run) => live.includes(run.status) && (!run.owner || alive(run.owner));
const notFound = () => fail('not found', 404);

const diffOptions = (url: URL) => ({
  whitespace: url.searchParams.get('whitespace') === 'hide' ? ('hide' as const) : ('show' as const),
});

const offset = (value: string | null) => {
  if (value === null || value === '') return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

/**
 * Runs waiting on a human, newest first: those that asked a question, those blocked on an approval or deferred,
 * and those that failed, were interrupted, or were left running by a process that is gone.
 */
export const needsHuman = async (store: Store) => {
  const items = await Promise.all(
    (await store.list()).map(async run => {
      const proposals = (await store.outcome(run.id))?.proposals ?? [];
      const questions = proposals.flatMap(p => (p.kind === 'ask' ? [p.question] : []));
      if (questions.length) return { run, reason: 'asked' as const, questions };
      if (run.closure === 'blocked' || run.closure === 'deferred') return { run, reason: run.closure, questions };
      if (failed.includes(run.status) || (live.includes(run.status) && !isLive(run)))
        return { run, reason: 'failed' as const, questions };
    })
  );
  return items.filter(item => item !== undefined);
};

export type Root = { name: string; dir: string };

/** Names never listed: version control, dependencies, build output, secrets and keys. `.env.example` is kept. */
export const hiddenPaths = ['.git', 'node_modules', 'dist', '.DS_Store', '.env', '.env.*', '*.pem', '*.key'];
const kept = new Set(['.env.example']);
const maxBytes = 256 * 1024;

const hidden = (name: string) =>
  !kept.has(name) &&
  hiddenPaths.some(pattern =>
    pattern.startsWith('*')
      ? name.endsWith(pattern.slice(1))
      : pattern.endsWith('*')
        ? name.startsWith(pattern.slice(0, -1))
        : name === pattern
  );

/**
 * Text files under each root, sorted by path. Skips hidden names, binaries, files over 256 KB and anything that
 * resolves outside its root. A missing root lists nothing.
 */
export const readFiles = async (roots: Root[]) => {
  const files: { root: string; path: string; source: string }[] = [];
  for (const { name, dir } of roots) {
    const base = await realpath(dir).catch(() => undefined);
    if (!base) continue;
    const seen = new Set<string>();
    const walk = async (rel: string, real: string) => {
      if (seen.has(real)) return;
      seen.add(real);
      const entries = await readdir(real, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (hidden(entry.name)) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        const target = await realpath(join(base, path)).catch(() => undefined);
        if (!target || !target.startsWith(base + sep)) continue;
        const info = await stat(target);
        if (info.isDirectory()) await walk(path, target);
        else if (info.isFile() && info.size <= maxBytes) {
          const bytes = await readFile(target);
          if (!bytes.subarray(0, 8192).includes(0)) files.push({ root: name, path, source: bytes.toString('utf8') });
        }
      }
    };
    await walk('', base);
  }
  return files;
};

/**
 * Studio API over a hub directory, extra file roots and a run store, as a Web `Request` handler. Only the hub
 * editing routes under `/api/hub/` (see `hubWriteRoutes`) write; everything else is read-only.
 * `GET /api/files` lists the hub as root `hub` followed by `roots`.
 * `GET /api/runs/:id/files` lists a run's raw harness files and `GET /api/runs/:id/files/<path>` serves one.
 * `GET /api/runs/:id/stream` tails a run's events as Server-Sent Events and ends with an `end` event once the run
 * is no longer queued or running.
 * `GET /api/stream` is the live view of the store as Server-Sent Events (see `liveStream`); `?run=<id>` also follows
 * one run's events, resuming after `Last-Event-ID` or from `?from=`. `GET /api/live` answers its snapshot as JSON and
 * `GET /api/prices` the estimated list prices from `prices`.
 * `GET /api/info` names the hub, the data directory and the process, with `hubErrors` when the served hub's latest
 * edit does not compile.
 * `GET /api/pulls` lists the merge requests in the data directory with their files, `GET /api/pulls/:n/diff` answers
 * one request's diff and `GET /api/runs/:id/diff` what a run committed (see `diffs.ts`); `?whitespace=hide` leaves out
 * changes made only of whitespace. `POST /api/comments` writes a `Review` to the local backend (see `comment`), from
 * localhost only and as JSON. `POST /api/runs/:id/stop` stops a run this process is running, from localhost only; the run
 * is cancelled as stopped by a human and its work parked.
 * `GET /api/build` compares the fingerprint of `srcDir` when the handler was made with the one on disk now, so a
 * client can tell the server runs older code than its source.
 */
export const api = ({
  hubDir,
  store,
  roots = [],
  pollMs = 500,
  srcDir = ownSrc,
  prices = async () => ({}),
  watch = {},
  hubErrors = () => [],
  stops = new Map(),
}: {
  hubDir: string;
  store: Store;
  roots?: Root[];
  pollMs?: number;
  srcDir?: string;
  prices?: () => Promise<Record<string, Price & { model: string }>>;
  watch?: Parameters<typeof watchRuns>[1];
  hubErrors?: () => ConfigError[];
  stops?: Map<string, () => void>;
}): Handler => {
  const running = fingerprint(srcDir);
  const watcher = watchRuns(store.dir, watch);
  const resumeFrom = (req: Request, url: URL) => {
    const last = req.headers.get('last-event-id');
    const resumed = last ? offset(last) : undefined;
    return resumed === undefined ? offset(url.searchParams.get('from')) : resumed + 1;
  };
  const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };
  const stream = (id: string, from: number, signal: AbortSignal) => {
    const encoder = new TextEncoder();
    let cancelled = false;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const open = () => !cancelled && !signal.aborted;
        const send = (text: string) => open() && controller.enqueue(encoder.encode(text));
        try {
          let next = from;
          while (open()) {
            const run = await store.read(id);
            for (const record of await store.events(id, next)) {
              send(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`);
              next = record.seq + 1;
            }
            if (!run || !isLive(run)) {
              send(`event: end\ndata: ${JSON.stringify({ status: run?.status ?? null })}\n\n`);
              break;
            }
            await sleep(pollMs, undefined, { signal }).catch(() => undefined);
          }
          if (!cancelled) controller.close();
        } catch (e) {
          if (!cancelled) controller.error(e);
        }
      },
      cancel: () => void (cancelled = true),
    });
  };

  const routes: [RegExp, (req: Request, url: URL, id: string, rest: string) => Promise<Response>][] = [
    [
      /^\/api\/hub$/,
      async () => {
        try {
          const compiled = compile(await readHub(hubDir));
          return Response.json(compiled.ok ? { config: compiled.config } : { errors: compiled.errors });
        } catch (e) {
          return Response.json({ errors: [{ path: hubDir, message: (e as Error).message }] });
        }
      },
    ],
    [
      /^\/api\/build$/,
      async () => {
        const disk = fingerprint(srcDir);
        const build: ApiBuild = { running, disk, stale: disk !== running };
        return Response.json(build);
      },
    ],
    [
      /^\/api\/info$/,
      async () => {
        const info: ApiInfo = {
          hub: hubDir,
          data: store.dir,
          dataReal: await realpath(store.dir).catch(() => null),
          pid: process.pid,
          version: running,
          hubErrors: hubErrors(),
        };
        return Response.json(info);
      },
    ],
    [/^\/api\/files$/, async () => Response.json(await readFiles([{ name: 'hub', dir: hubDir }, ...roots]))],
    [/^\/api\/runs$/, async () => Response.json(await store.list())],
    [
      /^\/api\/stream$/,
      async (req, url) => {
        const from = resumeFrom(req, url);
        if (from === undefined) return fail('"from" must be a non-negative integer', 400);
        const run = url.searchParams.get('run') || undefined;
        return new Response(liveStream({ watcher, dir: store.dir, run, from, signal: req.signal }), {
          headers: sseHeaders,
        });
      },
    ],
    [
      /^\/api\/live$/,
      async () => {
        const subscription = watcher.subscribe(() => {});
        try {
          await subscription.ready;
          return Response.json({ runs: watcher.rows(), pulls: watcher.pulls() });
        } finally {
          subscription.close();
        }
      },
    ],
    [/^\/api\/prices$/, async () => Response.json(await prices())],
    [/^\/api\/needs-human$/, async () => Response.json(await needsHuman(store))],
    [/^\/api\/pulls$/, async () => Response.json(await listPulls(store))],
    [
      /^\/api\/pulls\/(\d+)\/diff$/,
      async (_req, url, n) => {
        const diff = await pullDiff(store, Number(n), diffOptions(url));
        return diff ? Response.json(diff) : notFound();
      },
    ],
    [
      /^\/api\/runs\/([^/]+)\/diff$/,
      async (_req, url, id) => {
        const run = await store.read(id);
        if (!run) return notFound();
        return Response.json(await runDiff(store, run, diffOptions(url)));
      },
    ],
    [
      /^\/api\/runs\/([^/]+)$/,
      async (_req, _url, id) => {
        const run = await store.read(id);
        if (!run) return notFound();
        return Response.json({ run, outcome: (await store.outcome(id)) ?? null });
      },
    ],
    [
      /^\/api\/runs\/([^/]+)\/events$/,
      async (_req, url, id) => {
        const from = offset(url.searchParams.get('from'));
        if (from === undefined) return fail('"from" must be a non-negative integer', 400);
        if (!(await store.read(id))) return notFound();
        return Response.json(await store.events(id, from));
      },
    ],
    [
      /^\/api\/runs\/([^/]+)\/files$/,
      async (_req, _url, id) => {
        if (!(await store.read(id))) return notFound();
        return Response.json(await store.files(id));
      },
    ],
    [
      /^\/api\/runs\/([^/]+)\/files\/(.+)$/,
      async (_req, _url, id, path) => {
        const text = await store.file(id, path);
        if (text === undefined) return notFound();
        const type = path.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json';
        return new Response(text, { headers: { 'content-type': `${type}; charset=utf-8` } });
      },
    ],
    [
      /^\/api\/runs\/([^/]+)\/stream$/,
      async (req, url, id) => {
        const from = resumeFrom(req, url);
        if (from === undefined) return fail('"from" must be a non-negative integer', 400);
        if (!(await store.read(id))) return notFound();
        return new Response(stream(id, from, req.signal), { headers: sseHeaders });
      },
    ],
  ];

  const edit = hubWriteRoutes(hubDir);

  const commented = async (req: Request) => {
    const body = await localJson(req);
    if ('response' in body) return body.response;
    try {
      return Response.json(await comment({ dir: hubDir, data: store.dir }, body.input), { status: 201 });
    } catch (e) {
      const status = e instanceof Missing ? 404 : e instanceof Invalid ? 400 : 500;
      return fail((e as Error).message, status);
    }
  };

  const stopped = async (req: Request, id: string) => {
    if (req.method !== 'POST') return fail('method not allowed', 405);
    if (!isLocal(req)) return fail('writes are only served on localhost', 403);
    if (!(await store.read(id))) return notFound();
    const stop = stops.get(id);
    if (!stop) return fail('the run is not running here', 409);
    stop();
    return Response.json({ stopped: true }, { status: 202 });
  };

  return async req => {
    const url = new URL(req.url);
    const edited = await edit(req);
    if (edited) return edited;
    if (url.pathname === '/api/comments') return commented(req);
    const stopping = /^\/api\/runs\/([^/]+)\/stop$/.exec(url.pathname);
    if (stopping) return stopped(req, decodeURIComponent(stopping[1] ?? ''));
    if (req.method !== 'GET') return fail('method not allowed', 405);
    for (const [pattern, route] of routes) {
      const match = pattern.exec(url.pathname);
      if (match) return route(req, url, decodeURIComponent(match[1] ?? ''), decodeURIComponent(match[2] ?? ''));
    }
    return notFound();
  };
};

const toRequest = (req: IncomingMessage, signal: AbortSignal) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : (Readable.toWeb(req) as ReadableStream);
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
    method: req.method ?? 'GET',
    headers,
    body,
    signal,
    ...(body && { duplex: 'half' }),
  } as RequestInit);
};

const send = async (response: Response, res: ServerResponse) => {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  for await (const chunk of response.body) res.write(chunk);
  res.end();
};

/** Serves a Web `Request` handler on 127.0.0.1:`port` with `node:http`. Resolves once listening. */
export const serve = (handler: Handler, port: number) => {
  const server = createServer((req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    handler(toRequest(req, abort.signal))
      .then(response => send(response, res))
      .catch((e: Error) => {
        if (abort.signal.aborted) return;
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
  });
  return new Promise<typeof server>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} is in use by another studio or server`) : e)
    );
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
};
