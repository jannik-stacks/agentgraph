import { describe, expect, it } from 'vitest';
import board from '../examples/board/plugins/board.ts';
import type { HookContext } from '../src/plugin.ts';

const settings = {
  project: 'acme/3',
  fields: { Status: { 'needs-review': 'In Review' }, Needs: { 'needs-answer': 'Stuck' } },
};

const fake = () => {
  const calls: unknown[][] = [];
  const context: HookContext<typeof settings> = {
    repo: 'acme/app',
    settings,
    tracker: { searchIssues: async () => [], writeField: async (...args) => void calls.push(args) },
  };
  return { calls, context };
};

describe('the board plugin', () => {
  it('writes the mapped option of each field', async () => {
    const { calls, context } = fake();
    await board.on!.status!({ issue: 7, repo: 'acme/app', from: 'working', to: 'needs-answer' }, context);
    expect(calls).toEqual([
      [7, { project: 'acme/3', field: 'Status', value: null }],
      [7, { project: 'acme/3', field: 'Needs', value: 'Stuck' }],
    ]);
  });

  it('clears a field that has no option for the status', async () => {
    const { calls, context } = fake();
    await board.on!.status!({ issue: 7, repo: 'acme/app', from: 'needs-answer', to: 'done' }, context);
    expect(calls).toEqual([
      [7, { project: 'acme/3', field: 'Status', value: null }],
      [7, { project: 'acme/3', field: 'Needs', value: null }],
    ]);
  });

  it('refuses a tracker that has no project boards, before any write', async () => {
    const { calls, context } = fake();
    const { writeField: _, ...folder } = context.tracker;
    const change = { issue: 7, repo: 'acme/app', to: 'needs-review' } as const;
    await expect(board.on!.status!(change, { ...context, tracker: folder })).rejects.toThrow(
      'needs a tracker with project boards'
    );
    expect(calls).toEqual([]);
  });
});
