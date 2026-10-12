import type { AgentEvent, ExecutorAdapter, RunSpec } from '../types.ts';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content?: string | { type: string; text?: string }[];
      is_error?: boolean;
    }
  | { type: string };

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type Line =
  | { type: 'system'; subtype: string; session_id?: string; model?: string }
  | { type: 'assistant' | 'user'; message: { content: Block[] | string } }
  | {
      type: 'result';
      subtype: string;
      is_error: boolean;
      num_turns?: number;
      result?: string;
      total_cost_usd?: number;
      usage?: Usage;
    };

const command = (spec: RunSpec) => ({
  cmd: 'claude',
  args: [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(spec.maxTurns),
    '--append-system-prompt',
    spec.system,
    ...(spec.model ? ['--model', spec.model] : []),
    // dontAsk denies anything off the allowlist; no setting sources so user or repo settings cannot widen it.
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    ...(spec.tools.length ? ['--allowedTools', ...spec.tools] : []),
    '--',
    spec.prompt,
  ],
  env: {},
});

const text = (content: Extract<Block, { type: 'tool_result' }>['content']) =>
  typeof content === 'string' ? content : content?.map(c => c.text ?? '').join('');

const block = (b: Block): AgentEvent[] => {
  if (b.type === 'text' && 'text' in b) return b.text ? [{ type: 'text', text: b.text }] : [];
  if (b.type === 'tool_use' && 'name' in b) return [{ type: 'tool_call', id: b.id, tool: b.name, input: b.input }];
  if (b.type === 'tool_result' && 'tool_use_id' in b) {
    const output = text(b.content);
    return [{ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, ...(output !== undefined && { output }) }];
  }
  return [];
};

const event = (line: Line): AgentEvent[] => {
  switch (line.type) {
    case 'system':
      if (line.subtype !== 'init') return [];
      return [
        {
          type: 'start',
          ...(line.session_id && { session: line.session_id }),
          ...(line.model && { model: line.model }),
        },
      ];
    case 'assistant':
    case 'user':
      return typeof line.message.content === 'string' ? [] : line.message.content.flatMap(block);
    case 'result': {
      const u = line.usage;
      const usage: AgentEvent[] = u
        ? [
            {
              type: 'usage',
              inputTokens:
                (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
            },
          ]
        : [];
      return [
        ...usage,
        {
          type: 'end',
          ok: !line.is_error && line.subtype === 'success',
          ...(line.num_turns !== undefined && { turns: line.num_turns }),
          ...(line.result !== undefined && { result: line.result }),
          ...(line.total_cost_usd !== undefined && { costUsd: line.total_cost_usd }),
        },
      ];
    }
    default:
      return [];
  }
};

const parseLine = (raw: string): AgentEvent[] => {
  if (!raw.trim()) return [];
  try {
    return event(JSON.parse(raw) as Line);
  } catch (e) {
    return [{ type: 'error', message: `unreadable claude output: ${(e as Error).message}` }];
  }
};

/** Claude Code in headless mode, streaming JSON events, restricted to the spec's tool allowlist. */
export const claude: ExecutorAdapter = { name: 'claude-code', command, parseLine };
