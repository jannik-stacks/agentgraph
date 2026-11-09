import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { jwtVerify, SignJWT } from 'jose';
import type { Plugin } from 'vite';
import type * as AuthsModule from '../src/auths.ts';
import type * as InstanceModule from '../src/instance.ts';
import type * as MainModule from '../src/main.ts';
import type * as ServicesModule from '../src/services.ts';
import { makeServedGraphs, type ServedGraph, type StudioInstances } from './served.ts';

const loginPath = '/auth/login';
const sessionSeconds = 3600;
const refreshSeconds = 300;
const studioVariable = /^(AGENTGRAPH_AUTH|AGENTGRAPH_STUDIO_\w+)$/;

const from = <T>(path: string): Promise<T> => import(new URL(path, import.meta.url).href);

const readStudioAuth = async (served: ServedGraph[]) => {
  const { readInstance, isCommittedGraph } = await from<typeof InstanceModule>('../src/instance.ts');
  const { readEnvFile } = await from<typeof MainModule>('../src/main.ts');
  const { pickAuth } = await from<typeof ServicesModule>('../src/services.ts');
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
  process.env.AGI_STUDIO_TOKEN ||= randomBytes(32).toString('base64url');
  const env = { ...process.env, ...file };
  return { name: chosen[0]!.name, check: chosen[0]!.auth({ env }), env };
};

const isCrossOrigin = ({ headers }: IncomingMessage) =>
  ['cross-site', 'same-site'].includes(headers['sec-fetch-site'] ?? '') ||
  (headers.origin !== undefined && (!URL.canParse(headers.origin) || new URL(headers.origin).host !== headers.host));

const isLoopback = (host: string | boolean | undefined) =>
  host === undefined || ['localhost', '127.0.0.1', '::1'].includes(String(host));

const formatLoginPage = (message: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>agentgraph</title>
<form method="post" action="${loginPath}" style="font:16px system-ui;display:grid;gap:8px;width:260px;margin:20vh auto">
<strong>agentgraph studio</strong>${message && `<p role="alert">${message.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}</p>`}
<input type="password" name="secret" placeholder="Password or token" autofocus required><button>Log in</button></form>`;

const readLoginForm = async (req: IncomingMessage) => {
  let text = '';
  for await (const chunk of req) if ((text += chunk).length > 4096) throw new Error('the login form is over 4 KiB');
  return new URLSearchParams(text);
};

const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.end(body);
  return false;
};

const redirect = (res: ServerResponse, status: number, location: string) => {
  res.statusCode = status;
  res.setHeader('location', location);
  res.end();
  return false;
};

export const makeStudioAuthPlugin = (served = makeServedGraphs()): Plugin => ({
  name: 'agentgraph:auth',
  enforce: 'pre',
  async configureServer(server) {
    const { name, check, env } = await readStudioAuth(await served.read());
    const { isSameSecret }: typeof AuthsModule = await from('../src/auths.ts');
    const key = new TextEncoder().encode(env.AGENTGRAPH_STUDIO_KEY || env.AGI_STUDIO_TOKEN);
    const { host } = server.config.server;
    if (name === 'none' && !isLoopback(host))
      server.config.logger.warn(`studio  auth none on ${String(host)}: anyone who reaches this port can act`);
    if (name === 'token')
      server.httpServer?.once('listening', () => {
        const address = server.httpServer!.address();
        const port = typeof address === 'object' && address ? address.port : '';
        const shown = isLoopback(host) || host === true ? '127.0.0.1' : host;
        server.config.logger.info(`  login  http://${shown}:${port}${loginPath}?token=${env.AGI_STUDIO_TOKEN}`);
      });

    const readSession = async (req: IncomingMessage) => {
      const bearer = env.AGENTGRAPH_STUDIO_API_TOKEN;
      if (bearer && isSameSecret(req.headers.authorization ?? '', `Bearer ${bearer}`)) return { stale: false };
      const cookie = /(?:^|;\s*)agi_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const verified = cookie && (await jwtVerify(cookie, key, { algorithms: ['HS256'] }).catch(() => undefined));
      if (verified && verified.payload.sub !== undefined)
        return { user: verified.payload.sub, stale: Date.now() / 1000 - (verified.payload.iat ?? 0) > refreshSeconds };
    };
    const writeSession = async (req: IncomingMessage, res: ServerResponse, user: string) => {
      const jwt = await new SignJWT()
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user)
        .setIssuedAt()
        .setExpirationTime(`${sessionSeconds}s`)
        .sign(key);
      const secure = 'encrypted' in req.socket || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader(
        'set-cookie',
        `agi_session=${jwt}; Path=/; Max-Age=${sessionSeconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
      );
    };

    const gate = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://studio');
      const onLogin = url.pathname === loginPath;
      if (!['GET', 'HEAD'].includes(req.method ?? '') && isCrossOrigin(req))
        return send(res, 403, '{"error":"cross-origin request"}');
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        res.setHeader('set-cookie', 'agi_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
        return redirect(res, 303, loginPath);
      }
      const session = await readSession(req);
      if (session) {
        if (onLogin) return redirect(res, 303, '/');
        if (session.user && session.stale) await writeSession(req, res, session.user);
        return true;
      }
      const form = onLogin && req.method === 'POST' ? await readLoginForm(req) : undefined;
      const result = await check({ url, headers: req.headers, ...(form && { form }) });
      if ('user' in result) {
        await writeSession(req, res, result.user);
        return onLogin ? redirect(res, 303, '/') : true;
      }
      if (onLogin && !('login' in result && result.login !== loginPath))
        return send(
          res,
          'refuse' in result ? 401 : 200,
          formatLoginPage('refuse' in result ? result.refuse : ''),
          'text/html; charset=utf-8'
        );
      if ('refuse' in result) return send(res, 403, JSON.stringify({ error: result.refuse }));
      if (req.headers.accept?.includes('text/html')) return redirect(res, 302, result.login);
      return send(res, 401, JSON.stringify({ error: 'log in first', login: result.login }));
    };

    server.middlewares.use((req, res, next) => {
      gate(req, res).then(
        open => open && next(),
        (e: Error) => send(res, 400, JSON.stringify({ error: e.message }))
      );
    });
    const http = server.httpServer;
    if (!http) return;
    const listeners = http.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
    http.removeAllListeners('upgrade');
    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void readSession(req).then(session => {
        if (!session) return void socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        for (const listener of listeners) listener.call(http, req, socket, head);
      });
    });
  },
});
