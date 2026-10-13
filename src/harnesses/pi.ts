import { fileURLToPath } from 'node:url';
import type { AgentEvent, HarnessAdapter, RunSpec } from '../types.ts';

type Block = { type: 'text'; text: string } | { type: string };

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { total?: number };
};

type Message =
  | {
      role: 'assistant';
      content: Block[];
      usage?: Usage;
      stopReason?: string;
      errorMessage?: string;
      responseModel?: string;
    }
  | { role: string };

type Line =
  | { type: 'session'; id: string }
  | { type: 'message_end'; message: Message }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      result?: { content?: Block[] };
      isError?: boolean;
    }
  | { type: 'agent_end'; messages: Message[]; willRetry?: boolean }
  | { type: string };

type Assistant = Extract<Message, { role: 'assistant' }>;

const extension = fileURLToPath(new URL('./pi-provider.ts', import.meta.url));

/** pi has no turn limit, so `spec.maxTurns` is left to the runner's timeout. */
const command = (spec: RunSpec) => ({
  cmd: 'pi',
  args: [
    '--print',
    '--mode',
    'json',
    '--no-session',
    '--offline',
    '--no-approve',
    '--no-context-files',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--extension',
    extension,
    ...(spec.tools.length ? ['--tools', spec.tools.join(',')] : ['--no-tools']),
    '--model',
    `bothub/${spec.model ?? 'default'}`,
    '--append-system-prompt',
    spec.system,
    '--',
    spec.prompt,
  ],
  env: { BOTHUB_LLM_MODEL: spec.model ?? 'default', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
});

const text = (blocks: Block[] = []) => blocks.flatMap(b => (b.type === 'text' && 'text' in b ? [b.text] : [])).join('');

const isAssistant = (m: Message): m is Assistant => m.role === 'assistant';

const failed = (m: Assistant | undefined) => !m || m.stopReason === 'error' || m.stopReason === 'aborted';

const finished = (messages: Message[]): AgentEvent[] => {
  const replies = messages.filter(isAssistant);
  const last = replies.at(-1);
  const result = last && text(last.content);
  return [
    ...(failed(last) ? [{ type: 'error' as const, message: last?.errorMessage ?? 'pi produced no reply' }] : []),
    { type: 'end', ok: !failed(last), turns: replies.length, ...(result && { result }) },
  ];
};

const reply = (m: Assistant): AgentEvent[] => {
  const t = text(m.content);
  const u = m.usage;
  return [
    ...(m.responseModel ? [{ type: 'start' as const, model: m.responseModel }] : []),
    ...(t ? [{ type: 'text' as const, text: t }] : []),
    ...(u && (u.input || u.output)
      ? [
          {
            type: 'usage' as const,
            inputTokens: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
            outputTokens: u.output ?? 0,
            ...(u.cacheRead && { cachedInputTokens: u.cacheRead }),
            ...(u.reasoning && { reasoningTokens: u.reasoning }),
            ...(u.cost?.total && { costUsd: u.cost.total }),
          },
        ]
      : []),
  ];
};

const event = (line: Line): AgentEvent[] => {
  if (line.type === 'session' && 'id' in line) return [{ type: 'start', session: line.id }];
  if (line.type === 'message_end' && 'message' in line) return isAssistant(line.message) ? reply(line.message) : [];
  if (line.type === 'tool_execution_start' && 'toolName' in line)
    return [{ type: 'tool_call', id: line.toolCallId, tool: line.toolName, input: line.args }];
  if (line.type === 'tool_execution_end' && 'toolCallId' in line) {
    const output = line.result?.content && text(line.result.content);
    return [{ type: 'tool_result', id: line.toolCallId, ok: !line.isError, ...(output !== undefined && { output }) }];
  }
  if (line.type === 'agent_end' && 'messages' in line) return line.willRetry ? [] : finished(line.messages);
  return [];
};

const parseLine = (raw: string): AgentEvent[] => {
  if (!raw.trim()) return [];
  try {
    return event(JSON.parse(raw) as Line);
  } catch (e) {
    return [{ type: 'error', message: `unreadable pi output: ${(e as Error).message}` }];
  }
};

/** pi in print mode with JSON events, limited to the spec's tools and the bothub model proxy. */
export const pi: HarnessAdapter = { name: 'pi', command, parseLine };
