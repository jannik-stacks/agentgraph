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

const readSessionAuth = async () =>
  JSON.parse((await chatgpt.settings!({ image: '', env: {} })).AGENTGRAPH_CHATGPT_AUTH!);

afterEach(() => vi.unstubAllGlobals());

describe('chatgpt', () => {
  it('hands sessions the access token with the refresh token blanked, without refreshing when days are left', async () => {
    const access = jwt(5);
    writeLogin(access);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const settings = await chatgpt.settings!({ image: '', env: {} });
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

const PROVIDER_KEYS = [
  ['claude', 'CLAUDE_CODE_OAUTH_TOKEN'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['litellm', 'AGENTGRAPH_PROXY_KEYS'],
] as const;

it.each(PROVIDER_KEYS)('uses scoped credentials and model choices for %s', async (name, key) => {
  const provider = makeProviders().find(p => p.name === name)!;
  const env = { [key]: 'only-in-scope', AGENTGRAPH_MODELS: '*=scoped' };
  const host = { image: '', env };
  expect(await provider.ready(host)).toBe(true);
  expect(await provider.ready({ ...host, env: { [`${key}_FILE`]: '/unused/scoped-secret' } })).toBe(true);
  const settings = await provider.settings!(host);
  expect(settings.AGENTGRAPH_MODELS).toBe(name === 'litellm' ? '*=scoped' : '*=sonnet,smart=opus,fast=haiku');
  expect(settings.AGENTGRAPH_SESSION_ENV).toBe(name === 'litellm' ? undefined : key);
  expect(settings.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(settings.CLAUDE_CODE_OAUTH_TOKEN_FILE).toBeUndefined();
});

it('keeps proxy credentials scoped while supplying its default model map', async () => {
  const proxy = makeProviders().find(p => p.name === 'litellm')!;
  expect(await proxy.ready({ image: '', env: {} })).toBe(false);
  expect(await proxy.ready({ image: '', env: { AGENTGRAPH_PROXY_KEYS: '*=scoped' } })).toBe(true);
  expect(await proxy.settings!({ image: '', env: {} })).toEqual({ AGENTGRAPH_MODELS: '*=smart' });
});

const PROVIDER_COMMANDS = [
  ['claude', 'claude', ['auth', 'status']],
  ['chatgpt', 'codex', ['login', 'status']],
] as const;

it.each(PROVIDER_COMMANDS)('passes the scoped environment to %s login detection', async (name, command, args) => {
  const bin = tmp('provider-detection');
  const log = join(bin, 'detected');
  writeFileSync(
    join(bin, command),
    `#!/bin/sh
printf '%s %s\\n' "$SCOPED_TOKEN" "$*" > "$SCOPED_LOG"
`,
    { mode: 0o755 }
  );
  const env = { PATH: bin, SCOPED_TOKEN: 'only-in-scope', SCOPED_LOG: log };
  const provider = makeProviders().find(p => p.name === name)!;
  expect(await provider.detect!({ image: '', env })).toBe(true);
  expect(readFileSync(log, 'utf8').trim()).toBe(`only-in-scope ${args.join(' ')}`);
});

it('uses scoped credentials for both subscription login commands', async () => {
  const bin = tmp('provider-login');
  const log = join(bin, 'login');
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh
[ "$SCOPED_TOKEN" = only-in-scope ] || exit 1
printf '%s|%s|%s\\n' "$SCOPED_TOKEN" "$CODEX_HOME" "$*" >> "$SCOPED_LOG"
`,
    { mode: 0o755 }
  );
  const path = process.env.PATH;
  process.env.PATH = bin;
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    await chatgpt.login!({
      image: '',

      env: { PATH: bin, SCOPED_TOKEN: 'only-in-scope', SCOPED_LOG: log },
    });
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
  }
  expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
    `only-in-scope|${join(login, '..')}|-c cli_auth_credentials_store="file" login`,
    `only-in-scope|${join(login, '..')}|-c cli_auth_credentials_store="file" login status`,
  ]);
});
