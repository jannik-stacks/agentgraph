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
  const answer = await lines.question('');
  lines.close();
  process.stdout.write('\n');
  return answer.trim();
};

const loggedIn = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

const needTerminal = (how: string) => {
  if (!process.stdin.isTTY) throw new Error(`no terminal to log in from; ${how}`);
};

const claude: Provider = {
  name: 'claude',
  harnesses: ['claude'],
  ready: () =>
    !!process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    (keychain ? security(['find-generic-password']).status === 0 : existsSync(claudeToken)),
  detect: () => loggedIn('claude', ['auth', 'status']),
  settings: () => ({
    AGENTGRAPH_PROXY_URL: 'claude=',
    AGENTGRAPH_PROXY_KEYS: '',
    AGENTGRAPH_SESSION_ENV: 'CLAUDE_CODE_OAUTH_TOKEN',
    AGENTGRAPH_MODELS: claudeModels,
    ...(!process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      (keychain
        ? { CLAUDE_CODE_OAUTH_TOKEN: security(['find-generic-password', '-w']).stdout.trim() }
        : { CLAUDE_CODE_OAUTH_TOKEN_FILE: claudeToken })),
  }),
  login: async () => {
    needTerminal('run claude setup-token and export CLAUDE_CODE_OAUTH_TOKEN');
    console.log('login    agentgraph needs its own Claude token for the sandbox. Running `claude setup-token`...');
    if (spawnSync('claude', ['setup-token'], { stdio: 'inherit' }).status !== 0)
      throw new Error('claude setup-token failed');
    const token = await readHidden('         paste the token it printed: ');
    if (!/^[\w-]+$/.test(token)) throw new Error('that is not a token');
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

const inCodexVolume = (flags: string, script: string, stdio: 'ignore' | 'inherit') =>
  spawnSync(
    'docker',
    [
      ...`run --rm ${flags} --user ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}
        --mount type=volume,src=agentgraph-codex,dst=/codex -e CODEX_HOME=/codex
        ${process.env.AGENTGRAPH_IMAGE || 'agentgraph-sandbox:local'} sh -c`.split(/\s+/),
      `exec 9>/codex/.lock && flock 9 && exec ${script}`,
    ],
    { stdio }
  ).status === 0;

const chatgpt: Provider = {
  name: 'chatgpt',
  harnesses: ['codex'],
  ready: () => inCodexVolume('--network none', 'codex login status', 'ignore'),
  detect: () => loggedIn('codex', ['login', 'status']),
  settings: () => ({
    AGENTGRAPH_PROXY_URL: 'codex=',
    AGENTGRAPH_PROXY_KEYS: '',
    AGENTGRAPH_MODELS: '*=gpt-6.1-sol,smart=gpt-6.1-sol,fast=gpt-6-luna',
  }),
  login: async () => {
    needTerminal('run npx agentgraph start --provider chatgpt from a terminal once');
    console.log('login    agentgraph needs its own ChatGPT login for the sandbox.');
    if (!inCodexVolume('-it --network agentgraph-egress', 'codex login --device-auth', 'inherit'))
      throw new Error('codex login failed');
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
