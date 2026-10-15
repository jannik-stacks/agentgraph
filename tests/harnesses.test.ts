import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Chunk, Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { harnesses } from '../src/harnesses/index.ts';
import { loadPrices } from '../src/prices.ts';
import { agentEvents, unsandboxed } from '../src/runner.ts';
import type { AgentEvent, RunSpec } from '../src/types.ts';

const spec: RunSpec = {
  prompt: '--fix the "bug"  now\nplease --auto',
  system: 'You are "the reviewer".\nBe brief.',
  cwd: '/tmp/x',
  model: 'coder',
  tools: ['read', 'bash(git diff*)', 'bash(git log*)'],
};

const fixture = (harness: keyof typeof harnesses, name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .flatMap(line => harnesses[harness].parseLine(line));

const types = (events: AgentEvent[]) => events.map(e => e.type);

describe('opencode', () => {
  const { command, parseLine } = harnesses.opencode;

  it('builds a one-shot run whose prompt survives as words after --', () => {
    const { cmd, args } = command(spec);
    expect(cmd).toBe('opencode');
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
      'bothub/coder',
    ]);
    expect(args.slice(split + 1).join(' ')).toBe(spec.prompt);
    expect(args.slice(split + 1).some(word => word.includes(' '))).toBe(false);
    expect(args.slice(0, split).join(' ')).not.toMatch(/--auto|--yolo|dangerously/);
  });

  it('glues numbers to the word before them so the CLI keeps every word a string', () => {
    const { args } = command({ ...spec, prompt: '3 tries, attempt 2 of 0x10 then -1.5e3 done' });
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      '3\t',
      'tries,',
      'attempt\t2',
      'of\t0x10',
      'then\t-1.5e3',
      'done',
    ]);
  });

  it('adds the bothub MCP server to the inline config', () => {
    const mcp = { command: 'node', args: ['bothub.mjs', 'mcp'], env: {} };
    const config = JSON.parse(command({ ...spec, mcp }).env.OPENCODE_CONFIG_CONTENT ?? '');
    expect(config.mcp).toEqual({
      bothub: { type: 'local', command: ['node', 'bothub.mjs', 'mcp'], environment: {}, enabled: true },
    });
    expect(JSON.parse(command(spec).env.OPENCODE_CONFIG_CONTENT ?? '{}').mcp).toBeUndefined();
  });

  it('names the repo instructions and skills by absolute path while project config stays off', () => {
    const repo = { instructions: ['AGENTS.md'], skills: ['.agents/skills/lint'], shadowed: [] };
    const { env } = command({ ...spec, cwd: '/work', repo });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '');
    expect(config.instructions).toEqual(['/work/AGENTS.md']);
    expect(config.skills).toEqual({ paths: ['/work/.agents/skills/lint'] });
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    const bare = JSON.parse(
      command({ ...spec, repo: { instructions: [], skills: [], shadowed: [] } }).env.OPENCODE_CONFIG_CONTENT ?? ''
    );
    expect(bare).not.toHaveProperty('instructions');
    expect(bare).not.toHaveProperty('skills');
  });

  it('passes the proxy, agent and allowlist inline and ignores project config', () => {
    const { env } = command(spec);
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '')).toEqual({
      '*': 'deny',
      read: 'allow',
      bash: { '*': 'deny', 'git diff*': 'allow', 'git log*': 'allow' },
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '');
    expect(config.enabled_providers).toEqual(['bothub']);
    expect(config.provider.bothub.options).toEqual({
      baseURL: '{env:BOTHUB_LLM_BASE_URL}',
      apiKey: '{env:BOTHUB_LLM_API_KEY}',
      headerTimeout: 120_000,
      chunkTimeout: 180_000,
    });
    expect(config.provider.bothub.npm).toBe('@ai-sdk/openai');
    expect(config.provider.bothub.models).toEqual({ coder: {} });
    expect(config.agent.bothub).toEqual({ mode: 'primary', prompt: spec.system });
    expect(env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' });
    expect(JSON.stringify(env)).not.toMatch(/sk-|vk-/);
  });

  it('turns off every memory feature opencode has', () => {
    const { args, env } = command(spec);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '');
    expect(config).toMatchObject({ share: 'disabled', snapshot: false, compaction: { auto: false, prune: false } });
    expect(config.tool_output).toEqual({ max_lines: 300, max_bytes: 16_384 });
    expect(config.instructions).toBeUndefined();
    expect(config.plugin).toEqual([
      expect.stringMatching(/\/src\/harnesses\/opencode-trim\.ts$/),
      [expect.stringMatching(/\/src\/harnesses\/opencode-model\.ts$/), { alias: 'coder' }],
    ]);
    const toolless = command({ ...spec, tools: ['bash(ls*)'] });
    expect(JSON.parse(toolless.env.OPENCODE_CONFIG_CONTENT ?? '').plugin).toHaveLength(1);
    expect(toolless.args).not.toContain('--pure');
    expect(env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOCOMPACT: '1',
      OPENCODE_DISABLE_PRUNE: '1',
    });
    expect(args.slice(0, args.indexOf('--'))).not.toEqual(
      expect.arrayContaining(['--continue', '--session', '--share'])
    );
  });

  it("loads bothub's own plugins, and allows history only when the surfacer offers it", () => {
    const surfacer = { run: 'r1', bot: 'implementor', data: '/data', hub: '/hub' };
    const decider = {
      questions: [{ on: 'tool_call' as const, ask: 'In scope?', mode: 'log' as const }],
      task: 'Fix it',
    };
    const { args, env } = command({ ...spec, surfacer, decider });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '');
    expect(config.plugin).toEqual([
      [expect.stringMatching(/\/src\/harnesses\/opencode-surfacer\.ts$/), surfacer],
      [expect.stringMatching(/\/src\/harnesses\/opencode-decider\.ts$/), decider],
      expect.stringMatching(/\/src\/harnesses\/opencode-trim\.ts$/),
      [expect.stringMatching(/\/src\/harnesses\/opencode-model\.ts$/), { alias: 'coder' }],
    ]);
    expect(config.plugin.every((p: string | [string]) => existsSync([p].flat()[0]!))).toBe(true);
    expect(config).toMatchObject({ share: 'disabled', compaction: { auto: false } });
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '').history).toBeUndefined();
    const withHistory = command({
      ...spec,
      surfacer: { ...surfacer, history: true },
      decider: { questions: [], task: '' },
    });
    expect(JSON.parse(withHistory.env.OPENCODE_PERMISSION ?? '').history).toBe('allow');
    expect(JSON.parse(withHistory.env.OPENCODE_CONFIG_CONTENT ?? '').plugin).toHaveLength(3);
  });

  it('recalls on a new session only, never again on a resumed one', () => {
    const surfacer = { run: 'r1', bot: 'implementor', data: '/data', hub: '/hub', recall: { query: 'Fix fees' } };
    const options = (session?: { id: string; home: string }) =>
      JSON.parse(command({ ...spec, surfacer, ...(session && { session }) }).env.OPENCODE_CONFIG_CONTENT ?? '')
        .plugin[0][1];
    expect(options().recall).toEqual({ query: 'Fix fees' });
    expect(options({ id: 'ses_1', home: '/home' })).toEqual({
      run: 'r1',
      bot: 'implementor',
      data: '/data',
      hub: '/hub',
    });
  });

  it('denies everything without tools and falls back to the default alias', () => {
    const { model: _, ...bare } = spec;
    const { args, env } = command({ ...bare, tools: [] });
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '')).toEqual({ '*': 'deny' });
    expect(args).toContain('bothub/default');
  });

  it('reports the session its first line names, and leaves the model to the model plugin', () => {
    expect(harnesses.opencode.start?.(spec, 'not json')).toEqual([{ type: 'start' }]);
    const first = readFileSync(join(import.meta.dirname, 'fixtures', 'opencode-run.jsonl'), 'utf8').split('\n')[0]!;
    expect(harnesses.opencode.start?.(spec, first)).toEqual([
      { type: 'start', session: 'ses_ecfe5c55cffe3r1vZYoqdYrwvF' },
    ]);
    const { model: _, ...bare } = spec;
    const plugin = (s: RunSpec) => JSON.parse(command(s).env.OPENCODE_CONFIG_CONTENT ?? '').plugin.at(-1)[1];
    expect(plugin(spec)).toEqual({ alias: 'coder' });
    expect(plugin(bare)).toEqual({ alias: 'default' });
  });

  it('continues an earlier session by id, keeping its sessions in the run home', () => {
    const { args } = command({ ...spec, session: { id: 'ses_1', home: '/data/runs/r1/home' } });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--'))).toEqual([
      '--model',
      'bothub/coder',
      '--session',
      'ses_1',
    ]);
    expect(harnesses.opencode.sessions).toBe('.local/share/opencode');
    expect(harnesses.pi.sessions).toBeUndefined();
  });

  it('lets a plain tool entry win over its patterns', () => {
    const { env } = command({ ...spec, tools: ['bash(git *)', 'bash'] });
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '').bash).toBe('allow');
  });

  it('parses a run into text, tool call and result, usage per step and end', () => {
    const events = fixture('opencode', 'opencode-run.jsonl');
    expect(types(events)).toEqual(['text', 'tool_call', 'tool_result', 'usage', 'text', 'usage', 'end']);
    expect(events[1]).toEqual({
      type: 'tool_call',
      id: 'call_mock1',
      tool: 'read',
      input: { path: 'a.txt', filePath: 'a.txt' },
      at: '2026-10-12T12:33:08.619Z',
    });
    expect(events[2]).toMatchObject({ type: 'tool_result', id: 'call_mock1', ok: true, ms: expect.any(Number) });
    expect((events[2] as { output: string }).output).toContain('1: hi');
    expect(events[3]).toEqual({ type: 'usage', inputTokens: 1200, outputTokens: 20, finish: 'tool-calls' });
    expect(events[6]).toEqual({ type: 'end', ok: true });
  });

  it('reports cached input, cache writes, reasoning, cost and why the step ended when there are any', () => {
    const line =
      '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":900,"write":50}},"cost":0.002}}';
    expect(parseLine(line)).toEqual([
      {
        type: 'usage',
        inputTokens: 1050,
        outputTokens: 20,
        cachedInputTokens: 900,
        cacheWriteTokens: 50,
        reasoningTokens: 5,
        costUsd: 0.002,
        finish: 'tool-calls',
      },
    ]);
  });

  it('maps a denied tool call to a failed result', () => {
    const denied =
      '{"type":"tool_use","timestamp":1791808195447,"sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"call_mock1","state":{"status":"error","input":{"command":"ls"},"error":"The user has specified a rule which prevents you from using this specific tool call."},"id":"prt_1","sessionID":"ses_1","messageID":"msg_1"}}';
    expect(parseLine(denied)).toEqual([
      { type: 'tool_call', id: 'call_mock1', tool: 'bash', input: { command: 'ls' } },
      {
        type: 'tool_result',
        id: 'call_mock1',
        ok: false,
        output: 'The user has specified a rule which prevents you from using this specific tool call.',
      },
    ]);
  });

  it("passes on the recall events bothub's plugins print, and nothing else they might claim", () => {
    const recall: AgentEvent = { type: 'recall', on: 'turn', query: 'q', tokens: 0, items: [] };
    expect(parseLine(JSON.stringify({ type: 'bothub', event: recall }))).toEqual([recall]);
    expect(parseLine(JSON.stringify({ type: 'bothub', event: { type: 'end', ok: true } }))).toEqual([]);
    expect(parseLine(JSON.stringify({ type: 'bothub', event: null }))).toEqual([]);
    expect(parseLine(JSON.stringify({ type: 'bothub', event: 'recall' }))).toEqual([]);
  });

  it('maps provider errors, unfinished steps, unknown lines and malformed JSON', () => {
    expect(fixture('opencode', 'opencode-error.jsonl')).toEqual([
      { type: 'error', message: 'Cannot connect to API: Unable to connect. Is the computer able to access the url?' },
    ]);
    expect(parseLine('{"type":"error","error":{"name":"MessageAbortedError"}}')).toEqual([
      { type: 'error', message: 'MessageAbortedError' },
    ]);
    expect(parseLine('{"type":"step_finish","part":{"type":"step-finish","reason":"length"}}')).toEqual([
      { type: 'end', ok: false },
    ]);
    expect(parseLine('{"type":"step_start","part":{"type":"step-start"}}')).toEqual([]);
    expect(
      parseLine('{"type":"tool_use","part":{"type":"tool","id":"p","tool":"read","state":{"status":"running"}}}')
    ).toEqual([]);
    expect(parseLine('')).toEqual([]);
    expect(types(parseLine('{"type":'))).toEqual(['error']);
  });
});

describe('pi', () => {
  const { command, parseLine } = harnesses.pi;

  it('builds an isolated print-mode argv with the prompt after --', () => {
    const { cmd, args, env } = command({ ...spec, tools: ['read', 'grep'] });
    expect(cmd).toBe('pi');
    expect(args.slice(-6)).toEqual([
      '--model',
      'bothub/coder',
      '--append-system-prompt',
      spec.system,
      '--',
      spec.prompt,
    ]);
    expect(args).toEqual(
      expect.arrayContaining(['--print', '--no-session', '--no-approve', '--no-context-files', '--no-extensions'])
    );
    expect(args[args.indexOf('--tools') + 1]).toBe('read,grep');
    expect(args).not.toContain('--approve');
    expect(env).toEqual({ BOTHUB_LLM_MODEL: 'coder', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
  });

  it('loads the bundled proxy provider and disables all tools for an empty allowlist', () => {
    const { model: _, ...bare } = spec;
    const { args, env } = command({ ...bare, tools: [] });
    const extension = args[args.indexOf('--extension') + 1] ?? '';
    expect(extension).toMatch(/pi-provider\.ts$/);
    expect(existsSync(extension)).toBe(true);
    expect(args).toContain('--no-tools');
    expect(args).not.toContain('--tools');
    expect(args).toContain('bothub/default');
    expect(env.BOTHUB_LLM_MODEL).toBe('default');
  });

  it('parses a run into start, text, usage, tool call and result, and end with the last reply', () => {
    const events = fixture('pi', 'pi-run.jsonl');
    expect(types(events)).toEqual(['start', 'text', 'usage', 'tool_call', 'tool_result', 'text', 'usage', 'end']);
    expect(events[0]).toMatchObject({ type: 'start', session: expect.any(String) });
    expect(events[3]).toEqual({
      type: 'tool_call',
      id: 'call_mock1',
      tool: 'read',
      input: { path: 'a.txt', filePath: 'a.txt' },
    });
    expect(events[4]).toEqual({ type: 'tool_result', id: 'call_mock1', ok: true, output: 'hi\n' });
    expect(events[7]).toEqual({ type: 'end', ok: true, turns: 2, result: 'done' });
  });

  it('reports the model the proxy answered with as a start', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'review', responseModel: 'smart' },
    });
    expect(parseLine(line)).toEqual([
      { type: 'start', model: 'smart' },
      { type: 'text', text: 'ok' },
    ]);
  });

  it('reports one failure after retries are exhausted', () => {
    expect(fixture('pi', 'pi-error.jsonl')).toEqual([
      { type: 'start', session: expect.any(String) },
      { type: 'error', message: 'Connection error.' },
      { type: 'end', ok: false, turns: 1 },
    ]);
  });

  it('ignores unknown lines and reports malformed JSON', () => {
    expect(parseLine('{"type":"auto_retry_start","attempt":1}')).toEqual([]);
    expect(parseLine('{"type":"message_end","message":{"role":"user","content":"hi"}}')).toEqual([]);
    expect(parseLine('')).toEqual([]);
    expect(types(parseLine('not json'))).toEqual(['error']);
  });
});

describe('claude', () => {
  const { command, parseLine } = harnesses.claude;

  it('builds a print-mode argv limited to the allowlist, with the prompt after --', () => {
    const { cmd, args } = command(spec);
    expect(cmd).toBe('claude');
    expect(args.slice(-4)).toEqual(['--append-system-prompt', spec.system, '--', spec.prompt]);
    expect(args).toEqual(
      expect.arrayContaining([
        '--print',
        '--safe-mode',
        '--restricted',
        '--strict-mcp-config',
        '--no-session-persistence',
      ])
    );
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--output-format')).toBe('stream-json');
    expect(flag('--permission-mode')).toBe('dontAsk');
    expect(flag('--tools')).toBe('Read,Bash');
    expect(flag('--allowedTools')).toBe('Read,Bash(git diff*),Bash(git log*)');
    expect(flag('--model')).toBe('coder');
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions|acceptEdits/);
  });

  it('disables every tool for an empty allowlist or hub tools only, and leaves the model to the CLI', () => {
    const { model: _, ...bare } = spec;
    const { args } = command({ ...bare, tools: ['issues_get'] });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--model');
  });

  it('logs in as the host user and passes no key', () => {
    const { env } = command(spec);
    expect(env.HOME).toBe(process.env.HOME);
    expect(Object.keys(env).join()).not.toMatch(/KEY|TOKEN/);
  });

  it('parses a run into start, tool call and result, text, usage per model and end', () => {
    const events = fixture('claude', 'claude-run.jsonl');
    expect(types(events)).toEqual(['start', 'tool_call', 'tool_result', 'text', 'usage', 'end']);
    expect(events[0]).toEqual({
      type: 'start',
      session: 'e47727a3-ac6e-4f15-8327-b47a312c26d1',
      model: 'claude-code/claude-haiku-5-5',
    });
    expect(events[1]).toEqual({
      type: 'tool_call',
      id: 'toolu_01',
      tool: 'Read',
      input: { file_path: '/tmp/x/add.js' },
    });
    expect(events[2]).toMatchObject({ type: 'tool_result', id: 'toolu_01', ok: true });
    expect(events[4]).toEqual({
      type: 'usage',
      inputTokens: 4 + 8401 + 2340,
      outputTokens: 177,
      cachedInputTokens: 8401,
      model: 'claude-code/claude-haiku-5-5',
    });
    expect(events[5]).toMatchObject({ type: 'end', ok: true, turns: 2, result: expect.stringContaining('a - b') });
  });

  it('reports no cost, and no price table prices its models', async () => {
    expect(fixture('claude', 'claude-run.jsonl').some(e => 'costUsd' in e)).toBe(false);
    const file = join(import.meta.dirname, '..', 'infra', 'local', 'prices.json');
    const prices = await loadPrices({ file, env: {} })();
    expect(prices['claude-opus-5-5']).toBeDefined();
    expect(prices['claude-code/claude-opus-5-5']).toBeUndefined();
  });

  it('reports a failed run with its reason, and malformed JSON', () => {
    const failed = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 5,
      modelUsage: {},
    });
    expect(parseLine(failed)).toEqual([
      { type: 'error', message: 'error_max_turns' },
      { type: 'end', ok: false, turns: 5 },
    ]);
    expect(parseLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseLine('')).toEqual([]);
    expect(types(parseLine('{"type":'))).toEqual(['error']);
  });

  it('runs a fake claude binary through the runner', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'bothub-claude-'));
    const argv = join(bin, 'argv.json');
    const fake = join(bin, 'claude');
    const replay = JSON.stringify(readFileSync(join(import.meta.dirname, 'fixtures', 'claude-run.jsonl'), 'utf8'));
    const record = `require('fs').writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)))`;
    writeFileSync(fake, `#!${process.execPath}\n${record};\nprocess.stdout.write(${replay});\n`);
    chmodSync(fake, 0o755);
    const path = process.env.PATH;
    process.env.PATH = [bin, path].join(delimiter);
    try {
      const run = agentEvents(harnesses.claude, { ...spec, cwd: bin }, undefined, undefined, unsandboxed);
      const events = Chunk.toArray(await Effect.runPromise(Stream.runCollect(run)));
      expect(types(events)).toEqual(['start', 'tool_call', 'tool_result', 'text', 'usage', 'end']);
      expect(JSON.parse(readFileSync(argv, 'utf8')).at(-1)).toBe(spec.prompt);
    } finally {
      process.env.PATH = path;
    }
  });
});
