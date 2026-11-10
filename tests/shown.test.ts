import { describe, expect, it } from 'vitest';
import {
  context,
  findIssueStatus,
  formatStatusHeader,
  proposeQuestion,
  stoppedByEngine,
  type IssueWithPull,
} from '../src/context.ts';
import { formatRunMark, makeBodyWithStatus, removeRunLink, type Issue } from '../src/event.ts';
import { type Run } from '../src/types.ts';

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
  id: actor,
  bot: actor.endsWith('[bot]'),
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
const bodies = (before: Run | undefined, now: Run, t = on(), runs: Run[] = []) =>
  proposeQuestion(before, now, t, runs, 'http://studio:5492/').map(p => p.body);

describe('the issue status', () => {
  it('comes from the runs on the issue', () => {
    expect(findIssueStatus([run], false)).toBe('working');
    expect(findIssueStatus([{ ...run, status: 'waiting' }], true)).toBe('needs-review');
    expect(findIssueStatus([{ ...run, status: 'waiting' }], false)).toBe('needs-answer');
    expect(findIssueStatus([{ ...run, status: 'waiting', reason: 'Which one?' }], true)).toBe('needs-answer');
    expect(findIssueStatus([{ ...run, status: 'waiting', reason: `${stoppedByEngine}.` }], true)).toBe('needs-answer');
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

describe('the question', () => {
  it('is the only comment: nothing while a run works, moves, opens a pull request, ends or stops', () => {
    expect(bodies(run, { ...run, tries: 2 })).toEqual([]);
    expect(bodies(undefined, run)).toEqual([]);
    expect(bodies(run, { ...run, step: 'review', status: 'waiting' }, on(pr))).toEqual([]);
    expect(bodies(run, { ...run, status: 'done' }, on(pr))).toEqual([]);
    expect(bodies(run, { ...run, status: 'stopped', reason: 'Spent $3.' })).toEqual([]);
  });

  it('is asked once, mentioning who last spoke', () => {
    const asked = { ...run, status: 'waiting' as const, reason: 'Which one?' };
    expect(bodies(run, asked, on())).toEqual([
      '@maintainer Which one?\n\nReply `/agent` and your answer, or `/agent:stop` to end the run.\n\nRun: http://studio:5492/runs/issue-7',
    ]);
    expect(bodies(asked, asked)).toEqual([]);
    expect(bodies(asked, { ...asked, reason: 'Which one?\n\nAnd where?' })[0]).toMatch(
      /^@maintainer Which one\?\n\nAnd where\?\n\n/
    );
    expect(bodies(run, asked, on(undefined, [spoke('stranger', false)]))[0]).toMatch(/^@a Which one\?/);
  });

  it('says a parked run waits on a retry, and nothing for a run waiting on its own child', () => {
    const parked = { ...run, status: 'waiting' as const, reason: `${stoppedByEngine}.`, retried: true as const };
    expect(bodies(run, parked)[0]).toBe(
      '@maintainer Paused on an agentgraph problem, not this change. Reply `/agent` to retry.\n\nRun: http://studio:5492/runs/issue-7'
    );
    const child = { ...run, id: 'child', by: run.id };
    expect(bodies(run, { ...run, status: 'waiting', reason: 'waiting on child' }, on(), [child])).toEqual([]);
  });
});

describe('the status header', () => {
  const three = () => ['plan', 'implement', 'review'];
  const header = (runs: Run[], pulled = false, steps = three) =>
    formatStatusHeader(runs, pulled, steps, () => 0.4215, {
      pull: 'https://github.com/o/r/pull/8',
      studio: 'http://studio:5492/',
    });
  const line = (runs: Run[], pulled = false, steps = three) => header(runs, pulled, steps).split('\n')[0];

  it('names the status in one line, with the step and where it is among the steps', () => {
    expect(line([run])).toBe('※ working on implement (2 of 3)');
    expect(line([{ ...run, step: 'review', status: 'waiting' }], true)).toBe('※ waiting for review at review (3 of 3)');
    expect(line([{ ...run, step: 'plan', status: 'waiting', reason: 'Which?' }])).toBe(
      '※ waiting for an answer at plan (1 of 3)'
    );
    expect(line([{ ...run, status: 'stopped' }])).toBe('※ stopped at implement (2 of 3)');
    expect(line([{ ...run, status: 'done' }])).toBe('※ 3 of 3 steps done');
    expect(line([{ ...run, status: 'done' }], false, () => ['implement'])).toBe('※ done');
    expect(line([run], false, () => ['implement'])).toBe('※ working on implement');
    expect(header([])).toBe('');
  });

  it('keeps the runs in a collapsed table after the line', () => {
    expect(header([{ ...run, checkout: { branch: 'b', base: 'main' } }], true)).toBe(
      [
        '※ working on implement (2 of 3)',
        '<details><summary>Runs</summary>',
        '| Workflow | Step | State | Cost | Pull request | Studio |\n| --- | --- | --- | --- | --- | --- |\n| issue | implement | running | $0.42 | https://github.com/o/r/pull/8 | [issue-7](http://studio:5492/runs/issue-7) |',
        '</details>',
      ].join('\n\n')
    );
  });

  it('replaces only its own section at the top of a body, and removes it when empty', () => {
    const once = makeBodyWithStatus('Human text.\n\nMore.', '※ done');
    expect(once).toBe('<!-- agentgraph status -->\n※ done\n<!-- end agentgraph status -->\n\nHuman text.\n\nMore.');
    const edited = once.replace('More.', 'More, edited.');
    expect(makeBodyWithStatus(edited, '※ working on x')).toBe(
      '<!-- agentgraph status -->\n※ working on x\n<!-- end agentgraph status -->\n\nHuman text.\n\nMore, edited.'
    );
    expect(makeBodyWithStatus(once, '※ done')).toBe(once);
    expect(makeBodyWithStatus(once, '')).toBe('Human text.\n\nMore.');
    expect(makeBodyWithStatus('', '※ a $& b')).toBe(
      '<!-- agentgraph status -->\n※ a $& b\n<!-- end agentgraph status -->'
    );
    expect(removeRunLink(once)).toBe('Human text.\n\nMore.');
  });
});

describe('the provenance mark', () => {
  it('ends the last sentence inline, on a line of its own only after a fence, table or HTML', () => {
    expect(formatRunMark('Fixed it.\n', 'http://s/runs/r?at=t')).toBe('Fixed it. [⁂](http://s/runs/r?at=t)');
    expect(formatRunMark('Fixed it.')).toBe('Fixed it. ⁂');
    expect(formatRunMark('```\ncode\n```')).toBe('```\ncode\n```\n\n⁂');
    expect(formatRunMark('| a |\n| - |')).toBe('| a |\n| - |\n\n⁂');
    expect(formatRunMark('x', 'http://s/a(b)')).toBe('x [⁂](http://s/a%28b%29)');
    expect(removeRunLink('Fixed it. [⁂](http://s/runs/r?at=t)\n<!-- agentgraph run=r -->')).toBe('Fixed it.');
    expect(removeRunLink('Fixed it. ⁂\n<!-- agentgraph run=r -->')).toBe('Fixed it.');
  });
});

describe('the agent context', () => {
  it('keeps a bot comment and shrinks older entries past its size cap', () => {
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
    expect(text).toContain('Done.');
    expect(text).not.toContain('b'.repeat(10));
    expect(text).toContain(`${'a'.repeat(100)}`);
    expect(text).toContain('Thanks');
  });
});
