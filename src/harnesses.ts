import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open as openFile, readFile, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import type { Agent } from './hub.ts';
import { Sandbox, type SandboxError } from './sandbox.ts';
import { Session } from './session.ts';
import { type SessionEvent, type SessionSpec, SessionStop } from './trace.ts';

type Ended = Extract<SessionEvent, { type: 'end' }>['ended'];
type Tool = Extract<SessionEvent, { type: 'tool' }>;

/** What one harness output line says, before the session loop adds the home, the reply and the exit code. */
type Piece =
  | { type: 'session'; id: string; model?: string }
  | Extract<SessionEvent, { type: 'text' | 'thinking' | 'tool' }>
  | Extract<SessionEvent, { type: 'usage' }>
  | { type: 'done'; ended: Ended; error?: string };

type Adapter = {
  command: (spec: SessionSpec, url: string) => { cmd: string; args: string[]; env: Record<string, string> };
  key: string;
  files?: (spec: SessionSpec, url: string) => Record<string, string>;
  links?: Record<string, string>;
  parser: () => (line: unknown) => Piece[];
};

/** Parses the JSON lines that decode as `schema`; any other line says nothing. */
const decoding = <A, I>(schema: Schema.Schema<A, I>, parse: (line: A) => Piece[]) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (line: unknown) => Option.match(decode(line), { onNone: () => [], onSome: parse });
};

/** Optional fields of one schema, by name. */
const some = <S extends Schema.Schema.Any, K extends string>(schema: S, ...keys: K[]) =>
  Object.fromEntries(keys.map(key => [key, Schema.optional(schema)])) as Record<K, Schema.optional<S>>;
const { String: Str, Number: Num, Boolean: Bool, Unknown, Struct, optional: opt } = Schema;

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

/** Cache token counts, only where the harness reported some. */
const cache = (read = 0, write = 0) => ({
  ...(read > 0 && { cacheRead: read }),
  ...(write > 0 && { cacheWrite: write }),
});

const modelTimeouts = { headersMs: 120_000, idleMs: 180_000 };
const alias = (spec: SessionSpec) => spec.model ?? 'default';
const pattern = (tool: string) => /^([^(]+)\((.*)\)$/.exec(tool) ?? [tool, tool, undefined];

/** A bash pattern also allows its command behind an empty `NODE_OPTIONS= command ` prefix, which runs it unchanged. */
const forms = (tools: string[]) =>
  tools.flatMap(tool => (tool.startsWith('bash(') ? [tool, `bash(NODE_OPTIONS= command ${tool.slice(5)}`] : [tool]));

/** A permission per tool entry: `read` allows the tool, `bash(git diff*)` allows one pattern. `read` dirs are reachable. */
const permission = (tools: string[], read: string[] = []) => {
  const rules: Record<string, string | Record<string, string>> = { '*': 'deny' };
  if (read.length)
    rules.external_directory = Object.fromEntries([['*', 'deny'], ...read.map(d => [`${d}/*`, 'allow'])]);
  for (const tool of forms(tools)) {
    const [, name = tool, glob] = pattern(tool);
    const current = rules[name];
    if (glob === undefined) rules[name] = 'allow';
    else if (current !== 'allow')
      rules[name] = { ...(typeof current === 'object' ? current : { '*': 'deny' }), [glob]: 'allow' };
  }
  return rules;
};

const numeric = /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+)$/i;

/** Space-free words; a number is glued to the word before it with a tab, because the CLI would read it as a number. */
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

/**
 * opencode `run` against the model proxy's Responses API. Permissions deny everything outside the allowlist, project
 * config and harness memory are off, and sessions live in the run home.
 */
const opencode: Adapter = {
  key: 'AGENTGRAPH_LLM_API_KEY',
  links: {
    '.config/opencode/node_modules': '/opt/opencode/node_modules',
    '.config/opencode/package-lock.json': '/opt/opencode/package-lock.json',
  },
  command: (spec, url) => ({
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
      `agentgraph/${alias(spec)}`,
      ...(spec.resume ? ['--session', spec.resume.id, ...(spec.fork ? ['--fork'] : [])] : []),
      '--',
      ...words(spec.prompt),
    ],
    env: {
      AGENTGRAPH_LLM_BASE_URL: url,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        snapshot: false,
        compaction: { auto: false, prune: false },
        tool_output: { max_lines: 300, max_bytes: 16_384 },
        enabled_providers: ['agentgraph'],
        provider: {
          agentgraph: {
            npm: '@ai-sdk/openai',
            name: 'agentgraph',
            options: {
              baseURL: '{env:AGENTGRAPH_LLM_BASE_URL}',
              apiKey: '{env:AGENTGRAPH_LLM_API_KEY}',
              headerTimeout: modelTimeouts.headersMs,
              chunkTimeout: modelTimeouts.idleMs,
            },
            models: { [alias(spec)]: {} },
          },
        },
        agent: { agentgraph: { mode: 'primary', prompt: spec.system } },
      }),
      OPENCODE_PERMISSION: JSON.stringify(permission(spec.tools, spec.read)),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOCOMPACT: '1',
      OPENCODE_DISABLE_PRUNE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    },
  }),
  parser: () =>
    decoding(OpencodeLine, line => {
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
        const tool: Tool = {
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
                ...cache(t.cache?.read, t.cache?.write),
                ...(part.cost && { usd: part.cost }),
              },
            ]
          : [];
        const reason = part.reason;
        if (reason === 'tool-calls') return [...session, ...usage];
        const ended: Ended = reason === 'stop' ? 'stop' : reason === 'length' ? 'cap' : 'error';
        return [
          ...session,
          ...usage,
          { type: 'done', ended, ...(ended === 'error' && { error: `finished with ${reason}` }) },
        ];
      }
      return session;
    }),
};

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
  forms(tools).flatMap(tool => {
    const [, name = tool, glob] = pattern(tool);
    const mapped = claudeNames[name];
    return mapped ? [glob === undefined ? mapped : `${mapped}(${glob})`] : [];
  });

const blockText = (content: unknown, type = 'text'): string =>
  typeof content === 'string'
    ? type === 'text'
      ? content
      : ''
    : Array.isArray(content)
      ? content.flatMap(b => (b?.type === type && typeof b[type] === 'string' ? [b[type]] : [])).join('')
      : '';

/**
 * Claude Code in print mode against the model proxy's Anthropic endpoint. Its config and sessions live in the run
 * home; safe and restricted mode keep out project settings, hooks, plugins and MCP servers.
 */
const claude: Adapter = {
  key: 'ANTHROPIC_AUTH_TOKEN',
  command: (spec, url) => {
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
        ANTHROPIC_BASE_URL: url.replace(/\/v1\/?$/, ''),
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        API_TIMEOUT_MS: String(modelTimeouts.headersMs),
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: String(modelTimeouts.idleMs),
      },
    };
  },
  parser: () => {
    const calls = new Map<string, { name: string; input: unknown }>();
    return decoding(ClaudeLine, line => {
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
              output: blockText(b.content),
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
          ...cache(cacheReadInputTokens, cacheCreationInputTokens),
        })
      );
      const ended: Ended =
        line.subtype === 'success' && !line.is_error ? 'stop' : line.subtype === 'error_max_turns' ? 'cap' : 'error';
      return [
        ...denied,
        ...usage,
        { type: 'done', ended, ...(ended === 'error' && { error: line.result || line.subtype || 'claude failed' }) },
      ];
    });
  },
};

/** pi in print mode with JSON events, its one provider the model proxy, set up in the run home's `models.json`. */
const pi: Adapter = {
  key: 'AGENTGRAPH_LLM_API_KEY',
  command: spec => {
    const tools = spec.tools.filter(tool => pattern(tool)[2] === undefined);
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
        `agentgraph/${alias(spec)}`,
        ...(spec.resume ? [spec.fork ? '--fork' : '--session', spec.resume.id] : []),
        '--append-system-prompt',
        spec.system,
        '--',
        spec.prompt,
      ],
      env: { PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' },
    };
  },
  files: (spec, url) => ({
    '.pi/agent/models.json': JSON.stringify({
      providers: {
        agentgraph: {
          baseUrl: url,
          api: 'openai-completions',
          apiKey: '$AGENTGRAPH_LLM_API_KEY',
          models: [{ id: alias(spec), contextWindow: 200_000, maxTokens: 32_000 }],
        },
      },
    }),
    '.pi/agent/settings.json': JSON.stringify({ httpIdleTimeoutMs: modelTimeouts.idleMs }),
  }),
  parser: () => {
    const calls = new Map<string, { name: string; input: unknown }>();
    return decoding(PiLine, line => {
      if (line.type === 'session' && line.id) return [{ type: 'session', id: line.id }];
      const id = line.toolCallId ?? '';
      if (line.type === 'tool_execution_start') calls.set(id, { name: line.toolName ?? '', input: line.args });
      if (line.type === 'tool_execution_end') {
        const output = blockText(line.result?.content);
        const call = calls.get(id) ?? { name: '', input: undefined };
        return [{ type: 'tool', id, ...call, ok: !line.isError, output }];
      }
      const m = line.message;
      if (line.type === 'message_end' && m?.role === 'assistant') {
        const text = blockText(m.content);
        const thinking = blockText(m.content, 'thinking');
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
                  ...cache(u.cacheRead, u.cacheWrite),
                  ...(u.cost?.total && { usd: u.cost.total }),
                },
              ]
            : []),
        ];
      }
      if (line.type === 'agent_end' && !line.willRetry) {
        const last = (line.messages ?? []).filter(x => x.role === 'assistant').at(-1);
        const reason = last?.stopReason;
        const ended: Ended =
          !last || reason === 'error' || reason === 'aborted' ? 'error' : reason === 'length' ? 'cap' : 'stop';
        return [
          { type: 'done', ended, ...(ended === 'error' && { error: last?.errorMessage ?? 'pi produced no reply' }) },
        ];
      }
      return [];
    });
  },
};

const adapters: Record<Agent['harness'], Adapter> = { opencode, claude, pi };

const exitLine = /^agentgraph-exit (\d+)$/;

/** Runs the harness and prints its exit code as a last line, so the stream says how the process ended. */
const wrapped = (cmd: string, args: string[]) => ({
  cmd: 'sh',
  args: ['-c', '"$@" 2>&1; code=$?; printf "\\nagentgraph-exit %s\\n" "$code"; exit "$code"', 'sh', cmd, ...args],
});

/** `agent=key` pairs, separated by commas or white space. */
const keysOf = (keys: Redacted.Redacted) =>
  Object.fromEntries(
    Redacted.value(keys)
      .split(/[\s,]+/)
      .flatMap(pair => {
        const at = pair.indexOf('=');
        return at > 0 ? [[pair.slice(0, at), Redacted.make(pair.slice(at + 1))]] : [];
      })
  );

/**
 * List prices in USD per million tokens, keyed by upstream model, the proxy's aliases for them, and the upstream
 * prefixes a subscription pays for, whose list price is only an estimate.
 */
export type Prices = {
  aliases?: Record<string, string>;
  models?: Record<string, { input: number; output: number; cached?: number; cacheWrite?: number }>;
  subscriptions?: string[];
};

/** The list price of the first of `models` the table knows, by its own name, its alias's upstream or a bare name. */
export const priceOf = (prices: Prices, models: string[]) => {
  const bare = (model: string) => model.split('/').at(-1) ?? model;
  return models
    .flatMap(model => [model, prices.aliases?.[model] ?? model, prices.aliases?.[bare(model)] ?? model])
    .map(model => prices.models?.[model] ?? prices.models?.[bare(model)])
    .find(Boolean);
};

/** The usage's list price when the harness reports none, as a subscription through the proxy does; else what is unpriced. */
const priced = (prices: Prices, models: string[], u: Extract<Piece, { type: 'usage' }>) => {
  if (u.usd) return u;
  const price = priceOf(prices, models);
  if (!price) return { ...u, unpriced: models[0] ?? 'unknown' };
  const [read, write] = [u.cacheRead ?? 0, u.cacheWrite ?? 0];
  const usd =
    ((u.input - read - write) * price.input +
      read * (price.cached ?? price.input) +
      write * (price.cacheWrite ?? price.input) +
      u.output * price.output) /
    1e6;
  return { ...u, usd };
};

/** Makes the directories of `path` under `home`, refusing a link the sandbox may have left in their place. */
const homeDir = async (home: string, path: string) => {
  let dir = home;
  for (const part of path.split('/')) {
    dir = join(dir, part);
    await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    if (!(await lstat(dir)).isDirectory()) throw new Error(`${dir} is not a directory`);
  }
  return dir;
};

/** Links `path` under `home` to `target`, replacing what the sandbox left there. */
const linkHome = async (home: string, path: string, target: string) => {
  const at = join(await homeDir(home, dirname(path)), basename(path));
  await rm(at, { recursive: true, force: true });
  await symlink(target, at);
};

/** Writes `text` to `path` under `home` without following a link the sandbox may have left in the home. */
const writeHome = async (home: string, path: string, text: string) => {
  const dir = await homeDir(home, dirname(path));
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = constants;
  const file = await openFile(join(dir, basename(path)), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW);
  await file.writeFile(text).finally(() => file.close());
};

const stopOf = (e: SandboxError) =>
  new SessionStop({ reason: e.reason === 'infra' ? 'sandbox' : e.reason, detail: e.detail });

/**
 * The claude, opencode and pi adapters, picked by `spec.harness`. Each session gets its own home under
 * `data/homes`, reused on resume, and only its agent's key from `proxy.keys`. Usage the harness does not price is
 * priced from the `prices` file.
 */
export const harnesses = (s: {
  data: string;
  proxy: { url: string; keys: Redacted.Redacted };
  prices?: string;
}): Layer.Layer<Session, never, Sandbox> =>
  Layer.effect(
    Session,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const keys = keysOf(s.proxy.keys);
      const prices: Prices = s.prices
        ? yield* Effect.tryPromise(() => readFile(s.prices!, 'utf8').then(JSON.parse)).pipe(Effect.orDie)
        : {};

      const open = (spec: SessionSpec) =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const adapter = adapters[spec.harness];
            const key = keys[spec.agent];
            if (!key)
              return yield* new SessionStop({ reason: 'provider', detail: `no proxy key for agent ${spec.agent}` });
            const home = (!spec.fork && spec.resume?.home) || join(s.data, 'homes', randomUUID());
            yield* Effect.tryPromise({
              try: async () => {
                if (spec.fork && spec.resume)
                  await cp(spec.resume.home, home, { recursive: true, verbatimSymlinks: true });
                await mkdir(home, { recursive: true });
                for (const [path, text] of Object.entries(adapter.files?.(spec, s.proxy.url) ?? {}))
                  await writeHome(home, path, text);
                for (const [path, target] of Object.entries(adapter.links ?? {})) await linkHome(home, path, target);
              },
              catch: e => new SessionStop({ reason: 'sandbox', detail: `run home: ${(e as Error).message}` }),
            });
            const { cmd, args, env } = adapter.command(spec, s.proxy.url);
            const secret = Redacted.value(key);
            const parse = adapter.parser();
            let session: string | undefined;
            let model = alias(spec);
            let reply = '';
            let done: Extract<Piece, { type: 'done' }> | undefined;
            let tail = '';

            const step = (raw: string): SessionEvent[] => {
              const line = secret.length >= 8 ? raw.replaceAll(secret, '***') : raw;
              const exit = exitLine.exec(line);
              if (exit) {
                const ended = done?.ended ?? 'error';
                const final = reply || (ended === 'error' ? (done?.error ?? tail.trim()) : '');
                return [{ type: 'end', final, ended, exit: Number(exit[1]) }];
              }
              let json: unknown;
              try {
                json = JSON.parse(line);
              } catch {
                if (line.trim()) tail = (tail + '\n' + line).slice(-2000);
                return [];
              }
              return parse(json).flatMap((piece): SessionEvent[] => {
                if (piece.type === 'session') {
                  if (session) return [];
                  session = piece.id;
                  model = piece.model ?? model;
                  return [{ type: 'start', session: piece.id, model, home }];
                }
                if (piece.type === 'done') {
                  done = piece;
                  return [];
                }
                if (piece.type === 'text') reply += piece.text;
                if (piece.type === 'tool') reply = '';
                if (piece.type === 'usage') return [priced(prices, [model, alias(spec)], piece)];
                return [piece];
              });
            };

            return sandbox
              .lines({
                ...wrapped(cmd, args),
                dir: spec.dir,
                home,
                env,
                secrets: { [adapter.key]: key },
                network: 'proxy',
                minutes: spec.minutes,
              })
              .pipe(Stream.mapError(stopOf), Stream.mapConcat(step));
          })
        );

      return { open };
    })
  );
