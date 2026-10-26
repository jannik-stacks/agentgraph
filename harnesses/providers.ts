import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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

export const makeProviders = (): Provider[] => [claude, anthropic, litellm];
