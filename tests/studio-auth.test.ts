import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { password, token } from '../src/auths.ts';
import { pickAuth } from '../src/services.ts';
import { startStudioServer } from './studio.ts';

const ask = (check: ReturnType<NonNullable<typeof token.auth>>, url: string, form?: string) =>
  check({
    url: new URL(url, 'http://studio'),
    headers: {},
    ...(form !== undefined && { form: new URLSearchParams(form) }),
  });

const makeSettingsDir = async (text: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentgraph-auth-'));
  await writeFile(join(dir, 'settings.yaml'), text);
  return dir;
};

const openSocket = (base: string, headers: Record<string, string> = {}, token = '') =>
  new Promise<WebSocket | undefined>(resolve => {
    const init = { protocols: ['vite-hmr'], headers };
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/?token=${token}`, init as unknown as string[]);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => resolve(undefined);
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('built-in auth', () => {
  it('takes the start token from the URL or the form and the password only from the form', async () => {
    const byToken = token.auth!({ env: { AGENTGRAPH_STUDIO_TOKEN: 'start-token' } }, undefined);
    const byPassword = password.auth!({ env: { AGENTGRAPH_STUDIO_PASSWORD: 'shared' } }, undefined);
    const results = await Promise.all([
      ask(byToken, '/'),
      ask(byToken, '/auth/login?token=start-token'),
      ask(byToken, '/auth/login', 'secret=start-token'),
      ask(byToken, '/auth/login?token=guess'),
      ask(byPassword, '/auth/login?token=shared'),
      ask(byPassword, '/auth/login', 'secret=shared'),
      ask(byPassword, '/auth/login', 'secret=guess'),
    ]);
    expect(results).toEqual([
      { kind: 'login', url: '/auth/login' },
      { kind: 'user', user: 'token' },
      { kind: 'user', user: 'token' },
      { kind: 'refuse', why: 'wrong token' },
      { kind: 'login', url: '/auth/login' },
      { kind: 'user', user: 'password' },
      { kind: 'refuse', why: 'wrong password' },
    ]);
    expect(() => password.auth!({ env: {} }, undefined)).toThrow('auth password needs AGENTGRAPH_STUDIO_PASSWORD');
  });

  it('picks by the flag or env file, then settings.yaml, then the shell, then token', async () => {
    const dir = await makeSettingsDir('auth: password\n');
    const names = async (chosen: string | undefined, graph?: { dir: string; fromRepo: boolean }) => {
      const picked = await pickAuth(chosen, graph);
      return 'problem' in picked ? picked.problem : picked.name;
    };
    vi.stubEnv('AGENTGRAPH_AUTH', 'none');
    const picked = [
      await names('token', { dir, fromRepo: false }),
      await names(undefined, { dir, fromRepo: false }),
      await names(undefined),
      await names('nope'),
      await names('github'),
      await names(undefined, { dir, fromRepo: true }),
    ];
    vi.stubEnv('AGENTGRAPH_AUTH', undefined);
    picked.push(await names(undefined));
    expect(picked).toEqual([
      'token',
      'password',
      'none',
      'no auth plugin nope; auths: none, token, password',
      'plugin github has no auth',
      `auth in ${dir}: a graph read from the repo cannot pick the studio's auth`,
      'token',
    ]);
  });
});

describe('studio gate', () => {
  it('locks the API, the page and the live socket until the start token logs in', async () => {
    const data = await mkdtemp(join(tmpdir(), 'agentgraph-auth-data-'));
    vi.stubEnv('AGI_STUDIO_DATA', data);
    vi.stubEnv('AGENTGRAPH_AUTH', 'token');
    vi.stubEnv('AGENTGRAPH_STUDIO_TOKEN', 'start-token');
    vi.stubEnv('AGENTGRAPH_STUDIO_API_TOKEN', 'script-token');
    const { server, base } = await startStudioServer();
    const { port } = new URL(base);
    try {
      const get = (path: string, headers: Record<string, string> = {}) =>
        fetch(`${base}${path}`, { headers, redirect: 'manual' });
      const api = await get('/api/runs');
      const page = await get('/', { accept: 'text/html' });
      const form = await get('/auth/login');
      const wrong = await get('/auth/login?token=guess');
      const login = await get('/auth/login?token=start-token');
      const cookie = login.headers.get('set-cookie') ?? '';
      const session = cookie.split(';')[0]!;
      const after = await get('/api/runs', { cookie: session });
      const bearer = await get('/api/runs', { authorization: 'Bearer script-token' });
      const forged = await get('/api/runs', { cookie: `${session.slice(0, -2)}xx` });
      const crossSite = await fetch(`${base}/api/actions/say`, {
        method: 'POST',
        headers: { cookie: session, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '[1,"hi"]',
      });
      const proxied = await fetch(`${base}/api/actions/label`, {
        method: 'POST',
        headers: { cookie: session, origin: `https://${new URL(base).host}`, 'content-type': 'application/json' },
        body: '["r1",{"arm":"x"}]',
      });
      const logout = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: session, origin: base },
      });
      const forwarded = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: 'https://studio.example', 'x-forwarded-host': 'studio.example' },
      });
      const refusedSocket = await openSocket(base);
      const { webSocketToken } = server.config;
      const crossSocket = await openSocket(base, { cookie: session, origin: 'https://evil.example' }, webSocketToken);
      const socket = await openSocket(base, { cookie: session, origin: base }, webSocketToken);
      const changed = new Promise<string>(resolve => {
        socket!.onmessage = event => String(event.data).includes('agi:changed') && resolve(String(event.data));
      });
      await mkdir(join(data, 'run-1'));
      await writeFile(join(data, 'run-1', 'record.json'), '{}');
      const live = await changed;
      socket!.close();
      expect({
        api: [api.status, await api.json()],
        page: [page.status, page.headers.get('location')],
        form: [form.status, (await form.text()).includes('name="secret"')],
        wrong: [wrong.status, (await wrong.text()).includes('name="secret"')],
        login: [login.status, login.headers.get('location')],
        cookie: cookie.replace(/=[^;]+;/, '=<jwt>;'),
        after: after.status,
        bearer: bearer.status,
        forged: forged.status,
        crossSite: crossSite.status,
        proxied: proxied.status,
        forwarded: forwarded.status,
        logout: [logout.status, logout.headers.get('location'), logout.headers.get('set-cookie')],
        socket: [refusedSocket, crossSocket, JSON.parse(live).data.topics.includes('data')],
      }).toEqual({
        api: [401, { error: 'log in first', login: '/auth/login' }],
        page: [302, '/auth/login'],
        form: [200, true],
        wrong: [401, true],
        login: [303, '/'],
        cookie: `agi_session_${port}=<jwt>; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict`,
        after: 200,
        bearer: 200,
        forged: 401,
        crossSite: 403,
        proxied: 400,
        forwarded: 303,
        logout: [303, '/auth/login', `agi_session_${port}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`],
        socket: [undefined, undefined, true],
      });
    } finally {
      await server.close();
    }
  });

  it('ends a refreshed session twelve hours after the login', async () => {
    vi.stubEnv('AGENTGRAPH_AUTH', 'token');
    vi.stubEnv('AGENTGRAPH_STUDIO_TOKEN', 'start-token');
    const { server, base } = await startStudioServer();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const login = await fetch(`${base}/auth/login?token=start-token`, { redirect: 'manual' });
      let session = login.headers.get('set-cookie')!.split(';')[0]!;
      const statuses: number[] = [];
      for (let step = 0; step < 14; step++) {
        vi.setSystemTime(Date.now() + 55 * 60_000);
        const response = await fetch(`${base}/api/runs`, { headers: { cookie: session } });
        statuses.push(response.status);
        session = response.headers.get('set-cookie')?.split(';')[0] ?? session;
      }
      expect(statuses).toEqual([...Array(13).fill(200), 401]);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it('opens the live socket without a login under none', async () => {
    vi.stubEnv('AGENTGRAPH_AUTH', 'none');
    const { server, base } = await startStudioServer();
    try {
      const socket = await openSocket(base);
      socket?.close();
      expect(socket).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('logs in with the shared password from a same-origin form post', async () => {
    vi.stubEnv('AGENTGRAPH_AUTH', 'password');
    vi.stubEnv('AGENTGRAPH_STUDIO_PASSWORD', 'shared');
    const { server, base } = await startStudioServer();
    try {
      const post = (secret: string, origin = base) =>
        fetch(`${base}/auth/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { origin, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
          body: new URLSearchParams({ secret }),
        });
      const [right, wrong, inUrl, crossSite] = [
        await post('shared'),
        await post('guess'),
        await fetch(`${base}/auth/login?token=shared`, { redirect: 'manual' }),
        await post('shared', 'https://evil.example'),
      ];
      expect([
        right.status,
        right.headers.get('set-cookie')?.endsWith('; Secure'),
        wrong.status,
        (await wrong.text()).includes('wrong password'),
        inUrl.headers.get('set-cookie'),
        crossSite.status,
      ]).toEqual([303, true, 401, true, null, 403]);
    } finally {
      await server.close();
    }
  });
});
