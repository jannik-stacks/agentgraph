import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localIssues } from '../src/issues-local.ts';
import { accepted, answersAfterBrief, issueContext, recallQuery, runContext } from '../src/preload.ts';
import type { Bot } from '../src/schema.ts';
import type { BotEvent } from '../src/types.ts';
import { temp } from './kit.ts';

const event: BotEvent = {
  id: 'e',
  ts: 't',
  source: 'local',
  trigger: 'issue_comment',
  repo: 'a/b',
  number: 6,
  actor: { login: 'morgan', association: 'OWNER' },
};

describe('runContext', () => {
  const bot = {
    name: 'b',
    path: 'bots/b.md',
    harness: 'opencode',
    tools: ['read', 'notes_search'],
    returns: ['reply', 'note', 'hub(notes/**)'],
    role: '',
  } as Bot;

  it('preloads nothing by default and narrows what the bot returns to the step', () => {
    expect(runContext({ bot })).toEqual({
      preload: [],
      harnessTools: ['read'],
      hubTools: ['notes_search'],
      returns: ['reply', 'note', 'hub(notes/**)'],
    });
    expect(runContext({ bot, step: { over: 'diff', preload: ['issue'], returns: ['reply'] } })).toEqual({
      over: 'diff',
      preload: ['issue'],
      harnessTools: ['read'],
      hubTools: ['notes_search'],
      returns: ['reply'],
    });
  });

  it('counts a note in force when accepted or without a status', () => {
    const note = (status?: 'proposed' | 'accepted' | 'retired') => ({ ...(status && { status }) }) as never;
    expect([undefined, 'accepted', 'proposed', 'retired'].map(s => accepted(note(s as never)))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('issueContext', () => {
  it('renders the issue with comments, then its parent, links and sub-issues', async () => {
    const dir = temp('issues');
    const file = (name: string, front: string, body: string) =>
      writeFileSync(join(dir, name), `---\n${front}\n---\n\n${body}\n`);
    file('4-spec.md', 'title: Spec\nlabels: [spec]', 'The spec.');
    file('5-plan.md', 'title: Plan\nlabels: [plan]\nlinks: [4]', 'The plan.');
    file(
      '6-step.md',
      'title: Step\nparent: 5\nlinks: [4]',
      'Do the step.\n\n## @morgan at 2026-10-12T10:00:00.000Z\n\n/bothub'
    );
    file('7-sub.md', 'title: Sub\nparent: 6\nstate: closed', 'Done.');
    const issues = localIssues(dir, { repo: 'a/b' });
    expect(await issueContext(issues, event, ['issue', 'links'])).toBe(
      [
        '## Issue #6: Step',
        'State: open. Parent: #5. Links: #4',
        'Do the step.',
        '### @morgan at 2026-10-12T10:00:00.000Z\n\n/bothub',
        '## Linked issues',
        '### #5: Plan',
        'State: open. Labels: plan. Links: #4',
        'The plan.',
        '### #4: Spec',
        'State: open. Labels: spec',
        'The spec.',
        '### Sub-issues\n\n- [x] #7: Sub',
      ].join('\n\n')
    );
    expect(await issueContext(issues, event, ['recall'])).toBeUndefined();
    expect(await issueContext(undefined, event, ['issue'])).toBeUndefined();
  });

  it('carries a question a bot asked and the answer given on it into the next run of the issue', async () => {
    const issues = localIssues(temp('issues'), { repo: 'a/b' });
    const task = await issues.create({ title: 'Amount helpers', body: 'Add them.' });
    const question = await issues.create({
      title: 'Reject extra decimals?',
      body: 'Should parsing reject more than six decimals?',
      labels: ['unsure'],
      parent: task.number,
    });
    await issues.create({ title: 'Unrelated step', body: 'Not a question.', parent: task.number });
    await issues.comment(question.number, 'Reject them with an error.');
    const context = await issueContext(issues, { ...event, number: task.number }, ['issue']);
    expect(context).toContain('## Questions asked on this issue');
    expect(context).toContain(`### #${question.number}: Reject extra decimals?`);
    expect(context).toContain('Should parsing reject more than six decimals?');
    expect(context).toMatch(/#### @\S+ at \S+\n\nReject them with an error\./);
    expect(context).not.toContain('Unrelated step');
  });

  it('leaves the questions out when nothing was asked', async () => {
    const dir = temp('issues');
    writeFileSync(join(dir, '6-step.md'), '---\ntitle: Step\n---\n\nDo it.\n');
    const issues = localIssues(dir, { repo: 'a/b' });
    expect(await issueContext(issues, event, ['issue'])).toBe('## Issue #6: Step\n\nState: open\n\nDo it.');
    expect(await issueContext(issues, { ...event, number: 99 }, ['issue'])).toBeUndefined();
  });
});

describe('answersAfterBrief', () => {
  it('collects human answers on the issue and its questions after the latest brief, without the command', async () => {
    const dir = temp('issues');
    const said = (author: string, minute: number, body: string) =>
      `## @${author} at 2026-10-14T07:0${minute}:00.000Z\n\n${body}`;
    const file = (name: string, front: string, ...parts: string[]) =>
      writeFileSync(join(dir, name), `---\n${front}\n---\n\n${parts.join('\n\n')}\n`);
    file(
      '6-step.md',
      'title: Titles',
      'Keep titles whole.',
      said('morgan', 1, 'Old answer.'),
      said('bothub[bot]', 2, 'Brief.\n\n<!-- bothub:e/issue/triage/reply-1 -->'),
      said('morgan', 3, '/bothub'),
      said('bothub[bot]', 4, 'A bot note.'),
      said('morgan', 6, '/bothub Keep the full question in the body.')
    );
    file(
      '7-cut.md',
      'title: Cut?\nlabels: [unsure]\nparent: 6',
      'Cut long titles?',
      said('morgan', 5, 'Yes, at a sentence boundary.')
    );
    file('8-other.md', 'title: Other\nparent: 6', 'A step.', said('morgan', 7, 'Not an answer.'));
    const issues = localIssues(dir, { repo: 'a/b' });
    expect(await answersAfterBrief(issues, event, 'issue', ['triage'])).toEqual([
      'Keep the full question in the body.',
      'Yes, at a sentence boundary.',
    ]);
    expect(await answersAfterBrief(issues, event, 'issue', ['review'])).toEqual([]);
    expect(await answersAfterBrief(issues, event, 'issue', [])).toEqual([]);
  });
});

describe('recallQuery', () => {
  const issue = '## Issue #7: Task\n\nState: open\n\nDo it.';
  const context = (job: string) =>
    `${issue}\n\n### @bot at 2026-01-01\n\nTouch src/fees.ts only.\n\n<!-- bothub:e1/issue/${job}/reply-1 -->`;

  it('searches with the brief of a job the step needs, without its marker', () => {
    expect(recallQuery(context('triage'), 'issue', ['triage'])).toBe('Touch src/fees.ts only.');
  });

  it('falls back to the issue without a brief it needs', () => {
    expect(recallQuery(context('review'), 'issue', ['triage'])).toBe(issue);
    expect(recallQuery(context('triage'), 'issue', [])).toBe(issue);
  });

  it('has nothing to search with without the issue', () => {
    expect(recallQuery(undefined, 'issue', ['triage'])).toBeUndefined();
    expect(recallQuery('## Linked issues\n\nmore', 'issue', ['triage'])).toBeUndefined();
  });
});
