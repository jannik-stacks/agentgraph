import { describe, expect, it } from 'vitest';
import { shown, type Issues } from '../src/context.ts';
import type { Issue } from '../src/forge.ts';
import type { Run } from '../src/workflow.ts';

const run: Run = {
  id: 'issue-7',
  workflow: 'issue',
  issue: 7,
  step: 'implement',
  status: 'running',
  tries: 0,
  rounds: {},
  sessions: {},
  started: '2026-10-22T10:00:00Z',
  usd: 0,
  comment: 'c1',
};
const issue: Issue = {
  number: 7,
  title: 't',
  body: '',
  state: 'open',
  labels: ['agentgraph:working'],
  author: 'a',
  url: '',
};
const holding = (body: string, pull?: Issue): Issues => ({
  issue: {
    ...issue,
    events: [
      {
        issue: 7,
        kind: 'comment',
        actor: 'bot[bot]',
        trusted: false,
        at: run.started,
        comment: { id: 'c1', author: 'bot[bot]', body, at: run.started },
      },
    ],
  },
  ...(pull && { pull: { ...pull, events: [] } }),
});
const bodyOf = (r: Run, t: Issues = holding('')) => {
  const p = shown(r, t).find(p => p.kind === 'comment');
  return p?.kind === 'comment' ? p.body : undefined;
};

describe('the status comment', () => {
  it('is not edited while only tries, rounds and cost move', () => {
    const t = holding(bodyOf(run)!);
    for (const tick of [
      { tries: 1 },
      { tries: 2, usd: 0.42 },
      { rounds: { review: 1 }, usd: 1.5 },
      { tries: 1, rounds: { review: 2 }, usd: 3.25 },
    ])
      expect(shown({ ...run, ...tick }, t)).toEqual([]);
  });

  it('is edited when the step, status, question, pull request or result changes', () => {
    const t = holding(bodyOf(run)!);
    const pr: Issue = {
      ...issue,
      number: 8,
      url: 'https://github.com/o/r/pull/8',
      pull: { branch: 'b', base: 'main', head: 'h' },
    };
    expect(bodyOf({ ...run, step: 'review' }, t)).toBe('Working on review.');
    expect(bodyOf({ ...run, status: 'waiting', reason: 'Which one?' }, t)).toMatch(/^Waiting for an answer/);
    expect(bodyOf(run, holding(bodyOf(run)!, pr))).toContain(`Pull request: ${pr.url}`);
    expect(bodyOf({ ...run, status: 'done', usd: 2 }, t)).toMatch(/^Done\.\n\n.*Cost: \$2\.00\./s);
  });
});
