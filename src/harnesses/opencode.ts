import { fileURLToPath } from 'node:url';
import { opencodeMcpConfig } from '../mcp-config.ts';
import type { AgentEvent, HarnessAdapter, RunSpec } from '../types.ts';
import { sources } from '../usage.ts';

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
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
      cost?: number;
    }
  | { type: string };

type Line =
  | { type: 'text' | 'tool_use' | 'step_finish'; part: Part }
  | { type: 'error'; error?: { name?: string; data?: { message?: string } } }
  | { type: 'bothub'; event?: unknown }
  | { type: string };

/** The only provider: the model proxy, where bot models are aliases, spoken to over its Responses API. */
const provider = 'bothub';
const alias = (spec: RunSpec) => spec.model ?? 'default';

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

const plugin = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** bothub's own opencode plugins for the run: the surfacer and the decider, each only when configured. */
const plugins = (spec: RunSpec) => [
  ...(spec.surfacer ? [[plugin('./opencode-surfacer.ts'), spec.surfacer]] : []),
  ...(spec.decider?.questions.length ? [[plugin('./opencode-decider.ts'), spec.decider]] : []),
];

const pluginIds = (spec: RunSpec) => [
  ...(spec.surfacer ? ['bothub-surfacer'] : []),
  ...(spec.decider?.questions.length ? ['bothub-decider'] : []),
];

/** Harness memory is off: no sharing, no snapshots, no compaction or pruning; bothub's surfacer is the memory. */
const config = (spec: RunSpec) => ({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  share: 'disabled',
  snapshot: false,
  compaction: { auto: false, prune: false },
  enabled_providers: [provider],
  provider: {
    [provider]: {
      npm: '@ai-sdk/openai',
      name: provider,
      options: { baseURL: '{env:BOTHUB_LLM_BASE_URL}', apiKey: '{env:BOTHUB_LLM_API_KEY}' },
      models: { [alias(spec)]: {} },
    },
  },
  agent: { [provider]: { mode: 'primary', prompt: spec.system, ...(spec.maxTurns && { steps: spec.maxTurns }) } },
  ...(spec.mcp && opencodeMcpConfig(spec.mcp)),
  ...(plugins(spec).length && { plugin: plugins(spec) }),
});

const numeric = /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+)$/i;

/** Space-free words; a number is glued to the word before it with a tab, because the CLI would read it as a number. */
const words = (prompt: string) =>
  prompt.split(' ').reduce<string[]>((out, word) => {
    if (!numeric.test(word)) return [...out, word];
    const last = out.pop();
    return [...out, last === undefined ? `${word}\t` : `${last}\t${word}`];
  }, []);

/**
 * The prompt goes in space-free words after `--` so the CLI neither parses nor re-quotes it. `--pure` keeps every
 * external plugin out unless bothub's own are configured.
 */
const command = (spec: RunSpec) => ({
  cmd: 'opencode',
  args: [
    'run',
    '--format',
    'json',
    ...(plugins(spec).length ? [] : ['--pure']),
    '--title',
    provider,
    '--agent',
    provider,
    '--model',
    `${provider}/${alias(spec)}`,
    ...(spec.session ? ['--session', spec.session.id] : []),
    '--',
    ...words(spec.prompt),
  ],
  env: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config(spec)),
    OPENCODE_PERMISSION: JSON.stringify(permission([...spec.tools, ...(spec.surfacer?.history ? ['history'] : [])])),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1',
    OPENCODE_DISABLE_PRUNE: '1',
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
          ...(t.cache?.read && { cachedInputTokens: t.cache.read }),
          ...(t.reasoning && { reasoningTokens: t.reasoning }),
          ...(part.cost && { costUsd: part.cost }),
        },
      ]
    : [];
  if (part.reason === 'tool-calls') return usage;
  return [...usage, { type: 'end', ok: part.reason === 'stop' }];
};

/**
 * Whether a plugin may print `e` to opencode's stdout as a `{"type":"bothub","event":…}` line: a `recall`, or the
 * `usage` of a model call bothub's own code made.
 */
const fromPlugin = (e: AgentEvent | null | undefined): e is AgentEvent =>
  typeof e === 'object' &&
  e !== null &&
  (e.type === 'recall' || (e.type === 'usage' && sources.includes(e.source!) && e.source !== 'harness'));

const event = (line: Line): AgentEvent[] => {
  if (line.type === 'bothub' && 'event' in line) {
    const e = line.event as AgentEvent | null | undefined;
    return fromPlugin(e) ? [e] : [];
  }
  if (line.type === 'error' && 'error' in line)
    return [{ type: 'error', message: line.error?.data?.message ?? line.error?.name ?? 'opencode error' }];
  if (!('part' in line)) return [];
  const { part } = line;
  if (part.type === 'text' && 'text' in part) return part.text ? [{ type: 'text', text: part.text }] : [];
  if (part.type === 'tool' && 'state' in part) return tool(part);
  if (part.type === 'step-finish' && 'reason' in part) return step(part);
  return [];
};

const sessionIn = (raw: string) => {
  try {
    const { sessionID } = JSON.parse(raw) as { sessionID?: unknown };
    return typeof sessionID === 'string' ? sessionID : undefined;
  } catch {
    return undefined;
  }
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
 * tool allowlist and project config is ignored. Its output names no model, so it reports the alias it was given.
 */
export const opencode: HarnessAdapter = {
  name: 'opencode',
  command,
  parseLine,
  start: (spec, line) => {
    const session = sessionIn(line);
    return [{ type: 'start', model: alias(spec), ...(session && { session }) }];
  },
  plugins: pluginIds,
  sessions: '.local/share/opencode',
};
