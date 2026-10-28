import { describe, expect, it } from 'vitest';
import { claude } from '../harnesses/claude.ts';
import { makeCodexHarness } from '../harnesses/codex.ts';
import { opencode } from '../harnesses/opencode.ts';
import { pi } from '../harnesses/pi.ts';
import type { SessionSpec } from '../src/trace.ts';

const harnesses = [claude(), makeCodexHarness(), opencode(), pi()];
const spec: SessionSpec = {
  harness: 'claude',
  agent: 'triager',
  system: 'Search issues.',
  prompt: 'Find duplicates.',
  dir: '/work',
  tools: ['read'],
  minutes: 1,
};

const toolEndpoint = {
  url: 'http://tools-session.internal:4321/session',
  host: '127.0.0.1',
  secret: 'session-secret',
  tools: ['issues'],
};
const toolRoute = { url: 'http://gateway:4000/v1', model: 'smart' };
const toolSpec = { ...spec, tools: ['read'], mcp: toolEndpoint };

describe('custom tool connections', () => {
  it('adds an HTTP server and exact tool permission to Claude without embedding its secret', () => {
    const { args } = harnesses.find(h => h.name === 'claude')!.command(toolSpec, toolRoute);
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(config.mcpServers).toEqual({
      tools: {
        type: 'http',
        url: toolEndpoint.url,
        headers: { Authorization: 'Bearer ${AGENTGRAPH_TOOL_SECRET}' },
      },
    });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,mcp__tools__issues');
    expect(args).not.toContain('--safe-mode');
    expect(JSON.stringify(args)).not.toContain(toolEndpoint.secret);
  });

  it('adds an HTTP server and exact tool allowlist to Codex', () => {
    const { args } = makeCodexHarness().command(toolSpec, toolRoute);
    expect(args).toEqual(
      expect.arrayContaining([
        `mcp_servers.tools.url=${JSON.stringify(toolEndpoint.url)}`,
        'mcp_servers.tools.bearer_token_env_var="AGENTGRAPH_TOOL_SECRET"',
        'mcp_servers.tools.enabled_tools=["issues"]',
        'mcp_servers.tools.default_tools_approval_mode="approve"',
      ])
    );
    expect(JSON.stringify(args)).not.toContain(toolEndpoint.secret);
  });

  it('keeps the result server beside the remote tools in OpenCode and grants only named tools', () => {
    const { env } = harnesses
      .find(h => h.name === 'opencode')!
      .command({ ...toolSpec, returns: { type: 'object' } }, toolRoute);
    const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT!);
    expect(config.mcp.tools).toEqual({
      type: 'remote',
      url: toolEndpoint.url,
      oauth: false,
      headers: { Authorization: 'Bearer {env:AGENTGRAPH_TOOL_SECRET}' },
    });
    expect(config.mcp.agentgraph.type).toBe('local');
    expect(JSON.parse(env!.OPENCODE_PERMISSION!)).toEqual({
      '*': 'deny',
      read: 'allow',
      agentgraph_result: 'allow',
      tools_issues: 'allow',
    });
    expect(JSON.stringify(env)).not.toContain(toolEndpoint.secret);
  });

  it('loads Pi builtin MCP and exposes only the named tools directly', () => {
    const harness = harnesses.find(h => h.name === 'pi')!;
    const home = harness.home!(toolSpec, toolRoute);
    const config = JSON.parse(home.files!['.pi/agent/mcp.json']!);
    expect(config.mcpServers.tools).toEqual({
      url: toolEndpoint.url,
      headers: { Authorization: 'Bearer ${AGENTGRAPH_TOOL_SECRET}' },
      exposure: 'direct',
    });
    const { args } = harness.command(toolSpec, toolRoute);
    expect(args).toEqual(expect.arrayContaining(['-e', 'builtin:mcp']));
    expect(args[args.indexOf('--tools') + 1]).toBe('read,mcp__tools__issues');
    expect(JSON.stringify(home)).not.toContain(toolEndpoint.secret);
  });
});

it.each([undefined, 'chatgpt'])('keeps Codex MCP configured with %s authentication', auth => {
  const harness = makeCodexHarness();
  const route = { url: '', model: 'default', ...(auth && { auth }) };
  const command = harness.command(toolSpec, route);
  const home = harness.home!(toolSpec, route);
  expect(command.cmd).toBe(auth ? 'sh' : 'codex');
  expect(command.args).toContain(`mcp_servers.tools.url=${JSON.stringify(toolEndpoint.url)}`);
  expect(home).toEqual(
    auth ? { links: { '.codex/auth.json': '/tmp/codex-auth.json' } } : { files: { '.codex/auth.json': null } }
  );
  expect(JSON.stringify({ command, home })).not.toContain(toolEndpoint.secret);
});

it.each([undefined, 'chatgpt'])('keeps Pi MCP configured with %s authentication', auth => {
  const harness = pi();
  const route = { url: '', model: 'default', ...(auth && { auth }) };
  const command = harness.command(toolSpec, route);
  const home = harness.home!(toolSpec, route);
  expect(command.args).toEqual(expect.arrayContaining(['-e', 'builtin:mcp']));
  expect(command.args[command.args.indexOf('--tools') + 1]).toBe('read,mcp__tools__issues');
  expect(JSON.parse(home.files!['.pi/agent/mcp.json']!).mcpServers.tools.url).toBe(toolEndpoint.url);
  expect(home.files!['.pi/agent/models.json'] === null).toBe(!auth);
  expect(JSON.stringify({ command, home })).not.toContain(toolEndpoint.secret);
});
