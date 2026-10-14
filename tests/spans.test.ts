import { describe, expect, it } from 'vitest';
import { runSpans, timeKind } from '../src/spans.ts';
import type { EventRecord, Run } from '../src/store.ts';
import type { AgentEvent } from '../src/types.ts';

const run: Run = {
  id: 'r2',
  workflow: 'issue',
  job: 'implement',
  bot: 'implementor',
  harness: 'opencode',
  model: 'smart',
  parent: 'r1',
  previous: 'r0',
  attempt: 2,
  status: 'failed',
  stopped: 'stalled',
  engine: { commit: 'abc', dirty: true, src: 'f00' },
  hub: 'h1',
  event: {
    id: 'e',
    ts: '2026-10-14T10:00:00.000Z',
    source: 'local',
    trigger: 'issue_comment',
    repo: 'acme/app',
    number: 1,
    actor: { login: 'morgan', association: 'OWNER' },
  },
  startedAt: '2026-10-14T10:00:00.000Z',
  endedAt: '2026-10-14T10:20:00.000Z',
};

const at = (s: number) => new Date(Date.parse('2026-10-14T10:00:00.000Z') + s * 1000).toISOString();
const records = (events: [number, AgentEvent][]): EventRecord[] =>
  events.map(([s, event], seq) => ({ ts: at(s), seq, event }));

describe('timeKind', () => {
  it('sorts tools by name and shell commands by the hub patterns, then the defaults', () => {
    expect(timeKind('edit', {})).toBe('edit');
    expect(timeKind('read', {})).toBe('read');
    expect(timeKind('bash', { command: 'npm test' })).toBe('test');
    expect(timeKind('bash', { command: 'cd x && cargo build' })).toBe('build');
    expect(timeKind('bash', { command: 'git diff HEAD' })).toBe('read');
    expect(timeKind('bash', { command: 'sleep 5' })).toBe('wait');
    expect(timeKind('bash', { command: 'echo hi' })).toBe('other');
    expect(timeKind('bash', { command: 'just check' }, { test: ['^just check'] })).toBe('test');
  });
});

describe('runSpans', () => {
  const spans = runSpans(
    run,
    records([
      [1, { type: 'start', session: 's', model: 'gpt' }],
      [9, { type: 'tool_call', id: 'c1', tool: 'bash', input: { command: 'cargo test' }, at: at(5) }],
      [9, { type: 'tool_result', id: 'c1', ok: false, ms: 3000 }],
      [
        10,
        {
          type: 'usage',
          inputTokens: 100,
          outputTokens: 5,
          cachedInputTokens: 80,
          finish: 'tool-calls',
          costUsd: 0.01,
        },
      ],
      [12, { type: 'tool_call', id: 'c2', tool: 'read', input: {} }],
      [12, { type: 'tool_result', id: 'c2', ok: true }],
      [14, { type: 'usage', inputTokens: 120, outputTokens: 9 }],
    ]),
    {
      results: [],
      applied: false,
      proposals: [],
      errors: [],
      accepted: [],
      rejected: [],
      checks: [{ check: 'lint', pass: false, gating: true, startedAt: at(15), endedAt: at(25) }],
    }
  );
  const byName = (name: string) => spans.filter(s => s.name === name);

  it('nests every span in the run span, which links its parent and carries the engine and hub', () => {
    const [root] = byName('run');
    expect(root).toMatchObject({
      parent_span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      status: { code: 'error', error_type: 'stalled' },
      attributes: {
        'bothub.run.previous': 'r0',
        'bothub.engine.commit': 'abc',
        'bothub.engine.dirty': true,
        'bothub.hub': 'h1',
        'bothub.issue': 1,
      },
    });
    expect(root!.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(spans.slice(1).every(s => s.parent_span_id === root!.span_id && s.trace_id === root!.trace_id)).toBe(true);
  });

  it('times a tool by the harness and a model request from the last one to its first tool', () => {
    const [test, read] = byName('tool_use');
    expect(test).toMatchObject({
      start: at(5),
      end: at(8),
      status: { code: 'error', error_type: 'tool_error' },
      attributes: { 'gen_ai.tool.name': 'bash', 'bothub.time.kind': 'test', 'bothub.timing': 'harness' },
    });
    expect(read!.attributes['bothub.timing']).toBe('unknown');
    const [first, second] = byName('model_request');
    expect(first).toMatchObject({
      start: at(0),
      end: at(5),
      attributes: {
        'gen_ai.request.model': 'smart',
        'gen_ai.response.model': 'gpt',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.cache_read.input_tokens': 80,
        'gen_ai.response.finish_reasons': ['tool-calls'],
        'bothub.cost_usd': 0.01,
        'bothub.time.kind': 'model',
      },
    });
    expect(second).toMatchObject({ start: at(10), end: at(12) });
  });

  it('adds script checks as test time and the silence before a stall', () => {
    expect(byName('check')[0]).toMatchObject({
      start: at(15),
      end: at(25),
      status: { code: 'error', error_type: 'failed' },
      attributes: { 'bothub.check': 'lint', 'bothub.time.kind': 'test' },
    });
    expect(byName('stall')[0]).toMatchObject({
      start: at(14),
      end: run.endedAt,
      attributes: { 'bothub.time.kind': 'stall' },
    });
  });
});
