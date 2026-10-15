import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { compile, type ConfigError } from './config.ts';
import { listPulls, pullDiff, runDiff } from './diffs.ts';
import { fingerprint, srcDir as ownSrc } from './fingerprint.ts';
import { liveStream, watchRuns } from './live.ts';
import { readHub } from './load.ts';
import { fail, localJson } from './local-json.ts';
import { callOp, OpError } from './ops.ts';
import { settings } from './settings.ts';
import type { Runner } from './serve.ts';
import type { Store } from './store.ts';
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
 * Studio API over a hub directory and a run store, as a Web `Request` handler, with the ops of `runner` as
 * `POST /rpc/<op>` taking and answering JSON (see `ops.ts`), from localhost only, and `GET /healthz` for a container
 * probe. Everything else is read-only.
 * `GET /api/runs/:id` answers a run with its outcome and `GET /api/runs/:id/events?from=<seq>` its event records.
 * `GET /api/stream` is the live view of the store as Server-Sent Events (see `liveStream`), `GET /api/live` its
 * snapshot as JSON, and `GET /api/prices` the estimated list prices from `prices`.
 * `GET /api/info` names the hub, the data directory and the process, with `hubErrors` when the served hub's latest
 * edit does not compile.
 * `GET /api/pulls` lists the merge requests in the data directory with their files, `GET /api/pulls/:n/diff` answers
 * one request's diff and `GET /api/runs/:id/diff` what a run committed (see `diffs.ts`); `?whitespace=hide` leaves out
 * changes made only of whitespace.
 * `GET /api/build` compares the fingerprint of `srcDir` when the handler was made with the one on disk now, so a
 * client can tell the server runs older code than its source.
 */
export const api = ({
  hubDir,
  store,
  runner,
  srcDir = ownSrc,
  prices = async () => ({}),
  watch = {},
  hubErrors = () => [],
}: {
  hubDir: string;
  store: Store;
  runner?: Runner;
  srcDir?: string;
  prices?: () => Promise<Record<string, Price & { model: string }>>;
  watch?: Parameters<typeof watchRuns>[1];
  hubErrors?: () => ConfigError[];
}): Handler => {
  const running = fingerprint(srcDir);
  const watcher = watchRuns(store.dir, watch);
  const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };
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
    [
      /^\/api\/stream$/,
      async req => new Response(liveStream({ watcher, dir: store.dir, signal: req.signal }), { headers: sseHeaders }),
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
    [/^\/api\/pulls$/, async () => Response.json(await listPulls(store))],
    [
      /^\/api\/pulls\/(\d+)\/diff$/,
      async (_req, url, n) => {
        const diff = await pullDiff(store, Number(n), diffOptions(url));
        return diff ? Response.json(diff) : notFound();
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
      /^\/api\/runs\/([^/]+)\/diff$/,
      async (_req, url, id) => {
        const run = await store.read(id);
        if (!run) return notFound();
        return Response.json(await runDiff(store, run, diffOptions(url)));
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
  ];

  const rpc = async (req: Request, name: string) => {
    if (!runner) return notFound();
    const body = await localJson(req);
    if ('response' in body) return body.response;
    try {
      return Response.json(await callOp(runner, name, body.input));
    } catch (e) {
      return fail((e as Error).message, e instanceof OpError ? e.status : 500);
    }
  };

  return async req => {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    const op = /^\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (op) return rpc(req, op[1] ?? '');
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

/** Serves a Web `Request` handler on `host`:`port` with `node:http`. Resolves once listening. */
export const serve = (handler: Handler, port: number, host = settings().listen) => {
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
    server.listen(port, host, () => resolve(server));
  });
};
