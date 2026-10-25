import { Schema } from 'effect';
import type { Harness, Piece } from '../src/harnesses.ts';
import { makeCacheCounts, makeLineParser, some } from './helpers.ts';

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

export const makeCodexHarness = (): Harness => ({
  name: 'codex',
  key: 'AGENTGRAPH_LLM_API_KEY',
  volumes: { '/codex': 'agentgraph-codex' },
  command: (spec, route) => ({
    cmd: 'codex',
    args: [
      'exec',
      ...(spec.resume ? ['resume', spec.resume.id] : []),
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      ...(route.url
        ? [
            'model_provider="agentgraph"',
            `model_providers.agentgraph.base_url=${JSON.stringify(route.url)}`,
            'model_providers.agentgraph.env_key="AGENTGRAPH_LLM_API_KEY"',
            'model_providers.agentgraph.wire_api="responses"',
          ].flatMap(setting => ['-c', setting])
        : []),
      ...(route.model === 'default' ? [] : ['--model', route.model]),
      '--',
      spec.resume ? spec.prompt : `${spec.system}\n\n${spec.prompt}`,
    ],
    env: { CODEX_HOME: '/codex' },
  }),
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
