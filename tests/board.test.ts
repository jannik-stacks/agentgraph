import { describe, expect, it } from 'vitest';
import board from '../examples/board/plugins/board.ts';
import type { HookContext } from '../src/plugin.ts';

const settings = { project: 'acme/3', status: { 'needs-review': 'In Review' } };

const fake = (items: { id: string; project: { id: string } }[]) => {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const context: HookContext<typeof settings> = {
    repo: 'acme/app',
    settings,
    forge: {
      searchIssues: async () => [],
      graphql: async (query, variables) => {
        calls.push({ query, variables });
        if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: 'item-new' } } };
        if (query.includes('updateProjectV2ItemFieldValue')) return {};
        return {
          repository: { issue: { id: 'issue-7', projectItems: { nodes: items } } },
          repositoryOwner: {
            projectV2: {
              id: 'project-3',
              field: { id: 'field-status', options: [{ id: 'opt-review', name: 'In Review' }] },
            },
          },
        };
      },
    },
  };
  return { calls, context };
};

describe('the board plugin', () => {
  it('moves the issue on the project to the mapped Status option, adding it when missing', async () => {
    const { calls, context } = fake([{ id: 'item-other', project: { id: 'project-9' } }]);
    await board.on!.status!({ issue: 7, repo: 'acme/app', from: 'working', to: 'needs-review' }, context);
    expect(calls.map(c => c.variables)).toEqual([
      { owner: 'acme', name: 'app', issue: 7, login: 'acme', number: 3 },
      { project: 'project-3', content: 'issue-7' },
      { project: 'project-3', item: 'item-new', field: 'field-status', option: 'opt-review' },
    ]);
  });

  it('reuses the existing item', async () => {
    const { calls, context } = fake([{ id: 'item-7', project: { id: 'project-3' } }]);
    await board.on!.status!({ issue: 7, repo: 'acme/app', to: 'needs-review' }, context);
    expect(calls.at(-1)?.variables).toMatchObject({ item: 'item-7' });
    expect(calls).toHaveLength(2);
  });

  it('does nothing for an unmapped status', async () => {
    const { calls, context } = fake([]);
    await board.on!.status!({ issue: 7, repo: 'acme/app', to: 'done' }, context);
    expect(calls).toEqual([]);
  });
});
