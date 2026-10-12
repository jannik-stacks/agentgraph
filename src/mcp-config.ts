import { fileURLToPath } from 'node:url';
import type { Executor, HubTool } from './schema.ts';

/** How a harness starts the bothub MCP server: a stdio command. */
export type McpServer = { command: string; args: string[]; env: Record<string, string> };

export const serverName = 'bothub';

const bin = fileURLToPath(new URL('../bin/bothub.mjs', import.meta.url));

/** The command that serves `tools` for the hub in `dir`, run by the same Node binary as the runner. */
export const bothubServer = ({
  dir,
  tools,
  repo,
  data,
  env = {},
}: {
  dir: string;
  tools: HubTool[];
  repo: string;
  data?: string;
  env?: Record<string, string>;
}): McpServer => ({
  command: process.execPath,
  args: [bin, 'mcp', '--dir', dir, '--repo', repo, '--tools', tools.join(','), ...(data ? ['--data', data] : [])],
  env,
});

/** Claude Code: arguments for `--mcp-config`, which `--strict-mcp-config` then limits the run to. */
export const claudeMcpArgs = ({ command, args, env }: McpServer) => [
  '--mcp-config',
  JSON.stringify({ mcpServers: { [serverName]: { type: 'stdio', command, args, env } } }),
];

/** opencode: the `mcp` entry to merge into `OPENCODE_CONFIG_CONTENT`. */
export const opencodeMcpConfig = ({ command, args, env }: McpServer) => ({
  mcp: { [serverName]: { type: 'local', command: [command, ...args], environment: env, enabled: true } },
});

const tomlTable = (record: Record<string, string>) =>
  `{${Object.entries(record)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(', ')}}`;

/** Codex: `-c` overrides that define `mcp_servers.bothub`; values are TOML, which JSON strings and arrays already are. */
export const codexMcpArgs = ({ command, args, env }: McpServer) => [
  '-c',
  `mcp_servers.${serverName}.command=${JSON.stringify(command)}`,
  '-c',
  `mcp_servers.${serverName}.args=${JSON.stringify(args)}`,
  ...(Object.keys(env).length ? ['-c', `mcp_servers.${serverName}.env=${tomlTable(env)}`] : []),
];

/**
 * The names a harness's tool allowlist uses for the bothub tools. Codex has no allowlist and pi has no MCP client,
 * so both get none.
 */
export const mcpToolNames = (harness: Executor, tools: HubTool[]): string[] => {
  switch (harness) {
    case 'claude-code':
      return tools.map(tool => `mcp__${serverName}__${tool}`);
    case 'opencode':
      return tools.map(tool => `${serverName}_${tool}`);
    case 'codex':
    case 'pi':
      return [];
  }
};
