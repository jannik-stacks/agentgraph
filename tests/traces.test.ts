import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const script = join(resolve(import.meta.dirname, '..'), 'bin/traces.mjs');
const session = (step: string, s: object) => JSON.stringify({ at: '', step, session: { resumed: false, ...s } });

describe('traces', () => {
  it('fails on a started session that cost nothing, and skips one that never started', () => {
    const data = tmp('traces');
    write(data, {
      'run-1/trace.jsonl': [
        JSON.stringify({ at: '', step: 'implement', event: { type: 'start', session: 's1', model: 'm', home: '/h' } }),
        session('implement', { id: 's1', ended: 'stop', usd: 0 }),
        session('review', { id: 's2', ended: 'stop', usd: 0.12 }),
        session('review', { ended: 'provider', usd: 0 }),
      ].join('\n'),
      'run-2/run.json': '{}',
    });
    const { status, stdout } = spawnSync('node', [script, data], { encoding: 'utf8' });
    expect(status).toBe(1);
    expect(stdout.trim().split('\n')).toEqual([
      'run-1 implement: session s1 ended stop with usd 0',
      '1 findings over 2 sessions',
    ]);
  });

  it('fails on denied tool calls and on a done run without its required proposal, and shows waits', () => {
    const data = tmp('traces');
    const tool = (ok: boolean, extra: object) =>
      JSON.stringify({
        at: '2026-10-16T00:05:00.000Z',
        step: 'implement',
        event: { type: 'tool', name: 'read', input: { p: 1 }, ok, ...extra },
      });
    const applied = (kind: string) =>
      JSON.stringify({ at: '', step: 'implement', applied: { ok: true, proposal: { kind } } });
    write(data, {
      'a/run.json': JSON.stringify({ workflow: 'issue', status: 'done' }),
      'a/trace.jsonl': [
        JSON.stringify({ at: '2026-10-16T00:00:00.000Z', step: 'implement', saved: {} }),
        JSON.stringify({ at: '2026-10-16T00:04:00.000Z', step: 'implement', prompt: {} }),
        tool(false, { denied: true }),
        tool(false, { output: 'The user has specified a rule which prevents you from using this specific tool call' }),
        tool(true, {}),
        applied('comment'),
      ].join('\n'),
      'b/run.json': JSON.stringify({ workflow: 'issue', status: 'done' }),
      'b/trace.jsonl': applied('push'),
    });
    const { status, stdout } = spawnSync('node', [script, data, 'issue=pull_request|push'], { encoding: 'utf8' });
    expect(status).toBe(1);
    expect(stdout.trim().split('\n')).toEqual([
      'a: waited 4 min before its first session',
      'a implement: denied read {"p":1}',
      'a implement: denied read {"p":1}',
      'a: done without pull_request or push',
      '3 findings over 0 sessions',
    ]);
  });
});
