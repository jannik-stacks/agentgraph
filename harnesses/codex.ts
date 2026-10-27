import { Schema } from 'effect';
import type { Harness, Piece } from '../src/harnesses.ts';
import { makeResultServer } from '../src/result.ts';
import { getBlockText, makeCacheCounts, makeLineParser, some, splitToolPattern } from './helpers.ts';

const { String: Str, Number: Num, Unknown, Struct, optional: opt } = Schema;

const CodexLine = Struct({
  ...some(Str, 'type', 'thread_id', 'message'),
  item: opt(
    Struct({
      ...some(Str, 'id', 'type', 'text', 'command', 'aggregated_output', 'status', 'server', 'tool'),
      ...some(Num, 'exit_code'),
      ...some(Unknown, 'changes', 'arguments'),
      result: opt(Schema.NullOr(Struct({ content: Unknown }))),
      error: opt(Schema.NullOr(Struct(some(Str, 'message')))),
    })
  ),
  usage: opt(Struct(some(Num, 'input_tokens', 'cached_input_tokens', 'output_tokens'))),
  error: opt(Struct(some(Str, 'message'))),
});

const writing = ['edit', 'write', 'bash'];
const writes = (tools: string[]) => tools.some(tool => writing.includes(tool));
const isWriter = (tools: string[]) => writing.every(tool => tools.includes(tool));
const writeAuth = 'umask 077; printf %s "$AGENTGRAPH_CHATGPT_AUTH" > /tmp/codex-auth.json && exec "$@"';

export const makeCodexHarness = (): Harness => ({
  name: 'codex',
  key: 'AGENTGRAPH_LLM_API_KEY',
  check: ({ tools }) => [
    ...tools
      .filter(tool => splitToolPattern(tool)[2] !== undefined && !tool.startsWith('bash('))
      .map(tool => `cannot limit a tool to a pattern such as ${tool}`),
    ...(writes(tools) && !isWriter(tools) ? ['can only grant edit, write and bash together'] : []),
  ],
  home: (_spec, route) => (route.url ? {} : { links: { '.codex/auth.json': '/tmp/codex-auth.json' } }),
  command: (spec, route) => {
    const resume = !spec.fork && spec.resume;
    const server = spec.returns && makeResultServer(spec.returns);
    const command = {
      cmd: 'codex',
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        ...(resume ? ['resume', resume.id] : []),
        '--json',
        '--skip-git-repo-check',
        ...[
          'model_provider="agentgraph"',
          'model_providers.agentgraph.name="agentgraph"',
          `model_providers.agentgraph.base_url=${JSON.stringify(route.url)}`,
          'model_providers.agentgraph.env_key="AGENTGRAPH_LLM_API_KEY"',
          'model_providers.agentgraph.wire_api="responses"',
        ].flatMap(setting => (route.url ? ['-c', setting] : [])),
        ...(server
          ? [
              `mcp_servers.agentgraph.command=${JSON.stringify(server.command)}`,
              `mcp_servers.agentgraph.args=${JSON.stringify(server.args)}`,
              'mcp_servers.agentgraph.default_tools_approval_mode="approve"',
            ].flatMap(setting => ['-c', setting])
          : []),
        ...(route.model === 'default' ? [] : ['--model', route.model]),
        '--',
        resume ? spec.prompt : `${spec.system}\n\n${spec.prompt}`,
      ],
    };
    const readonly = !isWriter(spec.tools);
    return route.url
      ? { ...command, readonly }
      : { cmd: 'sh', args: ['-c', writeAuth, 'sh', command.cmd, ...command.args], readonly };
  },
  parse: () => {
    let failed: string | undefined;
    return makeLineParser(CodexLine, (line): Piece[] => {
      if (line.type === 'thread.started' && line.thread_id) return [{ type: 'session', id: line.thread_id }];
      const item = line.item;
      if (line.type === 'item.completed' && item) {
        if (item.type === 'agent_message' && item.text) return [{ type: 'text', text: item.text }];
        if (item.type === 'reasoning' && item.text) return [{ type: 'thinking', text: item.text }];
        if (item.type === 'command_execution' || item.type === 'file_change')
          return [
            {
              type: 'tool',
              id: item.id ?? '',
              name: item.type === 'file_change' ? 'edit' : 'bash',
              input: item.type === 'file_change' ? item.changes : { command: item.command },
              ok: item.status !== 'failed' && (item.exit_code ?? 0) === 0,
              output: item.aggregated_output ?? '',
            },
          ];
        if (item.type === 'mcp_tool_call')
          return [
            {
              type: 'tool',
              id: item.id ?? '',
              name: `mcp__${item.server}__${item.tool}`,
              input: item.arguments,
              ok: item.status === 'completed',
              output: item.error?.message ?? getBlockText(item.result?.content),
            },
          ];
      }
      if (line.type === 'turn.completed') {
        const u = line.usage ?? {};
        const cached = u.cached_input_tokens ?? 0;
        return [
          { type: 'usage', input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, ...makeCacheCounts(cached) },
          { type: 'done', ended: 'stop' },
        ];
      }
      if (line.type === 'error') failed = line.message ?? failed;
      if (line.type === 'turn.failed')
        return [{ type: 'done', ended: 'error', error: line.error?.message ?? failed ?? 'codex failed' }];
      return [];
    });
  },
});
