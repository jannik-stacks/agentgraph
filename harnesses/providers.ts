import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Provider } from '../src/harnesses.ts';

const config = join(homedir(), '.config', 'agentgraph');
const claudeToken = join(config, 'claude-token');
const codexLogin = join(config, 'codex-login');
const claudeModels = '*=sonnet,smart=opus,fast=haiku';

const readHidden = async (question: string) => {
  process.stdout.write(question);
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const lines = createInterface({ input: process.stdin, output: muted, terminal: true });
  const answer = await lines.question('');
  lines.close();
  process.stdout.write('\n');
  return answer.trim();
};

const needTerminal = (how: string) => {
  if (!process.stdin.isTTY) throw new Error(`no terminal to log in from; ${how}`);
};

const claude: Provider = {
  name: 'claude',
  harnesses: ['claude'],
  ready: () => existsSync(claudeToken) || !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
  settings: () => ({
    AGENTGRAPH_PROXY_URL: 'claude=',
    AGENTGRAPH_PROXY_KEYS: '',
    AGENTGRAPH_SESSION_ENV: 'CLAUDE_CODE_OAUTH_TOKEN',
    AGENTGRAPH_MODELS: claudeModels,
    ...(!process.env.CLAUDE_CODE_OAUTH_TOKEN && { CLAUDE_CODE_OAUTH_TOKEN_FILE: claudeToken }),
  }),
  login: async () => {
    needTerminal(`run claude setup-token and save the token in ${claudeToken} with mode 600`);
    console.log('login    agentgraph needs its own Claude token for the sandbox. Running `claude setup-token`...');
    if (spawnSync('claude', ['setup-token'], { stdio: 'inherit' }).status !== 0)
      throw new Error('claude setup-token failed');
    const token = await readHidden('         paste the token it printed: ');
    if (!token) throw new Error('no token given');
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(claudeToken, token, { mode: 0o600 });
    console.log(`         saved in ${claudeToken}`);
  },
};

const chatgpt: Provider = {
  name: 'chatgpt',
  harnesses: ['codex'],
  ready: () => existsSync(codexLogin),
  settings: () => ({
    AGENTGRAPH_PROXY_URL: 'codex=',
    AGENTGRAPH_PROXY_KEYS: '',
    AGENTGRAPH_MODELS: '*=gpt-6.1-sol,smart=gpt-6.1-sol,fast=gpt-6-luna',
  }),
  login: async () => {
    needTerminal('run npx agentgraph start --provider chatgpt from a terminal once');
    console.log('login    agentgraph needs its own ChatGPT login for the sandbox.');
    const image = process.env.AGENTGRAPH_IMAGE || 'agentgraph-sandbox:local';
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const login = spawnSync(
      'docker',
      `run --rm -it --user ${user} --network agentgraph-egress --mount type=volume,src=agentgraph-codex,dst=/codex
        -e CODEX_HOME=/codex ${image} codex login --device-auth`.split(/\s+/),
      { stdio: 'inherit' }
    );
    if (login.status !== 0) throw new Error('codex login failed');
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(codexLogin, `${new Date().toISOString()}\n`);
    console.log('         saved in docker volume agentgraph-codex');
  },
};

const anthropic: Provider = {
  name: 'anthropic',
  harnesses: ['claude'],
  ready: () => !!process.env.ANTHROPIC_API_KEY,
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
};

export const makeProviders = (): Provider[] => [claude, chatgpt, anthropic, litellm];
