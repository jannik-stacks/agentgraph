import { describe, expect, it } from 'vitest';
import { proposeStatusUpdates, stoppedByRunner, type IssueWithPull } from '../src/context.ts';
import { type Issue } from '../src/event.ts';
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
      body: expect.stringContaining('[Open](http://studio:5492/runs/issue-7)'),
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
    expect(getCommentBody({ ...run, step: 'review' }, t)).toContain('| issue / review | working |');
    expect(getCommentBody({ ...run, status: 'waiting', reason: 'Which one?' }, t)).toContain(
      'waiting for your answer below'
    );
    expect(
      getCommentBody({ ...run, status: 'waiting', reason: 'Stopped by a runner error (SessionStop).' }, t)
    ).toContain('paused on an agentgraph problem, not this change; reply `/agent` to retry');
    expect(getCommentBody(run, holding(getCommentBody(run)!, pr))).toContain(pr.url);
    expect(getCommentBody({ ...run, status: 'done' }, t)).toContain('Agentgraph status: done');
    const done = proposeStatusUpdates({ ...run, status: 'done' }, t, undefined, 2).find(p => p.kind === 'comment');
    expect(done?.kind === 'comment' && done.body).toContain('$2.00');
  });
  it('edits the shared sticky when running cost changes', () => {
    const first = proposeStatusUpdates(run, holding(''), undefined, 0.12).find(p => p.kind === 'comment')!;
    const next = proposeStatusUpdates(run, holding(first.body), undefined, 0.34).find(p => p.kind === 'comment');
    expect(next).toMatchObject({ edit: 'c1', body: expect.stringContaining('$0.34') });
  });

  it('keeps the per-run table inside the common footer', () => {
    const body = getCommentBody(run)!;
    expect(body.split('\n\n')[0]).toBe('Agentgraph status: working');
    expect(body).toMatch(/<details><summary>⁂<\/summary>\n\n\| Workflow \/ step \|[\s\S]*<\/details>$/);
  });
  it('shows the latest failing checks with the pull request inside the table', () => {
    const t = holding('', { ...issue, number: 8, url: 'https://github.com/o/r/pull/8' });
    t.pull!.events = ['failure', 'success', 'timed_out'].map((conclusion, i) => ({
      issue: 8,
      kind: 'check',
      actor: 'ci',
      trusted: false,
      at: String(i),
      check: { name: i < 2 ? 'types' : 'tests', conclusion },
    }));
    expect(getCommentBody(run, t)).toContain('| https://github.com/o/r/pull/8 | tests |');
  });
});

const label = (r: Run, others: Run[] = []) =>
  proposeStatusUpdates(
    r,
    holding(''),
    undefined,
    0,
    others.map(o => ({ run: o, t: holding(''), usd: 0 }))
  ).find(p => p.kind === 'label');

describe('the status label', () => {
  it('swaps the previous status label for the one the runs are in', () => {
    expect(label({ ...run, status: 'waiting' })).toEqual({
      kind: 'label',
      add: ['agentgraph:needs-review'],
      remove: ['agentgraph:working'],
    });
    expect(label({ ...run, status: 'waiting', reason: 'Which one?' })?.add).toEqual(['agentgraph:needs-answer']);
    expect(label({ ...run, status: 'waiting', reason: `${stoppedByRunner}: x` })?.add).toEqual([
      'agentgraph:needs-answer',
    ]);
    expect(label({ ...run, status: 'done' })?.add).toEqual(['agentgraph:done']);
    expect(label({ ...run, status: 'stopped', reason: 'no' })?.add).toEqual(['agentgraph:stopped']);
  });

  it('is left alone when the issue already shows it', () => {
    expect(label(run)).toBeUndefined();
    const child = { ...run, id: 'child', by: 'issue-7', started: '2026-10-22T11:00:00Z' };
    expect(label({ ...run, status: 'waiting', reason: 'waiting on child' }, [child])).toBeUndefined();
  });
});
