import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { opencode } from '../src/harnesses/opencode.ts';
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

const t0 = Date.parse(run.startedAt!);
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

/** What opencode prints for a finished tool call that ran from `from` to `to` seconds. */
const toolLine = (id: string, tool: string, input: unknown, ok: boolean, from: number, to: number) =>
  JSON.stringify({
    type: 'tool_use',
    part: {
      type: 'tool',
      tool,
      callID: id,
      state: {
        status: ok ? 'completed' : 'error',
        input,
        output: 'x',
        time: { start: t0 + from * 1000, end: t0 + to * 1000 },
      },
    },
  });
const stepLine = (reason: string, cost?: number) =>
  JSON.stringify({
    type: 'step_finish',
    part: { type: 'step-finish', reason, tokens: { input: 20, output: 5, cache: { read: 80, write: 10 } }, cost },
  });

describe('timeKind', () => {
  it('sorts tools by name and shell commands by the hub patterns, then the defaults', () => {
    const compiled = compile([{ path: 'hub.yaml', source: "time-kinds:\n  test: ['^just check']\n" }]);
    const hub = compiled.ok ? compiled.config.hub['time-kinds'] : {};
    expect(timeKind('bash', { command: 'just check' }, hub)).toBe('test');
    expect(timeKind('edit', {}, hub)).toBe('edit');
    expect(timeKind('read', {}, hub)).toBe('read');
    expect(timeKind('bash', { command: 'npm test' }, hub)).toBe('test');
    expect(timeKind('bash', { command: 'cd x && cargo build' }, hub)).toBe('build');
    expect(timeKind('bash', { command: 'git diff HEAD' }, hub)).toBe('read');
    expect(timeKind('bash', { command: 'sleep 5' }, hub)).toBe('wait');
    expect(timeKind('bash', { command: 'echo hi' }, hub)).toBe('other');
    expect(compile([{ path: 'hub.yaml', source: "time-kinds:\n  test: ['(']\n" }]).ok).toBe(false);
  });
});

describe('runSpans', () => {
  it('nests an opencode run in its run span, timing tools by opencode and model requests up to their first tool', () => {
    const seen: [number, string][] = [
      [9, toolLine('c1', 'bash', { command: 'cargo test' }, false, 5, 8)],
      [10, stepLine('tool-calls', 0.01)],
      [12, toolLine('c2', 'read', {}, true, 11, 11.5)],
      [14, stepLine('stop')],
    ];
    const events: [number, AgentEvent][] = [
      [1, { type: 'start', session: 's', model: 'gpt' }],
      ...seen.flatMap(([s, line]) => opencode.parseLine(line).map(e => [s, e] as [number, AgentEvent])),
    ];
    const records: EventRecord[] = events.map(([s, event], seq) => ({ ts: at(s), seq, event }));
    const checks = [{ check: 'lint', pass: false, gating: true, startedAt: at(15), endedAt: at(25) }];
    const outcome = { results: [], applied: false, proposals: [], errors: [], accepted: [], rejected: [], checks };
    const spans = runSpans(run, records, outcome);
    const named = (name: string) => spans.filter(s => s.name === name);

    const [root] = named('run');
    expect(root).toMatchObject({
      parent_span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      status: { code: 'error', error_type: 'stalled' },
      attributes: { 'bothub.run.previous': 'r0', 'bothub.engine.commit': 'abc', 'bothub.hub': 'h1', 'bothub.issue': 1 },
    });
    expect(root!.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(spans.slice(1).every(s => s.parent_span_id === root!.span_id && s.trace_id === root!.trace_id)).toBe(true);

    const [test, read] = named('tool_use');
    expect(test).toMatchObject({
      start: at(5),
      end: at(8),
      status: { code: 'error', error_type: 'tool_error' },
      attributes: { 'gen_ai.tool.name': 'bash', 'bothub.time.kind': 'test', 'bothub.timing': 'harness' },
    });
    expect(read).toMatchObject({ start: at(11), end: at(11.5), attributes: { 'bothub.time.kind': 'read' } });
    const [first, second] = named('model_request');
    expect(first).toMatchObject({
      start: at(0),
      end: at(5),
      attributes: {
        'gen_ai.request.model': 'smart',
        'gen_ai.response.model': 'gpt',
        'gen_ai.usage.input_tokens': 110,
        'gen_ai.usage.cache_read.input_tokens': 80,
        'gen_ai.usage.cache_write.input_tokens': 10,
        'gen_ai.response.finish_reasons': ['tool-calls'],
        'bothub.cost_usd': 0.01,
        'bothub.time.kind': 'model',
      },
    });
    expect(second).toMatchObject({ start: at(10), end: at(11) });
    expect(named('check')[0]).toMatchObject({
      start: at(15),
      end: at(25),
      status: { code: 'error', error_type: 'failed' },
      attributes: { 'bothub.check': 'lint', 'bothub.time.kind': 'test' },
    });
    expect(named('stall')[0]).toMatchObject({
      start: at(14),
      end: run.endedAt,
      attributes: { 'bothub.time.kind': 'stall' },
    });
  });
});
