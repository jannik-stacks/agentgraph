import { describe, expect, it } from 'vitest';
import { proposeStatusUpdates, type IssueWithPull } from '../src/context.ts';
import type { Issue } from '../src/event.ts';
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
const holding = (body: string, pull?: Issue): IssueWithPull => ({
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
const getCommentBody = (r: Run, t: IssueWithPull = holding('')) => {
  const p = proposeStatusUpdates(r, t).find(p => p.kind === 'comment');
  return p?.kind === 'comment' ? p.body : undefined;
};

describe('the status comment', () => {
  it('is not edited while only tries and rounds move', () => {
    const t = holding(getCommentBody(run)!);
    const ticks = [{ tries: 1 }, { tries: 2 }, { rounds: { review: 1 } }, { tries: 1, rounds: { review: 2 } }];
    expect(ticks.flatMap(tick => proposeStatusUpdates({ ...run, ...tick }, t))).toEqual([]);
  });

  it('links the run in the studio, where tries, rounds and cost so far show', () => {
    const body = proposeStatusUpdates(run, holding(''), 'http://studio:5492/').find(p => p.kind === 'comment');
    expect(body).toMatchObject({
      body: expect.stringContaining('[Progress in the studio](http://studio:5492/runs/issue-7)'),
    });
    const t = holding((body as { body: string }).body);
    expect(proposeStatusUpdates({ ...run, tries: 2 }, t, 'http://studio:5492/')).toEqual([]);
  });

  it('is not edited when the forge reads it back with its run stamp', () => {
    const body = getCommentBody(run)!;
    expect(proposeStatusUpdates(run, holding(`${body}\n\n[⁂](http://studio/runs/issue-7?at=1) `))).toEqual([]);
    expect(proposeStatusUpdates(run, holding(`${body}\n\n<!-- agentgraph run=issue-7 step=implement -->`))).toEqual([]);
  });

  it('is edited when the step, status, question, pull request or result changes', () => {
    const t = holding(getCommentBody(run)!);
    const pr: Issue = {
      ...issue,
      number: 8,
      url: 'https://github.com/o/r/pull/8',
      pull: { branch: 'b', base: 'main', head: 'h' },
    };
    expect(getCommentBody({ ...run, step: 'review' }, t)).toBe('Working on review.');
    expect(getCommentBody({ ...run, status: 'waiting', reason: 'Which one?' }, t)).toMatch(/^Waiting for an answer/);
    expect(
      getCommentBody({ ...run, status: 'waiting', reason: 'Stopped by a runner error (SessionStop).' }, t)
    ).toMatch(/^Stopped by a runner error at implement\./);
    expect(getCommentBody(run, holding(getCommentBody(run)!, pr))).toContain(`Pull request: ${pr.url}`);
    expect(getCommentBody({ ...run, status: 'done' }, t)).toMatch(/^Done\./);
    const done = proposeStatusUpdates({ ...run, status: 'done' }, t, undefined, 2).find(p => p.kind === 'comment');
    expect(done?.kind === 'comment' && done.body).toMatch(/Cost: \$2\.00\./);
  });
});
