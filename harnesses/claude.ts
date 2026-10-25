import { Schema } from 'effect';
import type { Harness, Piece } from '../src/harnesses.ts';
import {
  getBlockText,
  makeCacheCounts,
  makeLineParser,
  makeOptionalFields as some,
  makePrefixedToolForms,
  modelTimeouts,
  splitToolPattern,
} from './helpers.ts';

const { String: Str, Number: Num, Boolean: Bool, Unknown, Struct, optional: opt } = Schema;

const ClaudeBlock = Struct({
  ...some(Str, 'type', 'text', 'thinking', 'id', 'name', 'tool_use_id'),
  ...some(Unknown, 'input', 'content'),
  is_error: opt(Bool),
});
const ClaudeLine = Struct({
  ...some(Str, 'type', 'subtype', 'session_id', 'model', 'result'),
  is_error: opt(Bool),
  message: opt(Struct({ content: opt(Schema.Union(Str, Schema.Array(ClaudeBlock))) })),
  permission_denials: opt(
    Schema.Array(Struct({ ...some(Str, 'tool_use_id', 'tool_name'), ...some(Unknown, 'tool_input') }))
  ),
  modelUsage: opt(
    Schema.Record({
      key: Str,
      value: Struct(some(Num, 'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens')),
    })
  ),
});

const claudeNames: Record<string, string> = {
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  edit: 'Edit',
  write: 'Write',
  bash: 'Bash',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
};

const claudeTools = (tools: string[]) =>
  makePrefixedToolForms(tools).flatMap(tool => {
    const [, name = tool, glob] = splitToolPattern(tool);
    const mapped = claudeNames[name];
    return mapped ? [glob === undefined ? mapped : `${mapped}(${glob})`] : [];
  });

export const claude = (): Harness => ({
  name: 'claude',
  key: 'ANTHROPIC_AUTH_TOKEN',
  command: (spec, route) => {
    const list = claudeTools(spec.tools);
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
        '--permission-mode',
        'dontAsk',
        '--tools',
        [...new Set(list.map(tool => tool.replace(/\(.*$/, '')))].join(','),
        ...(list.length ? ['--allowedTools', list.join(',')] : []),
        ...(spec.read ?? []).flatMap(dir => ['--add-dir', dir]),
        ...(spec.model ? ['--model', spec.model] : []),
        ...(spec.resume ? ['--resume', spec.resume.id, ...(spec.fork ? ['--fork-session'] : [])] : []),
        '--append-system-prompt',
        spec.system,
        '--',
        spec.prompt,
      ],
      env: {
        ANTHROPIC_BASE_URL: route.url.replace(/\/v1\/?$/, ''),
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        API_TIMEOUT_MS: String(modelTimeouts.headersMs),
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: String(modelTimeouts.idleMs),
      },
    };
  },
  parse: () => {
    const calls = new Map<string, { name: string; input: unknown }>();
    return makeLineParser(ClaudeLine, line => {
      if (line.type === 'system' && line.subtype === 'init' && line.session_id)
        return [{ type: 'session', id: line.session_id, ...(line.model && { model: line.model }) }];
      const content = line.message?.content;
      if ((line.type === 'assistant' || line.type === 'user') && Array.isArray(content))
        return content.flatMap((b): Piece[] => {
          if (b.type === 'text' && b.text) return [{ type: 'text', text: b.text }];
          if (b.type === 'thinking' && b.thinking) return [{ type: 'thinking', text: b.thinking }];
          if (b.type === 'tool_use' && b.id) calls.set(b.id, { name: b.name ?? '', input: b.input });
          if (b.type !== 'tool_result' || !b.tool_use_id) return [];
          const call = calls.get(b.tool_use_id);
          return [
            {
              type: 'tool',
              id: b.tool_use_id,
              name: call?.name ?? '',
              input: call?.input,
              ok: !b.is_error,
              output: getBlockText(b.content),
            },
          ];
        });
      if (line.type !== 'result') return [];
      const denied = (line.permission_denials ?? []).map((d): Piece => ({
        type: 'tool',
        id: d.tool_use_id ?? '',
        name: d.tool_name ?? '',
        input: d.tool_input,
        ok: false,
        denied: true,
      }));
      const usage = Object.values(line.modelUsage ?? {}).map(
        ({ inputTokens = 0, outputTokens = 0, cacheReadInputTokens = 0, cacheCreationInputTokens = 0 }): Piece => ({
          type: 'usage',
          input: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
          output: outputTokens,
          ...makeCacheCounts(cacheReadInputTokens, cacheCreationInputTokens),
        })
      );
      const ended =
        line.subtype === 'success' && !line.is_error ? 'stop' : line.subtype === 'error_max_turns' ? 'cap' : 'error';
      return [
        ...denied,
        ...usage,
        { type: 'done', ended, ...(ended === 'error' && { error: line.result || line.subtype || 'claude failed' }) },
      ];
    });
  },
});
