import type { AgentEvent, ExecutorAdapter, RunSpec } from '../types.ts';

type Item =
  | { id: string; type: 'agent_message'; text: string }
  | {
      id: string;
      type: 'command_execution';
      command: string;
      aggregated_output?: string;
      exit_code?: number | null;
      status: string;
    }
  | { id: string; type: 'file_change'; changes: { path: string; kind: string }[]; status: string }
  | {
      id: string;
      type: 'mcp_tool_call';
      server: string;
      tool: string;
      arguments?: unknown;
      status: string;
      error?: { message: string } | null;
    }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'error'; message: string }
  | { id: string; type: string };

type Line =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'item.started' | 'item.completed'; item: Item }
  | { type: 'turn.completed'; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: 'turn.failed'; error?: { message: string } }
  | { type: 'error'; message: string };

/** Codex has no turn limit, so `spec.maxTurns` is left to the runner's timeout. */
const command = (spec: RunSpec) => ({
  cmd: 'codex',
  args: [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="never"',
    '-c',
    `developer_instructions=${JSON.stringify(spec.system)}`,
    '-C',
    spec.cwd,
    ...(spec.model ? ['-m', spec.model] : []),
    '--',
    spec.prompt,
  ],
  env: {},
});

const started = (item: Item): AgentEvent[] => {
  if (item.type === 'command_execution' && 'command' in item)
    return [{ type: 'tool_call', id: item.id, tool: 'shell', input: { command: item.command } }];
  if (item.type === 'mcp_tool_call' && 'server' in item)
    return [{ type: 'tool_call', id: item.id, tool: `${item.server}.${item.tool}`, input: item.arguments }];
  return [];
};

const completed = (item: Item): AgentEvent[] => {
  if (item.type === 'agent_message' && 'text' in item) return [{ type: 'text', text: item.text }];
  if (item.type === 'command_execution' && 'command' in item)
    return [
      {
        type: 'tool_result',
        id: item.id,
        ok: item.exit_code === 0,
        ...(item.aggregated_output && { output: item.aggregated_output }),
      },
    ];
  if (item.type === 'mcp_tool_call' && 'server' in item)
    return [
      {
        type: 'tool_result',
        id: item.id,
        ok: item.status === 'completed',
        ...(item.error && { output: item.error.message }),
      },
    ];
  if (item.type === 'file_change' && 'changes' in item)
    return [
      { type: 'tool_call', id: item.id, tool: 'apply_patch', input: { changes: item.changes } },
      { type: 'tool_result', id: item.id, ok: item.status === 'completed' },
    ];
  if (item.type === 'web_search' && 'query' in item)
    return [
      { type: 'tool_call', id: item.id, tool: 'web_search', input: { query: item.query } },
      { type: 'tool_result', id: item.id, ok: true },
    ];
  if (item.type === 'error' && 'message' in item) return [{ type: 'error', message: item.message }];
  return [];
};

const event = (line: Line): AgentEvent[] => {
  switch (line.type) {
    case 'thread.started':
      return [{ type: 'start', session: line.thread_id }];
    case 'item.started':
      return started(line.item);
    case 'item.completed':
      return completed(line.item);
    case 'turn.completed':
      return [
        { type: 'usage', inputTokens: line.usage?.input_tokens ?? 0, outputTokens: line.usage?.output_tokens ?? 0 },
        { type: 'end', ok: true },
      ];
    case 'turn.failed':
      return [
        { type: 'error', message: line.error?.message ?? 'turn failed' },
        { type: 'end', ok: false },
      ];
    case 'error':
      return [{ type: 'error', message: line.message }];
    default:
      return [];
  }
};

const parseLine = (raw: string): AgentEvent[] => {
  if (!raw.trim()) return [];
  try {
    return event(JSON.parse(raw) as Line);
  } catch (e) {
    return [{ type: 'error', message: `unreadable codex output: ${(e as Error).message}` }];
  }
};

/** Codex in non-interactive exec mode, sandboxed to writes inside the workspace. */
export const codex: ExecutorAdapter = { name: 'codex', command, parseLine };
