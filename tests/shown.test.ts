import { describe, expect, it } from 'vitest';
import { context, findIssueStatus, proposeUpdates, stoppedByRunner, type IssueWithPull } from '../src/context.ts';
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
};
const issue: Issue = { number: 7, title: 't', body: '', state: 'open', labels: [], author: 'a', url: '' };
const pr: Issue = {
  ...issue,
  number: 8,
  url: 'https://github.com/o/r/pull/8',
  pull: { branch: 'b', base: 'main', head: 'h' },
};
const spoke = (actor: string, trusted = true) => ({
  issue: 7,
  kind: 'comment' as const,
  actor,
  trusted,
  at: '2026-10-22T10:01:00Z',
  comment: { id: actor, author: actor, body: '/agent go', at: '2026-10-22T10:01:00Z' },
});
const on = (pull?: Issue, events = [spoke('maintainer'), spoke('bot[bot]')]): IssueWithPull => ({
  issue: { ...issue, events },
  ...(pull && { pull: { ...pull, events: [] } }),
});
const bodies = (before: Run | undefined, now: Run, t = on(), branch = true, runs: Run[] = []) =>
  proposeUpdates(before, now, t, runs, branch, 'http://studio:5492/').map(p => (p.kind === 'comment' ? p.body : ''));

describe('the issue status', () => {
  it('comes from the runs on the issue', () => {
    expect(findIssueStatus([run], false)).toBe('working');
    expect(findIssueStatus([{ ...run, status: 'waiting' }], true)).toBe('needs-review');
    expect(findIssueStatus([{ ...run, status: 'waiting' }], false)).toBe('needs-answer');
    expect(findIssueStatus([{ ...run, status: 'waiting', reason: 'Which one?' }], true)).toBe('needs-answer');
    expect(findIssueStatus([{ ...run, status: 'waiting', reason: `${stoppedByRunner}.` }], true)).toBe('needs-answer');
    expect(findIssueStatus([{ ...run, status: 'done' }], true)).toBe('done');
    expect(findIssueStatus([], true)).toBeUndefined();
  });

  it('ranks a question over a review over work, else takes the newest run', () => {
    const later = { ...run, id: 'later', started: '2026-10-22T11:00:00Z' };
    expect(
      findIssueStatus(
        [
          { ...run, status: 'waiting' },
          { ...later, status: 'waiting', reason: 'q' },
        ],
        true
      )
    ).toBe('needs-answer');
    expect(findIssueStatus([{ ...run, status: 'waiting' }, later], true)).toBe('needs-review');
    expect(
      findIssueStatus(
        [
          { ...later, status: 'stopped' },
          { ...run, status: 'done' },
        ],
        true
      )
    ).toBe('stopped');
  });

  it('counts a run waiting on a run it started as working', () => {
    const child = { ...run, id: 'child', by: run.id, status: 'done' as const };
    expect(findIssueStatus([{ ...run, status: 'waiting', reason: 'waiting on child' }, child], true)).toBe('working');
  });
});

describe('the updates', () => {
  it('say nothing while a run works or moves between steps', () => {
    expect(bodies(run, { ...run, tries: 2 })).toEqual([]);
    expect(bodies(undefined, run)).toEqual([]);
    expect(bodies(run, { ...run, step: 'review', status: 'waiting' }, on(pr))).toEqual([]);
  });

  it('say done and stopped once, with the pull request and the studio run', () => {
    expect(bodies(run, { ...run, status: 'done' }, on(pr))).toEqual([
      'Done.\n\nPull request: https://github.com/o/r/pull/8\nRun: http://studio:5492/runs/issue-7',
    ]);
    expect(bodies({ ...run, status: 'done' }, { ...run, status: 'done' }, on(pr))).toEqual([]);
    expect(bodies(run, { ...run, status: 'stopped', reason: 'Spent $3.' })).toEqual([
      'Stopped.\n\nSpent $3.\n\nRun: http://studio:5492/runs/issue-7',
    ]);
    expect(bodies(run, { ...run, status: 'stopped', restarted: true })).toEqual([]);
  });

  it('leave done and stopped to the replies of a workflow without a branch', () => {
    expect(bodies(run, { ...run, status: 'done' }, on(pr), false)).toEqual([]);
    expect(bodies(run, { ...run, status: 'stopped', reason: 'x' }, on(), false)).toEqual([]);
  });

  it('ask a new question once, mentioning who last spoke', () => {
    const asked = { ...run, status: 'waiting' as const, reason: 'Which one?' };
    expect(bodies(run, asked, on(), false)).toEqual([
      '@maintainer Which one?\n\nReply `/agent` and your answer, or `/agent:stop` to end the run.\n\nRun: http://studio:5492/runs/issue-7',
    ]);
    expect(bodies(asked, asked)).toEqual([]);
    expect(bodies(asked, { ...asked, reason: 'Which one?\n\nAnd where?' })[0]).toMatch(
      /^@maintainer Which one\?\n\nAnd where\?\n\n/
    );
    expect(bodies(run, asked, on(undefined, [spoke('stranger', false)]))[0]).toMatch(/^@a Which one\?/);
  });

  it('say a parked run waits on a retry, and nothing for a run waiting on its own child', () => {
    const parked = { ...run, status: 'waiting' as const, reason: `${stoppedByRunner}.`, retried: true as const };
    expect(bodies(run, parked)[0]).toBe(
      '@maintainer Paused on an agentgraph problem, not this change. Reply `/agent` to retry.\n\nRun: http://studio:5492/runs/issue-7'
    );
    const child = { ...run, id: 'child', by: run.id };
    expect(bodies(run, { ...run, status: 'waiting', reason: 'waiting on child' }, on(), true, [child])).toEqual([]);
  });
});

describe('the agent context', () => {
  it('leaves out the updates and shrinks older entries past its size cap', () => {
    const said = (actor: string, body: string, at: string) => ({
      ...spoke(actor),
      at,
      comment: { id: at, author: actor, body, at },
    });
    const long = `${'a'.repeat(200)}\n${'b'.repeat(30_000)}`;
    const text = context({
      issue: {
        ...issue,
        events: [
          said('maintainer', long, '2026-10-22T10:01:00Z'),
          said('bot[bot]', 'Done.\n\nRun: http://studio:5492/runs/issue-7', '2026-10-22T10:02:00Z'),
          said('maintainer', 'Thanks', '2026-10-22T10:03:00Z'),
        ],
      },
    });
    expect(text).not.toContain('Done.');
    expect(text).not.toContain('b'.repeat(10));
    expect(text).toContain(`${'a'.repeat(100)}`);
    expect(text).toContain('Thanks');
  });
});
