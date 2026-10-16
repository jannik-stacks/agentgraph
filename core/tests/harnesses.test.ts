import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chunk, Effect, Exit, Layer, Redacted, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { harnesses } from '../src/harnesses.ts';
import { type Command, Sandbox, SandboxError } from '../src/sandbox.ts';
import { type SessionEvent, Session, type SessionSpec } from '../src/session.ts';

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

const key = 'sk-bh-implementor-0123456789abcdef';

/** Runs one session over a sandbox that replays `lines` and then the exit line, recording the command it got. */
const session = (s: SessionSpec, lines: string[], exit = 0, fail?: SandboxError, prices?: string) => {
  const data = mkdtempSync(join(tmpdir(), 'core-harness-'));
  const commands: Command[] = [];
  const sandbox = Layer.succeed(Sandbox, {
    checkout: () => Effect.die('checkout'),
    exec: () => Effect.die('exec'),
    lines: command => {
      commands.push(command);
      const out = Stream.fromIterable([...lines, '', `bothub-exit ${exit}`]);
      return fail ? Stream.concat(out.pipe(Stream.take(1)), Stream.fail(fail)) : out;
    },
  });
  const layer = harnesses({
    data,
    proxy: { url: 'http://litellm:4000/v1', keys: Redacted.make(`implementor=${key}, reviewer=sk-other`) },
    ...(prices && { prices }),
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
  const { exit: result, command, data } = await session(s, lines, exit);
  if (!Exit.isSuccess(result)) throw new Error(String(result.cause));
  return { events: result.value, command, data };
};

const harnessArgs = (c: Command) => c.args.slice(c.args.indexOf('sh', 1) + 2);

describe('the session loop', () => {
  it('prices usage the harness reports at $0 from the price table, cached input at its own rate', async () => {
    const prices = join(mkdtempSync(join(tmpdir(), 'core-prices-')), 'prices.json');
    writeFileSync(
      prices,
      JSON.stringify({
        aliases: { smart: 'chatgpt/gpt-6.1-sol' },
        models: { 'gpt-6.1-sol': { input: 1.25, cached: 0.125, output: 10 } },
      })
    );
    const { exit } = await session(spec, sample('opencode-denied.jsonl'), 0, undefined, prices);
    const usage = Exit.isSuccess(exit) ? exit.value.filter(e => e.type === 'usage') : [];
    expect(usage[0]).toEqual({ type: 'usage', input: 3201, output: 19, usd: (3201 * 1.25 + 19 * 10) / 1e6 });
    expect(usage[1]).toEqual({
      type: 'usage',
      input: 3263,
      output: 19,
      usd: (191 * 1.25 + 3072 * 0.125 + 19 * 10) / 1e6,
    });
    const { events: unpriced } = await events(spec, sample('opencode-denied.jsonl'));
    expect(unpriced.filter(e => e.type === 'usage').every(e => e.type === 'usage' && e.usd === undefined)).toBe(true);
  });

  it('runs the harness in a shell that reports its exit code, with only the agent key, by name', async () => {
    const { command, data } = await events(spec, sample('opencode-run.jsonl'));
    expect(command.cmd).toBe('sh');
    expect(command.args[1]).toContain('bothub-exit');
    expect(command.args[3]).toBe('opencode');
    expect(command.network).toBe('proxy');
    expect(command.minutes).toBe(5);
    expect(command.dir).toBe('/repo/work');
    expect(command.home?.startsWith(join(data, 'homes'))).toBe(true);
    expect(Object.keys(command.secrets ?? {})).toEqual(['BOTHUB_LLM_API_KEY']);
    expect(Redacted.value(command.secrets!.BOTHUB_LLM_API_KEY!)).toBe(key);
    expect(JSON.stringify([command.args, command.env])).not.toContain(key);
  });

  it('stops before the harness starts when the agent has no key', async () => {
    const { exit, command } = await session({ ...spec, agent: 'gardener' }, []);
    expect(command).toBeUndefined();
    expect(String(exit)).toContain('no proxy key for agent gardener');
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
    const { exit } = await session(spec, sample('opencode-run.jsonl'), 0, fail);
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('"reason":"timeout"');
  });

  it('resumes in the session home it was given', async () => {
    const home = mkdtempSync(join(tmpdir(), 'core-home-'));
    const { command, events: got } = await events(
      { ...spec, resume: { id: 'ses_1', home } },
      sample('opencode-run.jsonl')
    );
    expect(command.home).toBe(home);
    expect(harnessArgs(command)).toContain('--session');
    expect(got[0]).toMatchObject({ type: 'start', home });
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
      'bothub',
      '--agent',
      'bothub',
      '--model',
      'bothub/smart',
    ]);
    expect(args.slice(split + 1)).toEqual(['fix', 'the', '"bug"', 'in\t2', 'files']);
    expect(JSON.parse(command.env.OPENCODE_PERMISSION!)).toEqual({
      '*': 'deny',
      read: 'allow',
      bash: { '*': 'deny', 'git diff*': 'allow', 'git log*': 'allow' },
    });
    const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.agent.bothub.prompt).toBe(spec.system);
    expect(config.provider.bothub.options.apiKey).toBe('{env:BOTHUB_LLM_API_KEY}');
    expect(command.env.BOTHUB_LLM_BASE_URL).toBe('http://litellm:4000/v1');
    expect(command.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
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
      }),
      { type: 'usage', input: 1200, output: 20 },
      { type: 'text', text: 'done' },
      { type: 'usage', input: 1300, output: 5 },
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
    const { command } = await events(
      { ...claude, resume: { id: 'e477', home: mkdtempSync(join(tmpdir(), 'h-')) } },
      []
    );
    const args = harnessArgs(command);
    expect(args).toEqual(
      expect.arrayContaining(['--permission-mode', 'dontAsk', '--resume', 'e477', '--model', 'smart'])
    );
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Bash');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Bash(git diff*),Bash(git log*)');
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
      { type: 'usage', input: 4 + 8401 + 2340, output: 177 },
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

  it('sets up the proxy in the run home and grants only tools without a pattern', async () => {
    const { command } = await events(pi, []);
    const args = harnessArgs(command);
    expect(args).toEqual(expect.arrayContaining(['--tools', 'read', '--model', 'bothub/smart', '--no-context-files']));
    expect(args).not.toContain('--no-session');
    const models = JSON.parse(readFileSync(join(command.home!, '.pi/agent/models.json'), 'utf8'));
    expect(models.providers.bothub).toMatchObject({ baseUrl: 'http://litellm:4000/v1', apiKey: '$BOTHUB_LLM_API_KEY' });
    expect(readFileSync(join(command.home!, '.pi/agent/models.json'), 'utf8')).not.toContain(key);
    expect(existsSync(join(command.home!, '.pi/agent/settings.json'))).toBe(true);
  });

  it('never writes through a link the agent left in a resumed home', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'core-outside-'));
    writeFileSync(join(outside, 'victim'), 'keep');
    const linked = mkdtempSync(join(tmpdir(), 'core-home-'));
    mkdirSync(join(linked, '.pi', 'agent'), { recursive: true });
    symlinkSync(join(outside, 'victim'), join(linked, '.pi', 'agent', 'models.json'));
    const dir = mkdtempSync(join(tmpdir(), 'core-home-'));
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
      { type: 'usage', input: 1200, output: 20 },
      {
        type: 'tool',
        id: 'call_mock1',
        name: 'read',
        input: { path: 'a.txt', filePath: 'a.txt' },
        ok: true,
        output: 'hi\n',
      },
      { type: 'text', text: 'done' },
      { type: 'usage', input: 1300, output: 5 },
      { type: 'end', final: 'done', ended: 'stop', exit: 0 },
    ]);
  });
});
