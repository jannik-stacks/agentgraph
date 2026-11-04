import { describe, expect, it } from 'vitest';
import board from '../examples/board/plugins/board.ts';
import type { HookContext } from '../src/plugin.ts';

const settings = { project: 'acme/3', status: { 'needs-review': 'In Review' } };

const fake = () => {
  const calls: unknown[][] = [];
  const context: HookContext<typeof settings> = {
    repo: 'acme/app',
    settings,
    tracker: { searchIssues: async () => [], moveToColumn: async (...args) => void calls.push(args) },
  };
  return { calls, context };
};

describe('the board plugin', () => {
  it('moves the issue to the mapped Status option', async () => {
    const { calls, context } = fake();
    await board.on!.status!({ issue: 7, repo: 'acme/app', from: 'working', to: 'needs-review' }, context);
    expect(calls).toEqual([[7, { project: 'acme/3', name: 'In Review' }]]);
  });

  it('does nothing for an unmapped status', async () => {
    const { calls, context } = fake();
    await board.on!.status!({ issue: 7, repo: 'acme/app', to: 'done' }, context);
    expect(calls).toEqual([]);
  });

  it('refuses a tracker that has no project boards, before any move', async () => {
    const { calls, context } = fake();
    const { moveToColumn: _, ...folder } = context.tracker;
    const change = { issue: 7, repo: 'acme/app', to: 'needs-review' } as const;
    await expect(board.on!.status!(change, { ...context, tracker: folder })).rejects.toThrow(
      'needs a tracker with project boards'
    );
    expect(calls).toEqual([]);
  });
});
