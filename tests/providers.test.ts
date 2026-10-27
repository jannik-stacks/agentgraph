import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmp } from './kit.ts';

const home = process.env.HOME;
process.env.HOME = tmp('providers');
const { makeProviders } = await import('../harnesses/providers.ts');
const login = join(process.env.HOME, '.config', 'agentgraph', 'codex', 'auth.json');
process.env.HOME = home;

const chatgpt = makeProviders().find(p => p.name === 'chatgpt')!;
const day = 86_400_000;
const jwt = (days: number) => {
  const claims = Buffer.from(JSON.stringify({ exp: (Date.now() + days * day) / 1000 })).toString('base64url');
  return `e30.${claims}.sig`;
};

const writeLogin = (access: string) => {
  mkdirSync(join(login, '..'), { recursive: true });
  const tokens = { id_token: 'fake-id', access_token: access, refresh_token: 'fake-refresh-old', account_id: 'acct-1' };
  writeFileSync(login, JSON.stringify({ auth_mode: 'chatgpt', tokens, last_refresh: '2026-01-01T00:00:00Z' }));
};

const readSessionAuth = async () => JSON.parse((await chatgpt.settings!()).AGENTGRAPH_CHATGPT_AUTH!);

afterEach(() => vi.unstubAllGlobals());

describe('chatgpt', () => {
  it('hands sessions the access token with the refresh token blanked, without refreshing when days are left', async () => {
    const access = jwt(5);
    writeLogin(access);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const settings = await chatgpt.settings!();
    expect(fetch).not.toHaveBeenCalled();
    expect(settings).toMatchObject({
      AGENTGRAPH_PROXY_URL: '*=',
      AGENTGRAPH_SESSION_ENV: 'AGENTGRAPH_CHATGPT_AUTH OPENCODE_AUTH_CONTENT',
    });
    expect(JSON.parse(settings.AGENTGRAPH_CHATGPT_AUTH!)).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: { id_token: 'fake-id', access_token: access, refresh_token: '', account_id: 'acct-1' },
    });
    const { openai } = JSON.parse(settings.OPENCODE_AUTH_CONTENT!);
    expect(openai).toEqual({ type: 'oauth', refresh: '', access, expires: expect.any(Number), accountId: 'acct-1' });
    expect(openai.expires - Date.now()).toBeGreaterThan(4 * day);
  });

  it('refreshes on the host when less than two days are left and keeps the new refresh token there', async () => {
    writeLogin(jwt(1));
    const access = jwt(10);
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ access_token: access, refresh_token: 'fake-refresh-new' })
    );
    vi.stubGlobal('fetch', fetch);
    const auth = await readSessionAuth();
    expect(fetch).toHaveBeenCalledWith('https://auth.openai.com/oauth/token', expect.anything());
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toMatchObject({ refresh_token: 'fake-refresh-old' });
    expect(auth.tokens).toMatchObject({ access_token: access, refresh_token: '', id_token: 'fake-id' });
    expect(JSON.parse(readFileSync(login, 'utf8')).tokens).toMatchObject({
      access_token: access,
      refresh_token: 'fake-refresh-new',
    });
    expect(statSync(login).mode & 0o777).toBe(0o600);
  });

  it('asks for a new login when the refresh is refused', async () => {
    writeLogin(jwt(1));
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    await expect(readSessionAuth()).rejects.toThrow('the ChatGPT login stopped working (HTTP 401)');
  });
});
