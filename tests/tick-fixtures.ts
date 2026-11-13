import { Effect } from 'effect';
import { Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { makeTestGraph } from './fixtures.ts';
import { type world, pullRequest } from './world.ts';

export const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
export const issue = small.workflows.issue!;
export const merging = {
  ...small,
  workflows: {
    issue: {
      ...issue,
      steps: [
        ...issue.steps,
        { name: 'merge', does: { wait: 'human' as const }, checks: [], tries: 1, back: { to: 'implement' } },
      ],
    },
  },
};
export const waiting = (where: ReturnType<typeof world>) => {
  pullRequest(where);
  return Effect.flatMap(Store, s =>
    s.put({
      ...begin(merging.workflows.issue, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
      step: 'merge',
      status: 'waiting',
      sessions: { implement: { id: 'a', home: '/homes/a' } },
    })
  );
};
