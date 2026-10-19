import { describe, expect, it } from 'vitest';
import { transcript } from '../src/context.ts';
import type { Trace } from '../src/store.ts';
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
  usd: 1.5,
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
  { at, step: 'implement', event: { type: 'start', session: 's1', model: 'smart', home: '/h' } },
  { at, step: 'implement', event: { type: 'thinking', text: 'The issue names kit/src/fee.ts.' } },
  {
    at,
    step: 'implement',
    event: { type: 'tool', id: 't1', name: 'bash', input: { command: 'npm test' }, ok: false, exit: 1, output: 'FAIL' },
  },
  {
    at,
    step: 'implement',
    event: { type: 'text', text: 'Done. BOTHUB_LLM_API_KEY=sk-bh-implementor-0123456789abcdef' },
  },
  { at, step: 'implement', session: { id: 's1', resumed: false, ended: 'stop', usd: 0.4 } },
  { at, step: 'implement', check: { check: 'tests', pass: false, findings: '1 failed', ms: 1 } },
  {
    at,
    step: 'implement',
    outcome: { kind: 'back', why: 'document maxFee' },
    run: { step: 'implement', status: 'running', tries: 0, rounds: {} },
  },
  { at, step: 'implement', saved: { tries: 1 } },
];

describe('transcript', () => {
  it('renders each session with its thinking, tool calls, checks and moves, numbered by trace line', () => {
    const text = transcript(21, [{ run, lines }]);
    expect(text).toContain('### implementor (opencode, smart)\n\nYou fix one issue.');
    expect(text).toContain('## Run issue-21-1 (issue, waiting, $1.50)');
    expect(text).toContain('### implement, implementor, fresh');
    expect(text).toContain('3 thinking: The issue names kit/src/fee.ts.');
    expect(text).toContain('4 tool bash {"command":"npm test"} exit 1: FAIL');
    expect(text).toContain('7 check tests: FAIL 1 failed');
    expect(text).toContain('8 outcome back: document maxFee -> implement running');
    expect(text).not.toContain('saved');
    expect(text).toContain('5 text: Done. BOTHUB_LLM_API_KEY=[redacted]');
  });

  it('redacts tokens and private keys', () => {
    const prompt =
      'use ghp_abcdefghijklmnopqrstuvwxyz0123 and -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
    const text = transcript(21, [{ run, lines: [{ at, step: 'implement', prompt: { ...spec, prompt } }] }]);
    expect(text).toContain('1 prompt: use [redacted] and [redacted]');
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
    const long = transcript(21, [{ run, lines: many }]);
    expect(long).toMatch(/\.\.\. \d+ entries cut: tool read \d+/);
    expect(long).toContain('202 session ended stop');

    const two = transcript(
      21,
      [
        { run, lines: many },
        { run: { ...run, id: 'issue-21-2' }, lines },
      ],
      5000
    );
    expect(two).toContain('## Run issue-21-1 (issue, waiting, $1.50)\n\nShortened to fit');
    expect(two).toContain('202 session ended stop');
    expect(two).toContain('3 thinking: The issue names kit/src/fee.ts.');
  });
});
