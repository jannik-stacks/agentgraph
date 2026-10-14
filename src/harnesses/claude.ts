import { homedir } from 'node:os';
import type { AgentEvent, HarnessAdapter, RunSpec } from '../types.ts';
import { jsonLines } from './lines.ts';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | Block[]; is_error: boolean | undefined }
  | { type: string };

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

type Line =
  | { type: 'system'; subtype: string; session_id: string; model: string }
  | { type: 'assistant' | 'user'; message: { content: string | Block[] } }
  | {
      type: 'result';
      subtype?: string;
      is_error: boolean;
      num_turns: number;
      result?: string;
      modelUsage: Record<string, ModelUsage>;
    }
  | { type: string };

/** Billed by the subscription: a name no price table lists, so runs are never priced at list rates. */
const billed = (model: string) => `claude-code/${model}`;

const names: Record<string, string> = {
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  edit: 'Edit',
  write: 'Write',
  bash: 'Bash',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
};

/** `read` becomes `Read`, `bash(git diff*)` becomes `Bash(git diff*)`; hub tools are left out. */
const allowed = (tools: string[]) =>
  tools.flatMap(tool => {
    const [, name = tool, pattern] = /^([^(]+)\((.*)\)$/.exec(tool) ?? [];
    const mapped = names[name];
    return mapped ? [pattern === undefined ? mapped : `${mapped}(${pattern})`] : [];
  });

/**
 * The CLI logs in through the host user's own config, so `HOME` and `CLAUDE_CONFIG_DIR` point back at it. Safe and
 * restricted mode keep out project memory, settings, hooks, plugins and MCP servers; anything outside the allowlist
 * is denied without asking.
 */
const command = (spec: RunSpec) => {
  const list = allowed(spec.tools);
  return {
    cmd: 'claude',
    args: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--safe-mode',
      '--restricted',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      '--tools',
      [...new Set(list.map(tool => tool.replace(/\(.*$/, '')))].join(','),
      ...(list.length ? ['--allowedTools', list.join(',')] : []),
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.maxTurns ? ['--max-turns', String(spec.maxTurns)] : []),
      '--append-system-prompt',
      spec.system,
      '--',
      spec.prompt,
    ],
    env: {
      HOME: homedir(),
      ...(process.env.CLAUDE_CONFIG_DIR && { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }),
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
};

const text = (content: string | Block[] = []): string =>
  typeof content === 'string'
    ? content
    : content.flatMap(b => (b.type === 'text' && 'text' in b ? [b.text] : [])).join('');

const block = (b: Block): AgentEvent[] => {
  if (b.type === 'text' && 'text' in b) return b.text ? [{ type: 'text', text: b.text }] : [];
  if (b.type === 'tool_use' && 'name' in b) return [{ type: 'tool_call', id: b.id, tool: b.name, input: b.input }];
  if (b.type === 'tool_result' && 'tool_use_id' in b)
    return [{ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, output: text(b.content) }];
  return [];
};

/** Usage comes from the final totals per model, since per-message usage is a streaming snapshot. */
const usage = ([model, u]: [string, ModelUsage]): AgentEvent => ({
  type: 'usage',
  inputTokens: u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
  outputTokens: u.outputTokens,
  ...(u.cacheReadInputTokens && { cachedInputTokens: u.cacheReadInputTokens }),
  model: billed(model),
});

const event = (line: Line): AgentEvent[] => {
  if (line.type === 'system' && 'subtype' in line && line.subtype === 'init')
    return [{ type: 'start', session: line.session_id, model: billed(line.model) }];
  if ((line.type === 'assistant' || line.type === 'user') && 'message' in line) {
    const { content } = line.message;
    return typeof content === 'string' ? [] : content.flatMap(block);
  }
  if (line.type === 'result' && 'num_turns' in line) {
    const ok = !line.is_error;
    return [
      ...Object.entries(line.modelUsage).map(usage),
      ...(ok ? [] : [{ type: 'error' as const, message: line.result || line.subtype || 'claude failed' }]),
      {
        type: 'end',
        ok,
        ...(line.num_turns && { turns: line.num_turns }),
        ...(line.result && { result: line.result }),
      },
    ];
  }
  return [];
};

const parseLine = jsonLines<Line>('claude', event);

/** Claude Code in print mode on the host user's subscription, limited to the spec's tools. */
export const claude: HarnessAdapter = { name: 'claude', command, parseLine };
