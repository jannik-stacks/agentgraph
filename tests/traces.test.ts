import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { temp, write } from './kit.ts';

const script = join(resolve(import.meta.dirname, '..'), 'bin/traces.mjs');
const session = (step: string, s: object) => JSON.stringify({ at: '', step, session: { resumed: false, ...s } });

describe('traces', () => {
  it('fails on a started session that cost nothing, and skips one that never started', () => {
    const data = temp('traces');
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
      '1 of 2 sessions cost nothing',
    ]);
  });
});
