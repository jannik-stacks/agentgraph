import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { jwtVerify, SignJWT } from 'jose';
import type { Plugin } from 'vite';
import type * as AuthsModule from '../src/auths.ts';
import type * as InstanceModule from '../src/instance.ts';
import type * as MainModule from '../src/main.ts';
import type { AuthResult } from '../src/plugin.ts';
import type * as ServicesModule from '../src/services.ts';
import type * as ToolsModule from '../src/tools.ts';
import { makeServedGraphs, readModule, writeJson, type ServedGraph, type StudioInstances } from './served.ts';

const loginPath = '/auth/login';
const issuer = 'agentgraph-studio';
const sessionSeconds = 3600;
const refreshSeconds = 300;
const loginSeconds = 12 * 3600;
const studioVariable = /^(AGENTGRAPH_AUTH|AGENTGRAPH_STUDIO_\w+)$/;

const readStudioAuth = async (served: ServedGraph[]) => {
  const { readInstance, isCommittedGraph } = await readModule<typeof InstanceModule>('src/instance.ts');
  const { readEnvFile } = await readModule<typeof MainModule>('src/main.ts');
  const { pickAuth } = await readModule<typeof ServicesModule>('src/services.ts');
  const listed: StudioInstances | undefined = JSON.parse(process.env.AGI_STUDIO_INSTANCES ?? 'null') ?? undefined;
  const instances = (listed?.names ?? []).flatMap(name => readInstance(listed!.root, name) ?? []);
  const file: Record<string, string> = {};
  for (const instance of instances)
    for (const [name, value] of Object.entries(await readEnvFile(instance.env))) {
      if (!studioVariable.test(name)) continue;
      if ((file[name] ?? value) !== value) throw new Error(`the served instances set ${name} differently`);
      file[name] = value;
    }
  const graphs = served.flatMap(({ dir }) =>
    dir ? [{ dir, fromRepo: instances.some(instance => isCommittedGraph(instance, dir)) }] : []
  );
  const picks = await Promise.all(
    (graphs.length ? graphs : [undefined]).map(graph =>
      pickAuth(process.env.AGI_STUDIO_AUTH ?? file.AGENTGRAPH_AUTH, graph)
    )
  );
  const chosen = picks.map(pick => {
    if ('problem' in pick) throw new Error(pick.problem);
    return pick;
  });
  if (new Set(chosen.map(pick => JSON.stringify([pick.name, pick.settings]))).size > 1)
    throw new Error(`the served graphs pick different auth: ${chosen.map(pick => pick.name).join(', ')}`);
  process.env.AGENTGRAPH_STUDIO_TOKEN ||= randomBytes(32).toString('base64url');
  const env = { ...process.env, ...file };
  const { name } = chosen[0]!;
  if (env.AGENTGRAPH_STUDIO_KEY !== undefined && env.AGENTGRAPH_STUDIO_KEY.length < 32)
    throw new Error('AGENTGRAPH_STUDIO_KEY needs at least 32 characters');
  const secrets = Object.entries(env)
    .filter(([variable]) => studioVariable.test(variable))
    .filter(([variable]) => variable !== 'AGENTGRAPH_STUDIO_TOKEN' || name === 'token' || !env.AGENTGRAPH_STUDIO_KEY)
    .toSorted(([a], [b]) => a.localeCompare(b));
  const key = createHash('sha256').update(JSON.stringify(secrets)).digest();
  return { name, check: chosen[0]!.auth({ env }), env, key };
};

const users = new WeakMap<IncomingMessage, string>();

export const readRequestUser = (req: IncomingMessage) => users.get(req);

const isCrossOrigin = ({ headers }: IncomingMessage) => {
  if (['cross-site', 'same-site'].includes(headers['sec-fetch-site'] ?? '')) return true;
  if (headers.origin === undefined) return false;
  const origin = URL.canParse(headers.origin) ? new URL(headers.origin).host : '';
  return ![headers.host, headers['x-forwarded-host']].includes(origin);
};

const isLoopback = (host: string | boolean | undefined) =>
  host === undefined || ['localhost', '127.0.0.1', '::1'].includes(String(host));

const formatLoginPage = (message: string, withForm: boolean) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>agentgraph</title>
<form method="post" action="${loginPath}" style="font:16px system-ui;display:grid;gap:8px;width:260px;margin:20vh auto">
<strong>agentgraph studio</strong>${message && `<p role="alert">${message.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}</p>`}
${withForm ? '<input type="password" name="secret" placeholder="Password or token" autofocus required><button>Log in</button>' : ''}</form>`;

const refuse = (res: ServerResponse, status: number, value: unknown) => {
  writeJson(res, value, status);
  return false;
};

const redirect = (res: ServerResponse, status: number, location: string) => {
  res.setHeader('location', location);
  return refuse(res, status, null);
};

const writeCookie = (req: IncomingMessage, res: ServerResponse, name: string, value: string, seconds: number) => {
  const secure = 'encrypted' in req.socket || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'set-cookie',
    `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  );
};

export const makeStudioAuthPlugin = (served = makeServedGraphs()): Plugin => ({
  name: 'agentgraph:auth',
  enforce: 'pre',
  async configureServer(server) {
    const { name, check, env, key } = await readStudioAuth(await served.read());
    const { isSameSecret } = await readModule<typeof AuthsModule>('src/auths.ts');
    const { readRequestBody } = await readModule<typeof ToolsModule>('src/tools.ts');
    const { host } = server.config.server;
    const { logger } = server.config;
    const http = server.httpServer;
    const takesForm = (await check({ url: new URL(loginPath, 'http://studio'), headers: {} })).kind === 'login';
    const readPort = () => (http?.address() as AddressInfo | null)?.port ?? server.config.server.port;
    const readCookieName = () => `agi_session_${readPort()}`;
    const readAudience = () => `${String(host ?? 'localhost')}:${readPort()}`;
    if (name === 'none' && !isLoopback(host))
      logger.warn(`studio  auth none on ${String(host)}: anyone who reaches this port can act`);
    if (name === 'token')
      http?.once('listening', () => {
        const shown = isLoopback(host) || host === true ? '127.0.0.1' : host;
        logger.info(`  login  http://${shown}:${readPort()}${loginPath}?token=${env.AGENTGRAPH_STUDIO_TOKEN}`);
      });

    const readSession = async (req: IncomingMessage) => {
      const bearer = env.AGENTGRAPH_STUDIO_API_TOKEN;
      if (bearer && isSameSecret(req.headers.authorization ?? '', `Bearer ${bearer}`))
        return { user: 'api', since: 0, stale: false };
      const prefix = `${readCookieName()}=`;
      const cookie = req.headers.cookie
        ?.split(/;\s*/)
        .find(part => part.startsWith(prefix))
        ?.slice(prefix.length);
      const verified =
        cookie &&
        (await jwtVerify(cookie, key, { algorithms: ['HS256'], issuer, audience: readAudience() }).catch(
          () => undefined
        ));
      const { sub, iat = 0, auth_time: since } = verified ? verified.payload : {};
      if (sub === undefined || typeof since !== 'number') return;
      return { user: sub, since, stale: Date.now() / 1000 - iat > refreshSeconds };
    };
    const writeSession = async (req: IncomingMessage, res: ServerResponse, user: string, since: number) => {
      const now = Math.floor(Date.now() / 1000);
      const expires = Math.min(now + sessionSeconds, since + loginSeconds);
      const jwt = await new SignJWT({ auth_time: since })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user)
        .setIssuer(issuer)
        .setAudience(readAudience())
        .setIssuedAt(now)
        .setExpirationTime(expires)
        .sign(key);
      writeCookie(req, res, readCookieName(), jwt, expires - now);
    };
    const readAccess = async (req: IncomingMessage, url: URL, form?: URLSearchParams) => {
      const result = await check({ url, headers: req.headers, ...(form && { form }) });
      if (result.kind !== 'login') return { result };
      const session = await readSession(req);
      return session ? { result: { kind: 'user', user: session.user } satisfies AuthResult, session } : { result };
    };

    const gate = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://studio');
      if (!['GET', 'HEAD'].includes(req.method ?? '') && isCrossOrigin(req))
        return refuse(res, 403, { error: 'cross-origin request' });
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        writeCookie(req, res, readCookieName(), '', 0);
        return redirect(res, 303, loginPath);
      }
      const onLogin = url.pathname === loginPath;
      const posted = onLogin && req.method === 'POST';
      const body = posted ? await readRequestBody(req, 4096) : undefined;
      if (posted && body === undefined) throw new Error('the login form is over 4 KiB');
      const form = body === undefined ? undefined : new URLSearchParams(body);
      const { result, session } = await readAccess(req, url, form);
      if (result.kind === 'user') {
        users.set(req, result.user);
        if (onLogin && !session) await writeSession(req, res, result.user, Math.floor(Date.now() / 1000));
        if (onLogin) return redirect(res, 303, '/');
        if (session?.stale) await writeSession(req, res, session.user, session.since);
        return true;
      }
      if (result.kind === 'refuse') logger.warn(`studio  refused ${req.method} ${url.pathname}: ${result.why}`);
      if (onLogin && (result.kind === 'refuse' || result.url === loginPath)) {
        res.statusCode = result.kind === 'refuse' ? 401 : 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(formatLoginPage(result.kind === 'refuse' ? result.why : '', takesForm));
        return false;
      }
      if (result.kind === 'refuse') return refuse(res, 403, { error: 'forbidden' });
      if (req.headers.accept?.includes('text/html')) return redirect(res, 302, result.url);
      return refuse(res, 401, { error: 'log in first', login: result.url });
    };

    server.middlewares.use((req, res, next) => {
      gate(req, res).then(
        open => open && next(),
        (e: Error) => {
          logger.error(`studio  auth failed on ${req.method} ${req.url}: ${e.message}`);
          refuse(res, 400, { error: 'bad request' });
        }
      );
    });
    if (!http) return;
    const emit = http.emit.bind(http);
    http.emit = ((event: string, ...args: unknown[]) => {
      if (event !== 'upgrade') return emit(event, ...args);
      const [req, socket] = args as [IncomingMessage, Duplex];
      const url = new URL(req.url ?? '/', 'http://studio');
      const opened = isCrossOrigin(req)
        ? Promise.resolve(false)
        : readAccess(req, url).then(({ result }) => result.kind === 'user');
      opened.then(
        open => (open ? emit(event, ...args) : socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')),
        (e: Error) => {
          logger.error(`studio  auth failed on the live socket: ${e.message}`);
          socket.destroy();
        }
      );
      return true;
    }) as typeof http.emit;
  },
});
