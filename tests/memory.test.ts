import { describe, expect, it } from 'vitest';
import { memoryPath, recentMemory, renderMemory, summarize, writeMemory } from '../src/memory.ts';
import type { EventRecord, Outcome, Run } from '../src/store.ts';
import type { AgentEvent } from '../src/types.ts';

const run = (fields: Partial<Run> = {}): Run => ({
  id: 'r1',
  workflow: 'implement',
  job: 'code',
  bot: 'coder',
  status: 'succeeded',
  closure: 'done',
  attempt: 2,
  startedAt: '2026-10-12T00:00:00.000Z',
  endedAt: '2026-10-12T00:03:12.000Z',
  costUsd: 0.125,
  event: {
    id: 'e',
    ts: '2026-10-12T00:00:00.000Z',
    source: 'local',
    trigger: 'issue_comment',
    repo: 'acme/app',
    actor: { login: 'morgan', association: 'OWNER' },
  },
  ...fields,
});

const untimed = ({ startedAt: _s, endedAt: _e, ...rest }: Run): Run => rest;

const events = (...list: AgentEvent[]): EventRecord[] =>
  list.map((event, seq) => ({ ts: `2026-10-12T00:00:${String(seq).padStart(2, '0')}.000Z`, seq, event }));

const outcome: Outcome = {
  proposals: [
    { kind: 'push', branch: 'bothub/7-fix', files: ['src/b.ts'] },
    { kind: 'open-pr', title: 'Fix the thing', body: 'Closes #7', head: 'bothub/7-fix' },
    { kind: 'label', add: ['bug'] },
  ],
  errors: [],
  accepted: [{ kind: 'push', branch: 'bothub/7-fix', files: ['src/b.ts'] }],
  rejected: [{ proposal: { kind: 'label', add: ['bug'] }, reason: 'the job may not label' }],
  results: [
    { kind: 'push', status: 'applied', sha: 'abcdef0123456789' },
    { kind: 'open-pr', status: 'applied', url: 'https://github.com/acme/app/pull/8' },
  ],
  applied: true,
  checks: [
    { check: 'tests', gating: true, pass: false, findings: 'src/b.ts:3 expected 1\nreceived 2' },
    { check: 'style', gating: false, pass: false },
    { check: 'types', gating: true, pass: true },
  ],
};

const transcript = events(
  { type: 'start', model: 'sonnet' },
  { type: 'tool_call', id: '1', tool: 'Read', input: { file_path: 'src/a.ts' } },
  { type: 'tool_call', id: '2', tool: 'Edit', input: { file_path: 'src/a.ts' } },
  { type: 'tool_call', id: '3', tool: 'apply_patch', input: { changes: [{ path: 'src/c.ts', kind: 'add' }] } },
  { type: 'tool_call', id: '4', tool: 'Edit', input: { file_path: 'src/a.ts' } },
  { type: 'usage', inputTokens: 100, outputTokens: 20 },
  { type: 'usage', inputTokens: 50, outputTokens: 5 },
  { type: 'end', ok: true }
);

describe('summarize', () => {
  it('records what was tried, failed, rejected and landed', () => {
    expect(summarize(run(), transcript, outcome)).toEqual({
      runId: 'r1',
      workflow: 'implement',
      job: 'code',
      bot: 'coder',
      status: 'succeeded',
      closure: 'done',
      attempt: 2,
      tools: { Read: 1, Edit: 2, apply_patch: 1 },
      proposed: ['push bothub/7-fix (1 files)', 'open-pr "Fix the thing"', 'label +bug'],
      failed: [
        { check: 'tests', gating: true, findings: 'src/b.ts:3 expected 1\nreceived 2' },
        { check: 'style', gating: false, findings: 'failed without output' },
      ],
      landed: [
        { kind: 'push', sha: 'abcdef0123456789' },
        { kind: 'open-pr', url: 'https://github.com/acme/app/pull/8' },
      ],
      rejected: ['label +bug: the job may not label'],
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      durationMs: 192_000,
      tokens: { input: 150, output: 25 },
      costUsd: 0.125,
    });
  });

  it('handles a run without outcome or timestamps', () => {
    const memory = summarize(untimed(run({ status: 'failed', error: 'boom' })), [], undefined);
    expect(memory).toMatchObject({
      status: 'failed',
      error: 'boom',
      tools: {},
      files: [],
      tokens: { input: 0, output: 0 },
    });
    expect(memory.durationMs).toBeUndefined();
  });

  it('falls back to event timestamps for the duration', () => {
    const memory = summarize(untimed(run()), transcript, undefined);
    expect(memory.durationMs).toBe(7000);
  });
});

describe('renderMemory', () => {
  it('renders short Markdown', () => {
    expect(renderMemory(summarize(run(), transcript, outcome))).toBe(
      [
        '# implement/code run r1',
        '',
        'bot coder, status succeeded, closure done, attempt 2',
        'took 3m 12s, 150 tokens in, 25 out, $0.13',
        '',
        '## Tried',
        '- Tools: Read (1), Edit (2), apply_patch (1)',
        '- Proposed push bothub/7-fix (1 files)',
        '- Proposed open-pr "Fix the thing"',
        '- Proposed label +bug',
        '',
        '## Failed',
        '- tests: src/b.ts:3 expected 1 received 2',
        '- style (shadow): failed without output',
        '',
        '## Rejected',
        '- label +bug: the job may not label',
        '',
        '## Landed',
        '- push abcdef012345',
        '- open-pr https://github.com/acme/app/pull/8',
        '',
        '## Files',
        '- src/a.ts',
        '- src/b.ts',
        '- src/c.ts',
        '',
      ].join('\n')
    );
  });
});

describe('writeMemory and recentMemory', () => {
  it('writes to runs/<id>/memory.md and reads back the newest matching memories', async () => {
    const files = new Map<string, string>();
    const runs = [
      run({ id: 'r4', bot: 'gardener' }),
      run({ id: 'r3' }),
      run({ id: 'r2', workflow: 'triage' }),
      run({ id: 'r1' }),
      run({ id: 'r0' }),
    ];
    const store = {
      list: async () => runs,
      memory: async (id: string) => files.get(memoryPath(id)),
      saveMemory: async (id: string, text: string) => void files.set(memoryPath(id), text),
    };
    for (const r of runs.filter(r => r.id !== 'r1')) await writeMemory(store, r, [], undefined);
    expect(memoryPath('r3')).toBe('runs/r3/memory.md');
    expect(files.get('runs/r3/memory.md')).toContain('# implement/code run r3');

    const recent = await recentMemory(store, { bot: 'coder', workflow: 'implement' }, 2);
    expect(recent.map(m => m.runId)).toEqual(['r3', 'r0']);
    expect((await recentMemory(store, { workflow: 'triage' })).map(m => m.runId)).toEqual(['r2']);
  });
});
