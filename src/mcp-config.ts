import { fileURLToPath } from 'node:url';
import type { Harness, HubTool } from './schema.ts';

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

/** opencode: the `mcp` entry to merge into `OPENCODE_CONFIG_CONTENT`. */
export const opencodeMcpConfig = ({ command, args, env }: McpServer) => ({
  mcp: { [serverName]: { type: 'local', command: [command, ...args], environment: env, enabled: true } },
});

/** The names a harness's tool allowlist uses for the bothub tools. pi has no MCP client, so it gets none. */
export const mcpToolNames = (harness: Harness, tools: HubTool[]): string[] => {
  switch (harness) {
    case 'opencode':
      return tools.map(tool => `${serverName}_${tool}`);
    case 'pi':
      return [];
  }
};
