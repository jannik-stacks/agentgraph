import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harnesses } from '../src/harnesses/index.ts';
import type { AgentEvent, RunSpec } from '../src/types.ts';

const spec: RunSpec = {
  prompt: '--fix the "bug"  now\nplease --auto',
  system: 'You are "the reviewer".\nBe brief.',
  cwd: '/tmp/x',
  model: 'coder',
  tools: ['read', 'bash(git diff*)', 'bash(git log*)'],
  maxTurns: 5,
};

const fixture = (harness: 'opencode' | 'pi', name: string) =>
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
      '--pure',
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
    });
    expect(config.provider.bothub.npm).toBe('@ai-sdk/openai');
    expect(config.provider.bothub.models).toEqual({ coder: {} });
    expect(config.agent.bothub).toEqual({ mode: 'primary', prompt: spec.system, steps: 5 });
    expect(env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' });
    expect(JSON.stringify(env)).not.toMatch(/sk-|vk-/);
  });

  it('turns off every memory feature opencode has', () => {
    const { args, env } = command(spec);
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '');
    expect(config).toMatchObject({ share: 'disabled', snapshot: false, compaction: { auto: false, prune: false } });
    expect(config.instructions).toBeUndefined();
    expect(config.plugin).toBeUndefined();
    expect(env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_AUTOCOMPACT: '1',
      OPENCODE_DISABLE_PRUNE: '1',
    });
    expect(args).toContain('--pure');
    expect(args.slice(0, args.indexOf('--'))).not.toEqual(
      expect.arrayContaining(['--continue', '--session', '--share'])
    );
  });

  it("loads bothub's own plugins instead of --pure, and allows history only when the surfacer offers it", () => {
    const surfacer = { run: 'r1', bot: 'implementor', data: '/data', hub: '/hub' };
    const decider = { questions: [{ on: 'tool_call' as const, ask: 'In scope?', say: 'out of scope' }] };
    const { args, env } = command({ ...spec, surfacer, decider });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '');
    expect(config.plugin).toEqual([
      [expect.stringMatching(/\/src\/harnesses\/opencode-surfacer\.ts$/), surfacer],
      [expect.stringMatching(/\/src\/harnesses\/opencode-decider\.ts$/), decider],
    ]);
    expect(config.plugin.every(([path]: [string]) => existsSync(path))).toBe(true);
    expect(args).not.toContain('--pure');
    expect(config).toMatchObject({ share: 'disabled', compaction: { auto: false } });
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '').history).toBeUndefined();
    const withHistory = command({ ...spec, surfacer: { ...surfacer, history: true }, decider: { questions: [] } });
    expect(JSON.parse(withHistory.env.OPENCODE_PERMISSION ?? '').history).toBe('allow');
    expect(JSON.parse(withHistory.env.OPENCODE_CONFIG_CONTENT ?? '').plugin).toHaveLength(1);
  });

  it('denies everything without tools and falls back to the default alias', () => {
    const { model: _, ...bare } = spec;
    const { args, env } = command({ ...bare, tools: [] });
    expect(JSON.parse(env.OPENCODE_PERMISSION ?? '')).toEqual({ '*': 'deny' });
    expect(args).toContain('bothub/default');
  });

  it('reports the model alias it runs, since its output names none', () => {
    const { model: _, ...bare } = spec;
    expect(harnesses.opencode.start?.(spec)).toEqual([{ type: 'start', model: 'coder' }]);
    expect(harnesses.opencode.start?.(bare)).toEqual([{ type: 'start', model: 'default' }]);
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
    });
    expect(events[2]).toMatchObject({ type: 'tool_result', id: 'call_mock1', ok: true });
    expect((events[2] as { output: string }).output).toContain('1: hi');
    expect(events[3]).toEqual({ type: 'usage', inputTokens: 1200, outputTokens: 20 });
    expect(events[6]).toEqual({ type: 'end', ok: true });
  });

  it('reports cached input, reasoning and cost per step when there are any', () => {
    const line =
      '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":900,"write":0}},"cost":0.002}}';
    expect(parseLine(line)).toEqual([
      {
        type: 'usage',
        inputTokens: 1000,
        outputTokens: 20,
        cachedInputTokens: 900,
        reasoningTokens: 5,
        costUsd: 0.002,
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
