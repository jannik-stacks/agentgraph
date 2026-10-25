import { Schema } from 'effect';
import type { Harness } from '../src/harnesses.ts';
import {
  getBlockText,
  makeCacheCounts,
  makeLineParser,
  makeOptionalFields as some,
  modelTimeouts,
  splitToolPattern,
} from './helpers.ts';

const { String: Str, Number: Num, Boolean: Bool, Unknown, Struct, optional: opt } = Schema;

const PiMessage = Struct({
  ...some(Str, 'role', 'stopReason', 'errorMessage'),
  ...some(Unknown, 'content'),
  usage: opt(
    Struct({ ...some(Num, 'input', 'output', 'cacheRead', 'cacheWrite'), cost: opt(Struct(some(Num, 'total'))) })
  ),
});
const PiLine = Struct({
  ...some(Str, 'type', 'id', 'toolCallId', 'toolName'),
  ...some(Bool, 'isError', 'willRetry'),
  ...some(Unknown, 'args'),
  result: opt(Struct(some(Unknown, 'content'))),
  message: opt(PiMessage),
  messages: opt(Schema.Array(PiMessage)),
});

export const pi = (): Harness => ({
  name: 'pi',
  key: 'AGENTGRAPH_LLM_API_KEY',
  home: (_, route) => ({
    files: {
      '.pi/agent/models.json': JSON.stringify({
        providers: {
          agentgraph: {
            baseUrl: route.url,
            api: 'openai-completions',
            apiKey: '$AGENTGRAPH_LLM_API_KEY',
            models: [{ id: route.model, contextWindow: 200_000, maxTokens: 32_000 }],
          },
        },
      }),
      '.pi/agent/settings.json': JSON.stringify({ httpIdleTimeoutMs: modelTimeouts.idleMs }),
    },
  }),
  command: (spec, route) => {
    const tools = spec.tools.filter(tool => splitToolPattern(tool)[2] === undefined);
    return {
      cmd: 'pi',
      args: [
        '--print',
        '--mode',
        'json',
        '--offline',
        '--no-approve',
        '--no-context-files',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        ...(tools.length ? ['--tools', tools.join(',')] : ['--no-tools']),
        '--model',
        `agentgraph/${route.model}`,
        ...(spec.resume ? [spec.fork ? '--fork' : '--session', spec.resume.id] : []),
        '--append-system-prompt',
        spec.system,
        '--',
        spec.prompt,
      ],
      env: { PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
    };
  },
  parse: () => {
    const calls = new Map<string, { name: string; input: unknown }>();
    return makeLineParser(PiLine, line => {
      if (line.type === 'session' && line.id) return [{ type: 'session', id: line.id }];
      const id = line.toolCallId ?? '';
      if (line.type === 'tool_execution_start') calls.set(id, { name: line.toolName ?? '', input: line.args });
      if (line.type === 'tool_execution_end') {
        const output = getBlockText(line.result?.content);
        const call = calls.get(id) ?? { name: '', input: undefined };
        return [{ type: 'tool', id, ...call, ok: !line.isError, output }];
      }
      const m = line.message;
      if (line.type === 'message_end' && m?.role === 'assistant') {
        const text = getBlockText(m.content);
        const thinking = getBlockText(m.content, 'thinking');
        const u = m.usage;
        return [
          ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...(u && (u.input || u.output)
            ? [
                {
                  type: 'usage' as const,
                  input: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
                  output: u.output ?? 0,
                  ...makeCacheCounts(u.cacheRead, u.cacheWrite),
                  ...(u.cost?.total && { usd: u.cost.total }),
                },
              ]
            : []),
        ];
      }
      if (line.type === 'agent_end' && !line.willRetry) {
        const last = (line.messages ?? []).filter(x => x.role === 'assistant').at(-1);
        const reason = last?.stopReason;
        const ended =
          !last || reason === 'error' || reason === 'aborted' ? 'error' : reason === 'length' ? 'cap' : 'stop';
        return [
          { type: 'done', ended, ...(ended === 'error' && { error: last?.errorMessage ?? 'pi produced no reply' }) },
        ];
      }
      return [];
    });
  },
});
