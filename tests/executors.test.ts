import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executors } from '../src/executors/index.ts';
import type { AgentEvent, RunSpec } from '../src/types.ts';

const spec: RunSpec = {
  prompt: '--fix the bug',
  system: 'You are "the reviewer".\nBe brief.',
  cwd: '/tmp/x',
  model: 'opus',
  tools: ['Read', 'Bash(git diff:*)'],
  maxTurns: 5,
};

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .flatMap(line => executors[name.startsWith('claude') ? 'claude-code' : 'codex'].parseLine(line));

const types = (events: AgentEvent[]) => events.map(e => e.type);

describe('claude-code', () => {
  const { command, parseLine } = executors['claude-code'];

  it('builds a headless argv restricted to the allowlist', () => {
    const { cmd, args, env } = command(spec);
    expect(cmd).toBe('claude');
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '5',
      '--append-system-prompt',
      spec.system,
      '--model',
      'opus',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--allowedTools',
      'Read',
      'Bash(git diff:*)',
      '--',
      '--fix the bug',
    ]);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(env).toEqual({});
  });

  it('omits optional flags', () => {
    const { model: _, ...bare } = spec;
    const { args } = command({ ...bare, tools: [] });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--allowedTools');
  });

  it('parses a real stream into start, tool call, tool result, text, usage and end', () => {
    const events = fixture('claude-stream.jsonl');
    expect(types(events)).toEqual(['start', 'tool_call', 'tool_result', 'text', 'usage', 'end']);
    expect(events[0]).toEqual({
      type: 'start',
      session: 'b72b4545-b441-44ec-b423-77f5abaf2a50',
      model: 'claude-opus-5-5',
    });
    expect(events[1]).toMatchObject({ type: 'tool_call', tool: 'Bash', input: { command: 'ls -la' } });
    expect(events[2]).toMatchObject({ type: 'tool_result', id: (events[1] as { id: string }).id, ok: true });
    expect((events[2] as { output: string }).output).toContain('a.txt');
    expect(events[5]).toMatchObject({ type: 'end', ok: true, turns: 2, costUsd: expect.any(Number) });
    expect(events[4]).toMatchObject({ type: 'usage', outputTokens: 129 });
  });

  it('maps failures, unknown lines and malformed JSON', () => {
    expect(parseLine('{"type":"result","subtype":"error_max_turns","is_error":false,"num_turns":5}')).toEqual([
      { type: 'end', ok: false, turns: 5 },
    ]);
    expect(parseLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseLine('')).toEqual([]);
    expect(types(parseLine('{"type":'))).toEqual(['error']);
  });
});

describe('codex', () => {
  const { command, parseLine } = executors.codex;

  it('builds a sandboxed exec argv', () => {
    const { cmd, args, env } = command(spec);
    expect(cmd).toBe('codex');
    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'developer_instructions="You are \\"the reviewer\\".\\nBe brief."',
      '-C',
      '/tmp/x',
      '-m',
      'opus',
      '--',
      '--fix the bug',
    ]);
    expect(args.join(' ')).not.toMatch(/dangerously|danger-full-access/);
    expect(env).toEqual({});
  });

  it('parses a real stream into start, text, tool calls and results, usage and end', () => {
    const events = fixture('codex-exec.jsonl');
    expect(types(events)).toEqual([
      'start',
      'text',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'text',
      'usage',
      'end',
    ]);
    expect(events[0]).toEqual({ type: 'start', session: '01a12ffb-c315-7fa3-a19f-ce68825b9e5b' });
    expect(events[2]).toEqual({
      type: 'tool_call',
      id: 'item_1',
      tool: 'shell',
      input: { command: "/bin/zsh -lc 'ls -la'" },
    });
    expect(events[3]).toMatchObject({ type: 'tool_result', id: 'item_1', ok: true });
    expect(events[6]).toEqual({ type: 'text', text: 'done' });
    expect(events[7]).toEqual({ type: 'usage', inputTokens: 33090, outputTokens: 75 });
    expect(events[8]).toEqual({ type: 'end', ok: true });
  });

  it('maps file changes, failures, unknown lines and malformed JSON', () => {
    const change =
      '{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[{"path":"a.ts","kind":"update"}],"status":"completed"}}';
    expect(types(parseLine(change))).toEqual(['tool_call', 'tool_result']);
    expect(parseLine('{"type":"turn.failed","error":{"message":"quota"}}')).toEqual([
      { type: 'error', message: 'quota' },
      { type: 'end', ok: false },
    ]);
    expect(parseLine('{"type":"turn.started"}')).toEqual([]);
    expect(parseLine('{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"…"}}')).toEqual([]);
    expect(types(parseLine('not json'))).toEqual(['error']);
  });
});
