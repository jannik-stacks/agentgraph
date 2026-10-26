import { Schema } from 'effect';
import type { Harness, Piece } from '../src/harnesses.ts';
import { makeCacheCounts, makeLineParser, some, splitToolPattern } from './helpers.ts';

const { String: Str, Number: Num, Unknown, Struct, optional: opt } = Schema;

const CodexLine = Struct({
  ...some(Str, 'type', 'thread_id', 'message'),
  item: opt(
    Struct({
      ...some(Str, 'id', 'type', 'text', 'command', 'aggregated_output', 'status'),
      ...some(Num, 'exit_code'),
      ...some(Unknown, 'changes'),
    })
  ),
  usage: opt(Struct(some(Num, 'input_tokens', 'cached_input_tokens', 'output_tokens'))),
  error: opt(Struct(some(Str, 'message'))),
});

const writing = ['edit', 'write', 'bash'];
const writes = (tools: string[]) => tools.some(tool => writing.includes(tool));

export const makeCodexHarness = (): Harness => ({
  name: 'codex',
  key: 'AGENTGRAPH_LLM_API_KEY',
  check: ({ tools }) => [
    ...tools
      .filter(tool => splitToolPattern(tool)[2] !== undefined && !tool.startsWith('bash('))
      .map(tool => `cannot limit a tool to a pattern such as ${tool}`),
    ...(writes(tools) && !writing.every(tool => tools.includes(tool))
      ? ['can only grant edit, write and bash together']
      : []),
  ],
  command: (spec, route) => {
    const resume = !spec.fork && spec.resume;
    return {
      cmd: 'codex',
      args: [
        'exec',
        ...(writes(spec.tools) ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']),
        ...(resume ? ['resume', resume.id] : []),
        '--json',
        '--skip-git-repo-check',
        ...[
          'model_provider="agentgraph"',
          'model_providers.agentgraph.name="agentgraph"',
          `model_providers.agentgraph.base_url=${JSON.stringify(route.url)}`,
          'model_providers.agentgraph.env_key="AGENTGRAPH_LLM_API_KEY"',
          'model_providers.agentgraph.wire_api="responses"',
        ].flatMap(setting => ['-c', setting]),
        ...(route.model === 'default' ? [] : ['--model', route.model]),
        '--',
        resume ? spec.prompt : `${spec.system}\n\n${spec.prompt}`,
      ],
    };
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
              input: item.type === 'file_change' ? item.changes : item.command,
              ok: item.status !== 'failed' && (item.exit_code ?? 0) === 0,
              output: item.aggregated_output ?? '',
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
