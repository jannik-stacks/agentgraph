import { opencodeMcpConfig } from '../mcp-config.ts';
import type { AgentEvent, HarnessAdapter, RunSpec } from '../types.ts';

type ToolState =
  | { status: 'completed'; input?: unknown; output?: string }
  | { status: 'error'; input?: unknown; error?: string }
  | { status: string; input?: unknown };

type Part =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; callID?: string; tool: string; state: ToolState }
  | {
      type: 'step-finish';
      reason: string;
      tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
    }
  | { type: string };

type Line =
  | { type: 'text' | 'tool_use' | 'step_finish'; part: Part }
  | { type: 'error'; error?: { name?: string; data?: { message?: string } } }
  | { type: string };

/** The only provider: the model proxy, where bot models are aliases. */
const provider = 'bothub';

/** A permission per tool entry: `read` allows the tool, `bash(git diff*)` allows one pattern. */
const permission = (tools: string[]) => {
  const rules: Record<string, string | Record<string, string>> = { '*': 'deny' };
  for (const tool of tools) {
    const [, name = tool, pattern] = /^([^(]+)\((.*)\)$/.exec(tool) ?? [];
    const current = rules[name];
    if (pattern === undefined) rules[name] = 'allow';
    else if (current !== 'allow')
      rules[name] = { ...(typeof current === 'object' ? current : { '*': 'deny' }), [pattern]: 'allow' };
  }
  return rules;
};

const config = (spec: RunSpec) => ({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  share: 'disabled',
  snapshot: false,
  enabled_providers: [provider],
  provider: {
    [provider]: {
      npm: '@ai-sdk/openai-compatible',
      name: provider,
      options: { baseURL: '{env:BOTHUB_LLM_BASE_URL}', apiKey: '{env:BOTHUB_LLM_API_KEY}' },
      models: { [spec.model ?? 'default']: { options: { parallelToolCalls: false } } },
    },
  },
  agent: { [provider]: { mode: 'primary', prompt: spec.system, steps: spec.maxTurns } },
  ...(spec.mcp && opencodeMcpConfig(spec.mcp)),
});

const numeric = /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+)$/i;

/** Space-free words; a number is glued to the word before it with a tab, because the CLI would read it as a number. */
const words = (prompt: string) =>
  prompt.split(' ').reduce<string[]>((out, word) => {
    if (!numeric.test(word)) return [...out, word];
    const last = out.pop();
    return [...out, last === undefined ? `${word}\t` : `${last}\t${word}`];
  }, []);

/** The prompt goes in space-free words after `--` so the CLI neither parses nor re-quotes it. */
const command = (spec: RunSpec) => ({
  cmd: 'opencode',
  args: [
    'run',
    '--format',
    'json',
    '--pure',
    '--title',
    provider,
    '--agent',
    provider,
    '--model',
    `${provider}/${spec.model ?? 'default'}`,
    '--',
    ...words(spec.prompt),
  ],
  env: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config(spec)),
    OPENCODE_PERMISSION: JSON.stringify(permission(spec.tools)),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  },
});

const tool = (part: Extract<Part, { type: 'tool' }>): AgentEvent[] => {
  const id = part.callID ?? part.id;
  const { state } = part;
  if (state.status !== 'completed' && state.status !== 'error') return [];
  const output = 'output' in state ? state.output : 'error' in state ? state.error : undefined;
  return [
    { type: 'tool_call', id, tool: part.tool, input: state.input },
    { type: 'tool_result', id, ok: state.status === 'completed', ...(output !== undefined && { output }) },
  ];
};

const step = (part: Extract<Part, { type: 'step-finish' }>): AgentEvent[] => {
  const t = part.tokens;
  const usage: AgentEvent[] = t
    ? [
        {
          type: 'usage',
          inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
          outputTokens: t.output ?? 0,
        },
      ]
    : [];
  if (part.reason === 'tool-calls') return usage;
  return [...usage, { type: 'end', ok: part.reason === 'stop' }];
};

const event = (line: Line): AgentEvent[] => {
  if (line.type === 'error' && 'error' in line)
    return [{ type: 'error', message: line.error?.data?.message ?? line.error?.name ?? 'opencode error' }];
  if (!('part' in line)) return [];
  const { part } = line;
  if (part.type === 'text' && 'text' in part) return part.text ? [{ type: 'text', text: part.text }] : [];
  if (part.type === 'tool' && 'state' in part) return tool(part);
  if (part.type === 'step-finish' && 'reason' in part) return step(part);
  return [];
};

const parseLine = (raw: string): AgentEvent[] => {
  if (!raw.trim()) return [];
  try {
    return event(JSON.parse(raw) as Line);
  } catch (e) {
    return [{ type: 'error', message: `unreadable opencode output: ${(e as Error).message}` }];
  }
};

/**
 * opencode 1.x one-shot `run` against the bothub model proxy. Permissions deny everything outside the spec's
 * tool allowlist and project config is ignored.
 */
export const opencode: HarnessAdapter = { name: 'opencode', command, parseLine };
