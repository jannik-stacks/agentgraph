import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Provider } from '../src/harnesses.ts';

const config = join(homedir(), '.config', 'agentgraph');
const claudeToken = join(config, 'claude-token');
const claudeModels = '*=sonnet,smart=opus,fast=haiku';
const keychain = process.platform === 'darwin';
const security = (args: string[], input?: string) =>
  spawnSync('security', [...args, ...(input ? [] : ['-s', 'agentgraph', '-a', 'claude'])], {
    encoding: 'utf8',
    ...(input && { input }),
  });

const readHidden = async (question: string) => {
  process.stdout.write(question);
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const lines = createInterface({ input: process.stdin, output: muted, terminal: true });
  const pasted: string[] = [];
  for await (const line of lines) {
    if (!line.trim() && pasted.length) break;
    pasted.push(line);
  }
  lines.close();
  process.stdout.write('\n');
  return pasted.join('').replace(/\s/g, '');
};

const isTokenAccepted = (token: string) =>
  spawnSync('claude', ['-p', 'Reply with ok.', '--model', 'haiku'], {
    cwd: tmpdir(),
    env: { ...process.env, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: token },
    stdio: 'ignore',
    timeout: 60_000,
  }).status === 0;

const loggedIn = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

const needTerminal = (how: string) => {
  if (!process.stdin.isTTY) throw new Error(`no terminal to log in from; ${how}`);
};

const claude: Provider = {
  name: 'claude',
  harnesses: ['claude'],
  ready: () =>
    !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE) ||
    (keychain ? security(['find-generic-password']).status === 0 : existsSync(claudeToken)),
  detect: () => loggedIn('claude', ['auth', 'status']),
  settings: () => ({
    AGENTGRAPH_PROXY_URL: 'claude=',
    AGENTGRAPH_PROXY_KEYS: '',
    AGENTGRAPH_SESSION_ENV: 'CLAUDE_CODE_OAUTH_TOKEN',
    AGENTGRAPH_MODELS: claudeModels,
    ...(!process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE &&
      (keychain
        ? { CLAUDE_CODE_OAUTH_TOKEN: security(['find-generic-password', '-w']).stdout.trim() }
        : { CLAUDE_CODE_OAUTH_TOKEN_FILE: claudeToken })),
  }),
  login: async () => {
    needTerminal('run claude setup-token and export CLAUDE_CODE_OAUTH_TOKEN');
    console.log('login    agentgraph needs its own Claude token for the sandbox. Running `claude setup-token`...');
    if (spawnSync('claude', ['setup-token'], { stdio: 'inherit' }).status !== 0)
      throw new Error('claude setup-token failed');
    let token = await readHidden('         paste the token it printed, then press Enter on an empty line: ');
    for (let tries = 1; !/^[\w-]+$/.test(token) || !isTokenAccepted(token); tries++) {
      if (tries === 3) throw new Error('that token did not work three times; nothing was saved');
      token = await readHidden("         that token didn't work, paste it again: ");
    }
    if (keychain) {
      if (security(['-i'], `add-generic-password -U -s agentgraph -a claude -w "${token}"\n`).status !== 0)
        throw new Error('could not save the token in the Keychain');
      console.log('         saved in the macOS Keychain as agentgraph/claude');
      return;
    }
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(claudeToken, token, { mode: 0o600 });
    console.log(`         saved in ${claudeToken}`);
  },
};

const codexHome = join(config, 'codex');
const codexAuth = join(codexHome, 'auth.json');
const runCodexAtHome = (args: string[], stdio: 'inherit' | 'ignore') =>
  spawnSync('codex', ['-c', 'cli_auth_credentials_store="file"', ...args], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio,
  }).status === 0;
const readExpiry = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()).exp * 1000;

const readFreshCodexAuth = async () => {
  const auth = JSON.parse(await readFile(codexAuth, 'utf8'));
  if (readExpiry(auth.tokens.access_token) - Date.now() > 2 * 86_400_000) return auth;
  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: auth.tokens.refresh_token,
    }),
  });
  if (!res.ok)
    throw new Error(`the ChatGPT login stopped working (HTTP ${res.status}); remove ${codexAuth} and run again`);
  const { id_token, access_token, refresh_token } = await res.json();
  const next = {
    ...auth,
    tokens: { ...auth.tokens, access_token, ...(id_token && { id_token }), ...(refresh_token && { refresh_token }) },
    last_refresh: new Date().toISOString(),
  };
  await writeFile(`${codexAuth}.tmp`, JSON.stringify(next), { mode: 0o600 });
  await rename(`${codexAuth}.tmp`, codexAuth);
  return next;
};

const chatgpt: Provider = {
  name: 'chatgpt',
  harnesses: ['codex'],
  ready: () => existsSync(codexAuth),
  detect: () => loggedIn('codex', ['login', 'status']),
  settings: async () => {
    const { tokens } = await readFreshCodexAuth();
    return {
      AGENTGRAPH_PROXY_URL: 'codex=',
      AGENTGRAPH_PROXY_KEYS: '',
      AGENTGRAPH_SESSION_ENV: 'AGENTGRAPH_CHATGPT_AUTH',
      AGENTGRAPH_MODELS: '*=default',
      AGENTGRAPH_CHATGPT_AUTH: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { ...tokens, refresh_token: '' },
        last_refresh: new Date().toISOString(),
      }),
    };
  },
  login: async () => {
    needTerminal(`run CODEX_HOME=${codexHome} codex -c 'cli_auth_credentials_store="file"' login`);
    console.log('login    agentgraph needs its own ChatGPT login for the sandbox. Running `codex login`...');
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    if (!runCodexAtHome(['login'], 'inherit') || !runCodexAtHome(['login', 'status'], 'ignore'))
      throw new Error('codex login failed; nothing was saved');
    console.log(`         saved in ${codexAuth}`);
  },
};

const anthropic: Provider = {
  name: 'anthropic',
  harnesses: ['claude'],
  ready: () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_FILE),
  settings: () => ({
    AGENTGRAPH_PROXY_URL: 'claude=',
    AGENTGRAPH_PROXY_KEYS: '',
    AGENTGRAPH_SESSION_ENV: 'ANTHROPIC_API_KEY',
    AGENTGRAPH_MODELS: claudeModels,
  }),
};

const litellm: Provider = {
  name: 'litellm',
  harnesses: ['opencode', 'pi', 'claude', 'codex'],
  ready: () => !!(process.env.AGENTGRAPH_PROXY_KEYS || process.env.AGENTGRAPH_PROXY_KEYS_FILE),
  settings: () => ({ AGENTGRAPH_MODELS: process.env.AGENTGRAPH_MODELS ?? '*=smart' }),
};

export const makeProviders = (): Provider[] => [claude, chatgpt, anthropic, litellm];
