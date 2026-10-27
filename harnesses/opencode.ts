import { Schema } from 'effect';
import type { Harness, Piece } from '../src/harnesses.ts';
import type { SessionEvent } from '../src/trace.ts';
import { makeResultServer } from '../src/result.ts';
import {
  makeCacheCounts,
  makeLineParser,
  makePrefixedToolForms,
  modelTimeouts,
  some,
  splitToolPattern,
} from './helpers.ts';

const { String: Str, Number: Num, Unknown, Struct, optional: opt } = Schema;

const OpencodeLine = Struct({
  ...some(Str, 'type', 'sessionID'),
  error: opt(Struct({ name: opt(Str), data: opt(Struct({ message: opt(Str) })) })),
  part: opt(
    Struct({
      ...some(Str, 'type', 'text', 'id', 'callID', 'tool', 'reason'),
      cost: opt(Num),
      state: opt(
        Struct({
          ...some(Str, 'status', 'output', 'error'),
          ...some(Unknown, 'input'),
          metadata: opt(Struct(some(Unknown, 'exit'))),
          time: opt(Struct(some(Num, 'start', 'end'))),
        })
      ),
      tokens: opt(Struct({ ...some(Num, 'input', 'output'), cache: opt(Struct(some(Num, 'read', 'write'))) })),
    })
  ),
});

const permission = (tools: string[], read: string[] = []) => {
  const rules: Record<string, string | Record<string, string>> = { '*': 'deny' };
  if (read.length)
    rules.external_directory = Object.fromEntries([['*', 'deny'], ...read.map(d => [`${d}/*`, 'allow'])]);
  for (const tool of makePrefixedToolForms(tools)) {
    const [, name = tool, glob] = splitToolPattern(tool);
    const current = rules[name];
    if (glob === undefined) rules[name] = 'allow';
    else if (current !== 'allow')
      rules[name] = { ...(typeof current === 'object' ? current : { '*': 'deny' }), [glob]: 'allow' };
  }
  return rules;
};

const numeric = /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+)$/i;

const words = (prompt: string) => {
  const out: string[] = [];
  for (const word of prompt.split(' ')) {
    if (!numeric.test(word)) {
      out.push(word);
      continue;
    }
    const last = out.pop();
    out.push(last === undefined ? `${word}\t` : `${last}\t${word}`);
  }
  return out;
};

const deniedByOpencode = 'prevents you from using this specific tool call';

export const opencode = (): Harness => ({
  name: 'opencode',
  key: 'AGENTGRAPH_LLM_API_KEY',
  home: () => ({
    links: {
      '.config/opencode/node_modules': '/opt/opencode/node_modules',
      '.config/opencode/package-lock.json': '/opt/opencode/package-lock.json',
    },
  }),
  command: (spec, route) => {
    const server = spec.returns && makeResultServer(spec.returns);
    const provider = route.url ? 'agentgraph' : 'openai';
    const timeouts = { headerTimeout: modelTimeouts.headersMs, chunkTimeout: modelTimeouts.idleMs };
    return {
      cmd: 'opencode',
      args: [
        'run',
        '--format',
        'json',
        '--title',
        'agentgraph',
        '--agent',
        'agentgraph',
        '--model',
        `${provider}/${route.model}`,
        ...(spec.resume ? ['--session', spec.resume.id, ...(spec.fork ? ['--fork'] : [])] : []),
        '--',
        ...words(spec.prompt),
      ],
      env: {
        AGENTGRAPH_LLM_BASE_URL: route.url,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          autoupdate: false,
          share: 'disabled',
          snapshot: false,
          compaction: { auto: false, prune: false },
          tool_output: { max_lines: 300, max_bytes: 16_384 },
          enabled_providers: [provider],
          provider: route.url
            ? {
                agentgraph: {
                  npm: '@ai-sdk/openai',
                  name: 'agentgraph',
                  options: {
                    baseURL: '{env:AGENTGRAPH_LLM_BASE_URL}',
                    apiKey: '{env:AGENTGRAPH_LLM_API_KEY}',
                    ...timeouts,
                  },
                  models: { [route.model]: {} },
                },
              }
            : { openai: { options: timeouts } },
          agent: { agentgraph: { mode: 'primary', prompt: spec.system } },
          ...(server && { mcp: { agentgraph: { type: 'local', command: [server.command, ...server.args] } } }),
        }),
        OPENCODE_PERMISSION: JSON.stringify(
          permission([...spec.tools, ...(server ? ['agentgraph_result'] : [])], spec.read)
        ),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_AUTOCOMPACT: '1',
        OPENCODE_DISABLE_PRUNE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
      },
    };
  },
  parse: () =>
    makeLineParser(OpencodeLine, line => {
      const session: Piece[] = line.sessionID ? [{ type: 'session', id: line.sessionID }] : [];
      const part = line.part ?? {};
      if (line.type === 'error')
        return [
          ...session,
          { type: 'done', ended: 'error', error: line.error?.data?.message ?? line.error?.name ?? 'opencode error' },
        ];
      if (part.type === 'text' && part.text) return [...session, { type: 'text', text: part.text }];
      if (part.type === 'reasoning' && part.text) return [...session, { type: 'thinking', text: part.text }];
      if (part.type === 'tool' && (part.state?.status === 'completed' || part.state?.status === 'error')) {
        const { state } = part;
        const output = state.output ?? state.error;
        const tool: Extract<SessionEvent, { type: 'tool' }> = {
          type: 'tool',
          id: part.callID ?? part.id ?? '',
          name: part.tool ?? '',
          input: state.input,
          ok: state.status === 'completed',
          ...(output !== undefined && { output }),
          ...(typeof state.metadata?.exit === 'number' && { exit: state.metadata.exit }),
          ...(state.time?.start && state.time.end && { ms: state.time.end - state.time.start }),
          ...(state.status === 'error' && output?.includes(deniedByOpencode) && { denied: true as const }),
        };
        return [...session, tool];
      }
      if (part.type === 'step-finish') {
        const t = part.tokens;
        const usage: Piece[] = t
          ? [
              {
                type: 'usage',
                input: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
                output: t.output ?? 0,
                ...makeCacheCounts(t.cache?.read, t.cache?.write),
                ...(part.cost && { usd: part.cost }),
              },
            ]
          : [];
        const reason = part.reason;
        if (reason === 'tool-calls') return [...session, ...usage];
        const ended = reason === 'stop' ? 'stop' : reason === 'length' ? 'cap' : 'error';
        return [
          ...session,
          ...usage,
          { type: 'done', ended, ...(ended === 'error' && { error: `finished with ${reason}` }) },
        ];
      }
      return session;
    }),
});
