import { describe, expect, it } from 'vitest';
import { transcript } from '../src/context.ts';
import type { CheckEntry, Trace } from '../src/trace.ts';
import type { Run } from '../src/workflow.ts';

const run: Run = {
  id: 'issue-21-1',
  workflow: 'issue',
  issue: 21,
  step: 'merge',
  status: 'waiting',
  tries: 0,
  rounds: {},
  sessions: {},
  started: '2026-10-19T00:00:00Z',
};
const at = '2026-10-19T00:01:00Z';
const spec = {
  harness: 'opencode' as const,
  model: 'smart',
  system: 'You fix one issue.',
  prompt: 'Add maxFee.',
  dir: '/work',
  tools: ['read'],
  agent: 'implementor',
  minutes: 20,
};
const lines: Trace[] = [
  { at, step: 'implement', prompt: spec },
  { at, step: 'implement', event: { type: 'start', session: 's1', harness: 'pi', model: 'smart', home: '/h' } },
  { at, step: 'implement', event: { type: 'thinking', text: 'The issue names kit/src/fee.ts.' } },
  {
    at,
    step: 'implement',
    event: { type: 'tool', id: 't1', name: 'bash', input: { command: 'npm test' }, ok: false, exit: 1, output: 'FAIL' },
  },
  {
    at,
    step: 'implement',
    event: {
      type: 'text',
      text: `Done. AGENTGRAPH_LLM_API_KEY=${['sk-bh', 'implementor', '0123456789abcdef'].join('-')}`,
    },
  },
  { at, step: 'implement', session: { id: 's1', resumed: false, ended: 'stop', usd: 0.4 } },
  {
    at,
    step: 'implement',
    outcome: { kind: 'back', why: 'document maxFee' },
    run: { step: 'implement', status: 'running', tries: 0, rounds: {} },
  },
  { at, step: 'implement', saved: { tries: 1 } },
];

const checks: CheckEntry[] = [
  { at, step: 'implement', version: 'v1', usd: 0, check: { check: 'tests', pass: false, findings: '1 failed', ms: 1 } },
];

describe('transcript', () => {
  it('renders each session with its thinking, tool calls, checks and moves, numbered by trace line', () => {
    const text = transcript(21, [{ run, lines, checks }]);
    expect(text).toContain('### implementor (opencode, smart)\n\nYou fix one issue.');
    expect(text).toContain('## Run issue-21-1 (issue, waiting, $0.40)');
    expect(text).toContain('### implement, implementor, fresh');
    expect(text).toContain('3 thinking: The issue names kit/src/fee.ts.');
    expect(text).toContain('4 tool bash {"command":"npm test"} exit 1: FAIL');
    expect(text).toContain(`### Checks\n\n${at} implement, check tests: FAIL 1 failed`);
    expect(text).toContain('7 outcome back: document maxFee -> implement running');
    expect(text).not.toContain('saved');
    expect(text).toContain('5 text: Done. AGENTGRAPH_LLM_API_KEY=[redacted]');
  });

  it('redacts tokens and private keys', () => {
    const prompt =
      'use ghp_' +
      'abcdefghijklmnopqrstuvwxyz0123 and -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
    const text = transcript(21, [{ run, lines: [{ at, step: 'implement', prompt: { ...spec, prompt } }], checks: [] }]);
    expect(text).toContain('1 prompt: use [redacted] and [redacted]');
    const more =
      'AKIA' +
      'IOSFODNN7EXAMPLE npm_abcdefghijklmnopqrstuvwxyz0123456789 Authorization: Bearer abc.def-ghi_jkl012 eyJhbGciOiJIUzI1NiJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const also = transcript(21, [
      { run, lines: [{ at, step: 'implement', prompt: { ...spec, prompt: more } }], checks: [] },
    ]);
    expect(also).toContain('1 prompt: [redacted] [redacted] Authorization: Bearer [redacted] [redacted]');
  });

  it('tallies the middle of a long session and shortens the oldest runs past the budget', () => {
    const many: Trace[] = [
      { at, step: 'implement', prompt: spec },
      ...Array.from({ length: 200 }, (_, i): Trace => ({
        at,
        step: 'implement',
        event: {
          type: 'tool',
          id: `t${i}`,
          name: 'read',
          input: { path: `f${i}.ts` },
          ok: true,
          output: 'x'.repeat(200),
        },
      })),
      { at, step: 'implement', session: { id: 's1', resumed: false, ended: 'stop', usd: 0.4 } },
    ];
    const long = transcript(21, [{ run, lines: many, checks: [] }]);
    expect(long).toMatch(/\.\.\. \d+ entries cut: tool read \d+/);
    expect(long).toContain('202 session ended stop');

    const two = transcript(
      21,
      [
        { run, lines: many, checks: [] },
        { run: { ...run, id: 'issue-21-2' }, lines, checks },
      ],
      5000
    );
    expect(two).toContain('## Run issue-21-1 (issue, waiting, $0.40)\n\nShortened to fit');
    expect(two).toContain('202 session ended stop');
    expect(two).toContain('3 thinking: The issue names kit/src/fee.ts.');
  });

  it('keeps the newest sessions of a run too long to fit', () => {
    const session = (n: number): Trace[] => [
      { at, step: 'implement', prompt: { ...spec, prompt: `try ${n}` } },
      { at, step: 'implement', event: { type: 'text', text: `${n} `.repeat(400) } },
      { at, step: 'implement', session: { id: `s${n}`, resumed: true, ended: 'stop', usd: 0.1 } },
    ];
    const text = transcript(
      21,
      [{ run, lines: Array.from({ length: 30 }, (_, n) => session(n)).flat(), checks: [] }],
      20_000
    );
    expect(text.length).toBeLessThan(20_100);
    expect(text).toContain('# Traces of #21');
    expect(text).toContain('prompt: try 29');
    expect(text).toContain('90 session ended stop');
  });
});
