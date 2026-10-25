import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Chunk, ConfigProvider, Effect, Exit, Layer, Redacted, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { type Harness, harnessSession, getModelPrice, readHarnessSettings } from '../src/harnesses.ts';
import { type Command, Sandbox, SandboxError } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import type { SessionEvent, SessionSpec } from '../src/trace.ts';
import { harnesses } from './fixtures.ts';

const sample = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8').split('\n');

const spec: SessionSpec = {
  harness: 'opencode',
  agent: 'implementor',
  model: 'smart',
  system: 'You are "the implementor".',
  prompt: 'fix the "bug" in 2 files',
  dir: '/repo/work',
  tools: ['read', 'bash(git diff*)', 'bash(git log*)'],
  minutes: 5,
};

const key = ['sk-bh', 'implementor', '0123456789abcdef'].join('-');

/** Runs one session over a sandbox that replays `lines` and then the exit code, recording the command it got. */
const data = mkdtempSync(join(tmpdir(), 'agentgraph-harness-'));

const makeHome = () => {
  const home = join(data, 'homes', randomUUID());
  mkdirSync(home, { recursive: true });
  return home;
};

const session = (
  s: SessionSpec,
  lines: string[],
  o: {
    exit?: number;
    fail?: SandboxError;
    prices?: string;
    harnesses?: Harness[];
    proxy?: { url: string; keys: Redacted.Redacted; models?: string };
    passed?: Record<string, Redacted.Redacted>;
  } = {}
) => {
  const commands: Command[] = [];
  const sandbox = Layer.succeed(Sandbox, {
    checkout: () => Effect.die('checkout'),
    exec: () => Effect.die('exec'),
    lines: command => {
      commands.push(command);
      const out = Stream.fromIterable([...lines, { code: o.exit ?? 0 }]);
      return o.fail ? Stream.concat(out.pipe(Stream.take(1)), Stream.fail(o.fail)) : out;
    },
  });
  const layer = harnessSession({
    data,
    proxy: o.proxy ?? { url: 'http://litellm:4000/v1', keys: Redacted.make(`implementor=${key}, reviewer=sk-other`) },
    ...(o.passed && { passed: o.passed }),
    ...(o.prices && { prices: o.prices }),
    harnesses: o.harnesses ?? harnesses,
  }).pipe(Layer.provide(sandbox));
  const run = Session.pipe(
    Effect.flatMap(({ open }) => Stream.runCollect(open(s))),
    Effect.map(Chunk.toArray),
    Effect.scoped,
    Effect.provide(layer)
  );
  return Effect.runPromiseExit(run).then(exit => ({ exit, data, command: commands[0]! }));
};

const events = async (s: SessionSpec, lines: string[], exit = 0) => {
  const { exit: result, command, data } = await session(s, lines, { exit });
  if (!Exit.isSuccess(result)) throw new Error(String(result.cause));
  return { events: result.value, command, data };
};

const BAD_SETTINGS = [
  ["export default { harnesses: [{ name: 'pi' }, { name: 'pi' }] };\n", 'lists the harness pi twice'],
  ['export const harnesses = [];\n', 'has no default export with a harnesses list'],
];

const LEAKY_PATHS = ['../escape', '/escape', 'a/../../escape', 'a//b', './a'];

const harnessArgs = (c: Command) => c.args.slice(c.args.indexOf('sh', 1) + 2);

describe('the session loop', () => {
  it('prices usage the harness reports at $0 from the price table, cached input at its own rate', async () => {
    const prices = join(mkdtempSync(join(tmpdir(), 'agentgraph-prices-')), 'prices.json');
    writeFileSync(
      prices,
      JSON.stringify({
        aliases: { smart: 'chatgpt/gpt-6.1-sol' },
        models: { 'gpt-6.1-sol': { input: 1.25, cached: 0.125, output: 10 } },
      })
    );
    const { exit } = await session(spec, sample('opencode-denied.jsonl'), { prices });
    const usage = Exit.isSuccess(exit) ? exit.value.filter(e => e.type === 'usage') : [];
    expect(usage[0]).toEqual({ type: 'usage', input: 3201, output: 19, usd: (3201 * 1.25 + 19 * 10) / 1e6 });
    expect(usage[1]).toEqual({
      type: 'usage',
      input: 3263,
      output: 19,
      cacheRead: 3072,
      usd: (191 * 1.25 + 3072 * 0.125 + 19 * 10) / 1e6,
    });
    const { events: unpriced } = await events(spec, sample('opencode-denied.jsonl'));
    expect(unpriced.filter(e => e.type === 'usage').every(e => e.type === 'usage' && e.usd === undefined)).toBe(true);
    expect(unpriced.filter(e => e.type === 'usage').every(e => e.type === 'usage' && e.unpriced === 'smart')).toBe(
      true
    );
  });

  it('finds a list price by alias, upstream or bare name, and none for an unknown model', () => {
    const prices = {
      aliases: { luna: 'chatgpt/gpt-6-luna' },
      models: { 'gpt-6-luna': { input: 0.1, output: 0.5 } },
    };
    for (const model of ['luna', 'litellm/luna', 'chatgpt/gpt-6-luna', 'gpt-6-luna'])
      expect(getModelPrice(prices, [model])).toEqual({ input: 0.1, output: 0.5 });
    expect(getModelPrice(prices, ['mystery'])).toBeUndefined();
    expect(getModelPrice(prices, ['mystery', 'luna'])).toEqual({ input: 0.1, output: 0.5 });
  });

  it('prices the OpenRouter bench models at their OpenRouter list prices', () => {
    const prices = JSON.parse(readFileSync(join(import.meta.dirname, '../infra/local/prices.json'), 'utf8'));
    const list = {
      'glm-flash': [0.15, 0.03, 0.5],
      'qwen-flash': [0.15, 0.016, 0.47],
      'deepseek-flash': [0.3, 0.006, 1.2],
      minimax: [0.3, 0.06, 1.2],
      'grok-build': [1, 0.2, 2],
    };
    for (const [model, [input, cached, output]] of Object.entries(list))
      expect(getModelPrice(prices, [model]), model).toMatchObject({ input, cached, output, source: 'openrouter' });
  });

  it('runs the harness with its errors in its output, with only the agent key, by name', async () => {
    const { command, data } = await events(spec, sample('opencode-run.jsonl'));
    expect(command.cmd).toBe('sh');
    expect(command.args[1]).toBe('exec "$@" 2>&1');
    expect(command.args[3]).toBe('opencode');
    expect(command.network).toBe('proxy');
    expect(command.minutes).toBe(5);
    expect(command.dir).toBe('/repo/work');
    expect(command.home?.startsWith(join(data, 'homes'))).toBe(true);
    expect(Object.keys(command.secrets ?? {})).toEqual(['AGENTGRAPH_LLM_API_KEY']);
    expect(Redacted.value(command.secrets!.AGENTGRAPH_LLM_API_KEY!)).toBe(key);
    expect(JSON.stringify([command.args, command.env])).not.toContain(key);
  });

  it('runs an agent without a key on its harness login, with the passed variables and its harness URL', async () => {
    const token = 'oauth-token-123456';
    const { command } = await session({ ...spec, agent: 'gardener', harness: 'claude' }, [], {
      proxy: { url: 'opencode=http://gateway/v1 claude=', keys: Redacted.make('') },
      passed: { CLAUDE_CODE_OAUTH_TOKEN: Redacted.make(token) },
    });
    expect(Object.keys(command.secrets ?? {})).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    expect(command.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    const keyless = await session({ ...spec, agent: 'gardener' }, [], {
      proxy: { url: 'http://gateway:4000/v1', keys: Redacted.make('') },
    });
    expect(Redacted.value(keyless.command.secrets!.AGENTGRAPH_LLM_API_KEY!)).toBe('none');
    const fallback = await session({ ...spec, agent: 'gardener' }, [`leaked ${token}`], {
      proxy: { url: 'http://gateway:4000/v1', keys: Redacted.make(`*=${key}`) },
      passed: { CLAUDE_CODE_OAUTH_TOKEN: Redacted.make(token) },
    });
    expect(Redacted.value(fallback.command.secrets!.AGENTGRAPH_LLM_API_KEY!)).toBe(key);
    expect(fallback.command.env.AGENTGRAPH_LLM_BASE_URL).toBe('http://gateway:4000/v1');
    expect(JSON.stringify(fallback.exit)).toContain('leaked ***');
    const quoted = 'quoted"token\\123';
    const escaped = await session({ ...spec, agent: 'gardener' }, [`leaked ${JSON.stringify(quoted)}`], {
      passed: { CLAUDE_CODE_OAUTH_TOKEN: Redacted.make(quoted) },
    });
    expect(JSON.stringify(escaped.exit)).not.toContain('token');
    const pem = 'BEGIN KEY BLOCK\nsecret-line-material\nEND KEY BLOCK';
    const lines = await session({ ...spec, agent: 'gardener' }, ['oops secret-line-material'], {
      passed: { APP_PEM: Redacted.make(pem) },
    });
    expect(JSON.stringify(lines.exit)).not.toContain('secret-line');
  });

  it('stops before the harness starts when the config has no harness by that name', async () => {
    const { exit, command } = await session({ ...spec, harness: 'goose' }, []);
    expect(command).toBeUndefined();
    expect(String(exit)).toContain('no harness goose in the config');
  });

  it.each(BAD_SETTINGS)('refuses harness settings %s as a hub problem', async (text, message) => {
    const file = join(mkdtempSync(join(tmpdir(), 'agentgraph-config-')), 'config.mjs');
    writeFileSync(file, text);
    const provider = ConfigProvider.fromMap(new Map([['AGENTGRAPH_CONFIG', file]]));
    const error = await Effect.runPromise(Effect.flip(readHarnessSettings.pipe(Effect.withConfigProvider(provider))));
    expect(error.problems).toEqual([{ path: file, message }]);
  });

  it('masks the key wherever the harness prints it', async () => {
    const line = JSON.stringify({ type: 'text', sessionID: 's1', part: { type: 'text', text: `env has ${key}` } });
    const { events: got } = await events(spec, [line]);
    expect(got).toContainEqual({ type: 'text', text: 'env has ***' });
  });

  it('ends with the harness error and exit code when the harness dies without a result', async () => {
    const { events: got } = await events(spec, ['Error: cannot find module', 'at x.js:1'], 1);
    expect(got).toEqual([{ type: 'end', final: 'Error: cannot find module\nat x.js:1', ended: 'error', exit: 1 }]);
  });

  it('turns a sandbox timeout into a session stop', async () => {
    const fail = new SandboxError({ reason: 'timeout', detail: 'no exit after 5 minutes' });
    const { exit } = await session(spec, sample('opencode-run.jsonl'), { fail });
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('"reason":"timeout"');
  });

  it.each(LEAKY_PATHS)('refuses the home path %s, which leaves the run home', async path => {
    const leaky = { ...harnesses[0]!, name: 'leaky', home: () => ({ files: { [path]: 'x' } }) };
    const { exit, command } = await session({ ...spec, harness: 'leaky' }, [], { harnesses: [leaky] });
    expect(command).toBeUndefined();
    expect(JSON.stringify(exit)).toContain('is not a path inside the home');
  });

  it('resumes or forks only a session home of its own', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'agentgraph-outside-'));
    const linked = join(dirname(makeHome()), 'linked');
    symlinkSync(outside, linked);
    const runs = await Promise.all([
      session({ ...spec, resume: { id: 's', home: outside } }, []),
      session({ ...spec, resume: { id: 's', home: linked } }, []),
      session({ ...spec, resume: { id: 's', home: outside }, fork: true }, []),
    ]);
    expect(runs.every(r => !r.command && JSON.stringify(r.exit).includes('is not a session home'))).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('resumes in the session home it was given', async () => {
    const home = makeHome();
    const { command, events: got } = await events(
      { ...spec, resume: { id: 'ses_1', home } },
      sample('opencode-run.jsonl')
    );
    expect(command.home).toBe(home);
    expect(harnessArgs(command)).toContain('--session');
    expect(got[0]).toMatchObject({ type: 'start', home });
  });

  it.each([
    ['opencode', ['--session', 'ses_1', '--fork']],
    ['claude', ['--resume', 'ses_1', '--fork-session']],
    ['pi', ['--fork', 'ses_1']],
  ] as const)('forks a %s session in a copy of its home', async (harness, flags) => {
    const home = makeHome();
    writeFileSync(join(home, 'history'), 'kept');
    const { command } = await events({ ...spec, harness, resume: { id: 'ses_1', home }, fork: true }, []);
    const args = harnessArgs(command);
    expect(args.slice(args.indexOf(flags[0]), args.indexOf(flags[0]) + flags.length)).toEqual(flags);
    if (harness === 'pi') expect(args).not.toContain('--session');
    expect(command.home).not.toBe(home);
    expect(readFileSync(join(command.home!, 'history'), 'utf8')).toBe('kept');
  });
});

describe('thinking', () => {
  it('records what each harness reports as thinking apart from the reply', async () => {
    const lines = {
      opencode: { type: 'text', part: { type: 'reasoning', text: 'the test names add' } },
      claude: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'the test names add' }] } },
      pi: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'the test names add' }] },
      },
    };
    for (const [harness, line] of Object.entries(lines)) {
      const { events: got } = await events({ ...spec, harness: harness as SessionSpec['harness'] }, [
        JSON.stringify(line),
      ]);
      expect(got).toEqual([
        { type: 'thinking', text: 'the test names add' },
        expect.objectContaining({ type: 'end', final: '' }),
      ]);
    }
  });
});

describe('opencode', () => {
  it('passes the prompt as space-free words after -- and denies every tool outside the allowlist', async () => {
    const { command } = await events(spec, []);
    const args = harnessArgs(command);
    const split = args.indexOf('--');
    expect(args.slice(0, split)).toEqual([
      'run',
      '--format',
      'json',
      '--title',
      'agentgraph',
      '--agent',
      'agentgraph',
      '--model',
      'agentgraph/smart',
    ]);
    expect(args.slice(split + 1)).toEqual(['fix', 'the', '"bug"', 'in\t2', 'files']);
    expect(JSON.parse(command.env.OPENCODE_PERMISSION!)).toEqual({
      '*': 'deny',
      read: 'allow',
      bash: {
        '*': 'deny',
        'git diff*': 'allow',
        'NODE_OPTIONS= command git diff*': 'allow',
        'git log*': 'allow',
        'NODE_OPTIONS= command git log*': 'allow',
      },
    });
    const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.agent.agentgraph.prompt).toBe(spec.system);
    expect(config.provider.agentgraph.options.apiKey).toBe('{env:AGENTGRAPH_LLM_API_KEY}');
    expect(command.env.AGENTGRAPH_LLM_BASE_URL).toBe('http://litellm:4000/v1');
    expect(command.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
  });

  it('lets every harness read the directories the spec names outside the checkout', async () => {
    const read = ['/data/news/ab'];
    const { command: open } = await events({ ...spec, read }, []);
    expect(JSON.parse(open.env.OPENCODE_PERMISSION!).external_directory).toEqual({
      '*': 'deny',
      '/data/news/ab/*': 'allow',
    });
    const { command: claude } = await events({ ...spec, harness: 'claude', read }, []);
    expect(harnessArgs(claude).join(' ')).toContain('--add-dir /data/news/ab --model');
  });

  it('allows reading the news file the prompt names', async () => {
    const prompt = 'People may comment while you work: /data/news/ab/news.md holds what is new.';
    const file = /(\S+) holds what is new/.exec(prompt)![1]!;
    const { command } = await events({ ...spec, prompt, read: ['/data/news/ab'] }, []);
    const rules = JSON.parse(command.env.OPENCODE_PERMISSION!);
    const allowed = Object.entries(rules.external_directory as Record<string, string>).filter(
      ([glob, action]) => action === 'allow' && file.startsWith(glob.slice(0, -1))
    );
    expect(allowed).toHaveLength(1);
    expect(rules.read).toBe('allow');
  });

  it('reads a recorded run', async () => {
    const { events: got, command } = await events(spec, sample('opencode-run.jsonl'));
    expect(got).toEqual<SessionEvent[]>([
      { type: 'start', session: 'ses_ecfe5c55cffe3r1vZYoqdYrwvF', model: 'smart', home: command.home! },
      { type: 'text', text: 'Listing files.' },
      expect.objectContaining({
        type: 'tool',
        id: 'call_mock1',
        name: 'read',
        ok: true,
        input: { path: 'a.txt', filePath: 'a.txt' },
        ms: 61,
      }),
      { type: 'usage', input: 1200, output: 20, unpriced: 'smart' },
      { type: 'text', text: 'done' },
      { type: 'usage', input: 1300, output: 5, unpriced: 'smart' },
      { type: 'end', final: 'done', ended: 'stop', exit: 0 },
    ]);
  });

  it('records denied calls and bash exit codes from the tool state of a recorded run', async () => {
    const { events: got } = await events(
      { ...spec, tools: ['read', 'bash(git status*)'] },
      sample('opencode-denied.jsonl')
    );
    const tools = got.filter(e => e.type === 'tool');
    expect(tools.map(t => [t.name, t.ok, t.exit, t.denied])).toEqual([
      ['bash', true, 128, undefined],
      ['bash', false, undefined, true],
      ['read', false, undefined, true],
    ]);
    expect(got.at(-1)).toMatchObject({ type: 'end', ended: 'stop', exit: 0 });
  });

  it('reads a step that ran out of output tokens as the cap', async () => {
    const line = JSON.stringify({
      type: 'step_finish',
      sessionID: 's1',
      part: { type: 'step-finish', reason: 'length' },
    });
    const { events: got } = await events(spec, [line]);
    expect(got.at(-1)).toEqual({ type: 'end', final: '', ended: 'cap', exit: 0 });
  });

  it('reads a provider error as an ended error with its message', async () => {
    const { events: got } = await events(spec, sample('opencode-error.jsonl'), 1);
    expect(got).toEqual([
      expect.objectContaining({ type: 'start', session: 'ses_ecfe7136cffeEuaHWIMDVZSpLB' }),
      {
        type: 'end',
        final: 'Cannot connect to API: Unable to connect. Is the computer able to access the url?',
        ended: 'error',
        exit: 1,
      },
    ]);
  });
});

describe('claude', () => {
  const claude = { ...spec, harness: 'claude' as const };

  it('talks to the proxy with the agent key and keeps its config in the run home', async () => {
    const { command } = await events({ ...claude, resume: { id: 'e477', home: makeHome() } }, []);
    const args = harnessArgs(command);
    expect(args).toEqual(
      expect.arrayContaining(['--permission-mode', 'dontAsk', '--resume', 'e477', '--model', 'smart'])
    );
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Bash');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'Read,Bash(git diff*),Bash(NODE_OPTIONS= command git diff*),Bash(git log*),Bash(NODE_OPTIONS= command git log*)'
    );
    expect(args).not.toContain('--no-session-persistence');
    expect(command.env.ANTHROPIC_BASE_URL).toBe('http://litellm:4000');
    expect(command.env).not.toHaveProperty('HOME');
    expect(command.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(Object.keys(command.secrets ?? {})).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });

  it('reads a recorded run', async () => {
    const { events: got } = await events(claude, sample('claude-run.jsonl'));
    const final = '`add.js` is buggy: `add` returns `a - b` instead of `a + b`.';
    expect(got).toEqual([
      expect.objectContaining({
        type: 'start',
        session: 'e47727a3-ac6e-4f15-8327-b47a312c26d1',
        model: 'claude-haiku-5-5',
      }),
      expect.objectContaining({
        type: 'tool',
        id: 'toolu_01',
        name: 'Read',
        ok: true,
        input: { file_path: '/tmp/x/add.js' },
      }),
      { type: 'text', text: final },
      {
        type: 'usage',
        input: 4 + 8401 + 2340,
        output: 177,
        cacheRead: 8401,
        cacheWrite: 2340,
        unpriced: 'claude-haiku-5-5',
      },
      { type: 'end', final, ended: 'stop', exit: 0 },
    ]);
  });

  it('reports permission denials and the turn cap from the result line', async () => {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_02', tool_input: { command: 'rm -rf /' } }],
      modelUsage: {},
    });
    const { events: got } = await events(claude, [result], 1);
    expect(got).toEqual([
      { type: 'tool', id: 'toolu_02', name: 'Bash', input: { command: 'rm -rf /' }, ok: false, denied: true },
      { type: 'end', final: '', ended: 'cap', exit: 1 },
    ]);
  });
});

describe('pi', () => {
  const pi = { ...spec, harness: 'pi' as const };

  it('sets up the proxy in the run home and grants the plain tools', async () => {
    const { command } = await events({ ...pi, tools: ['read'] }, []);
    const args = harnessArgs(command);
    expect(args).toEqual(
      expect.arrayContaining(['--tools', 'read', '--model', 'agentgraph/smart', '--no-context-files'])
    );
    expect(args).not.toContain('--no-session');
    const models = JSON.parse(readFileSync(join(command.home!, '.pi/agent/models.json'), 'utf8'));
    expect(models.providers.agentgraph).toMatchObject({
      baseUrl: 'http://litellm:4000/v1',
      apiKey: '$AGENTGRAPH_LLM_API_KEY',
    });
    expect(readFileSync(join(command.home!, '.pi/agent/models.json'), 'utf8')).not.toContain(key);
    expect(existsSync(join(command.home!, '.pi/agent/settings.json'))).toBe(true);
  });

  it('links the opencode plugin install into the home, replacing a copy a resumed home holds', async () => {
    const { command } = await events(spec, []);
    const config = join(command.home!, '.config/opencode');
    expect(readlinkSync(join(config, 'node_modules'))).toBe('/opt/opencode/node_modules');
    expect(readlinkSync(join(config, 'package-lock.json'))).toBe('/opt/opencode/package-lock.json');
    rmSync(join(config, 'node_modules'));
    mkdirSync(join(config, 'node_modules'));
    writeFileSync(join(config, 'node_modules', 'copy'), 'x');
    await session({ ...spec, resume: { id: 's', home: command.home! } }, []);
    expect(readlinkSync(join(config, 'node_modules'))).toBe('/opt/opencode/node_modules');
  });

  it('never writes through a link the agent left in a resumed home', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'agentgraph-outside-'));
    writeFileSync(join(outside, 'victim'), 'keep');
    const linked = makeHome();
    mkdirSync(join(linked, '.pi', 'agent'), { recursive: true });
    symlinkSync(join(outside, 'victim'), join(linked, '.pi', 'agent', 'models.json'));
    const dir = makeHome();
    symlinkSync(outside, join(dir, '.pi'));
    for (const home of [linked, dir]) {
      const { exit } = await session({ ...pi, resume: { id: 's', home } }, []);
      expect(JSON.stringify(exit)).toContain('run home');
    }
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('keep');
    expect(existsSync(join(outside, 'agent'))).toBe(false);
  });

  it('reads a recorded run', async () => {
    const { events: got } = await events(pi, sample('pi-run.jsonl'));
    expect(got).toEqual([
      expect.objectContaining({ type: 'start', session: '01a1301a-3f7c-754a-a9a2-2b8e888e778a', model: 'smart' }),
      { type: 'text', text: 'Listing files.' },
      { type: 'usage', input: 1200, output: 20, unpriced: 'smart' },
      {
        type: 'tool',
        id: 'call_mock1',
        name: 'read',
        input: { path: 'a.txt', filePath: 'a.txt' },
        ok: true,
        output: 'hi\n',
      },
      { type: 'text', text: 'done' },
      { type: 'usage', input: 1300, output: 5, unpriced: 'smart' },
      { type: 'end', final: 'done', ended: 'stop', exit: 0 },
    ]);
  });

  it('records cache reads and writes', async () => {
    const usage = { input: 10, output: 2, cacheRead: 300, cacheWrite: 40 };
    const line = JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], usage } });
    const { events: got } = await events(pi, [line]);
    expect(got[0]).toEqual({ type: 'usage', input: 350, output: 2, cacheRead: 300, cacheWrite: 40, unpriced: 'smart' });
  });
});

describe('codex', () => {
  const codex = { ...spec, harness: 'codex' as const };

  it('runs on its own login in the shared volume, one session at a time, with the model the alias names', async () => {
    const proxy = { url: 'codex=', keys: Redacted.make(''), models: '*=gpt-x,smart=gpt-y' };
    const { exit, command } = await session(codex, [], { proxy });
    expect(Exit.isSuccess(exit)).toBe(true);
    const args = harnessArgs(command);
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-y');
    expect(args).not.toContain('-c');
    expect(args.at(-1)).toBe(`${spec.system}\n\n${spec.prompt}`);
    expect(command.volumes).toEqual({ '/codex': 'agentgraph-codex' });
    expect(command.env.CODEX_HOME).toBe('/codex');
    expect(command.secrets).toEqual({});
    const { model: _, ...bare } = codex;
    const { command: unnamed } = await session({ ...bare, resume: { id: 't1', home: makeHome() } }, [], { proxy });
    expect(harnessArgs(unnamed).slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    expect(harnessArgs(unnamed)[harnessArgs(unnamed).indexOf('--model') + 1]).toBe('gpt-x');
  });

  it('talks to a proxy through its own model provider with the agent key', async () => {
    const { command } = await events(codex, []);
    const args = harnessArgs(command);
    expect(args).toContain('model_providers.agentgraph.base_url="http://litellm:4000/v1"');
    expect(Object.keys(command.secrets ?? {})).toEqual(['AGENTGRAPH_LLM_API_KEY']);
  });

  it('reads a run', async () => {
    const lines = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'look first' } },
      {
        type: 'item.completed',
        item: {
          id: 'c',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'a.ts',
          exit_code: 0,
          status: 'completed',
        },
      },
      { type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: 'a.ts' }], status: 'failed' } },
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5 } },
    ].map(line => JSON.stringify(line));
    const { events: got } = await events(codex, lines);
    expect(got.map(e => e.type)).toEqual(['start', 'thinking', 'tool', 'tool', 'text', 'usage', 'end']);
    expect(got[2]).toMatchObject({ name: 'bash', input: 'ls', ok: true, output: 'a.ts' });
    expect(got[3]).toMatchObject({ name: 'edit', ok: false });
    expect(got[5]).toMatchObject({ input: 100, output: 5, cacheRead: 60 });
    expect(got.at(-1)).toEqual({ type: 'end', final: 'done', ended: 'stop', exit: 0 });
  });

  it("ends with the failed turn's error", async () => {
    const lines = [
      JSON.stringify({ type: 'error', message: 'stream lost' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }),
    ];
    const { events: got } = await events(codex, lines, 1);
    expect(got.at(-1)).toEqual({ type: 'end', final: 'usage limit reached', ended: 'error', exit: 1 });
  });
});
