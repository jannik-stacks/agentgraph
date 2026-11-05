import { describe, expect, it } from 'vitest';
import { makeCommentWithAgentRequest } from '../src/tracker.ts';
import type { Event } from '../src/event.ts';
import type { Graph } from '../src/folder.ts';
import {
  begin,
  cancelled,
  fold,
  pickCommandTarget,
  getEventOutcome,
  makeRunWithFreshRound,
  transition,
  type Outcome,
  type Run,
} from '../src/workflow.ts';
import { fixture } from './fixtures.ts';

// kit issue: triage (1 try), implement (4 tries), review (back to implement, 2 rounds), merge (wait, back to implement)
const w = fixture('kit').workflows.issue!;
const merge = fixture('kit').workflows.merge!;
const session = (id: string) => ({ id, home: `/runs/${id}` });
const start = begin(w, { id: 'r1', issue: 7, started: '2026-10-16T00:00:00Z' });
const at = (step: string, more: Partial<Run> = {}): Run => ({
  ...start,
  step,
  sessions: { triage: session('s-triage'), implement: session('s-implement'), review: session('s-review') },
  ...more,
});
const failed: Outcome = {
  kind: 'failed',
  checks: [{ check: 'types', pass: false, findings: 'x.ts:1 error', ms: 10 }],
  proposals: [],
  problems: ['no agentgraph block'],
};

describe('begin', () => {
  it('starts at the first step, running, with no counters', () => {
    expect(start).toEqual({
      id: 'r1',
      issue: 7,
      started: '2026-10-16T00:00:00Z',
      workflow: 'issue',
      step: 'triage',
      status: 'running',
      tries: 0,
      rounds: {},
      sessions: {},
    });
  });
});

describe('transition, running', () => {
  it('pass: next step, tries reset, a fresh session there, feedback cleared', () => {
    const next = transition(w, at('triage', { tries: 0, feedback: 'x' }), { kind: 'pass' });
    expect(next).toMatchObject({ step: 'implement', status: 'running', tries: 0 });
    expect(next.feedback).toBeUndefined();
    expect(next.sessions.implement).toBeUndefined();
    expect(next.sessions.triage).toEqual(session('s-triage'));
  });

  it('drops successful reply text unless the step carries it', () => {
    const next = transition(w, at('triage', { feedback: 'old result' }), { kind: 'pass', text: 'summary' });
    expect(next.feedback).toBeUndefined();
  });

  it('carries framed reply text forward once, replacing earlier feedback', () => {
    const flow = { ...w, steps: w.steps.map(s => ({ ...s, carry: s.name === 'triage' })) };
    const text = '| Before | After |';
    const next = transition(flow, at('triage', { feedback: 'old result' }), { kind: 'pass', text });
    expect(next.feedback).toBe(`## What the triage step reported\n\n${text}`);
    expect(transition(w, next, { kind: 'pass' }).feedback).toBeUndefined();
    expect(transition(w, at('review'), { kind: 'back', why: 'capture again' }).feedback).not.toContain(text);
  });

  it('keeps carried reply text on the run, so a restart at a later step gets it again', () => {
    const flow = { ...w, steps: w.steps.map(s => ({ ...s, carry: s.name === 'triage' })) };
    const next = transition(flow, at('triage'), { kind: 'pass', text: 'summary' });
    const stopped = transition(flow, transition(flow, next, { kind: 'pass' }), { kind: 'stop', why: 'restarted' });
    expect(stopped.reported).toEqual({ triage: 'summary' });
    const again = { id: 'r2', issue: 7, started: '2026-10-16T00:01:00Z', reported: { triage: 'summary' } };
    expect(begin(flow, again, flow.steps[1]).feedback).toBe('## What the triage step reported\n\nsummary');
    expect(begin(flow, again).feedback).toBeUndefined();
  });

  it('pass into a wait step: waiting', () => {
    expect(transition(w, at('review'), { kind: 'pass' })).toMatchObject({ step: 'merge', status: 'waiting' });
  });

  it('pass on the last step: done', () => {
    expect(transition(merge, begin(merge, start), { kind: 'pass' })).toMatchObject({ step: 'merge', status: 'done' });
  });

  it('failed with tries left: same step, tries + 1, same session, the failure carried', () => {
    const next = transition(w, at('implement', { tries: 1 }), failed);
    expect(next).toMatchObject({
      step: 'implement',
      status: 'running',
      tries: 2,
      sessions: { implement: session('s-implement') },
    });
    expect(next.feedback).toContain('types: x.ts:1 error\nno agentgraph block\n\nNothing from this reply was applied');
  });

  it('does not say nothing was applied when a proposal landed before another failed', () => {
    const next = transition(w, at('implement'), {
      kind: 'failed',
      checks: [],
      proposals: [{ proposal: { kind: 'comment', body: 'x' }, ok: false, reason: 'forbidden' }],
      problems: [],
    });
    expect(next.feedback).toBe('comment failed: forbidden');
  });

  it('failed with no tries left: waiting with a readable question', () => {
    const next = transition(w, at('implement', { tries: 3 }), failed);
    expect(next).toMatchObject({
      step: 'implement',
      status: 'waiting',
      tries: 4,
      reason:
        'implement failed after 4 tries (checks: types).\n\ntypes: x.ts:1 error\nno agentgraph block\n\nHow should I proceed?',
      feedback: expect.stringContaining('types: x.ts:1 error\nno agentgraph block\n\nNothing from'),
    });
  });

  it('makes structured check findings readable in the question and keeps the raw feedback', () => {
    const findings = '{"at":"x.ts:1","why":"Missing return"}\nplain failure\n{"why":"No size label proposed"}';
    const next = transition(w, at('implement', { tries: 3 }), {
      ...failed,
      checks: [{ check: 'types', pass: false, findings, ms: 10 }],
    });
    expect(next.reason).toBe(
      'implement failed after 4 tries (checks: types).\n\ntypes: x.ts:1: Missing return\nplain failure\nNo size label proposed\nno agentgraph block\n\nHow should I proceed?'
    );
    expect(next.feedback).toContain(`types: ${findings}\nno agentgraph block\n\nNothing from`);
  });

  it('failed on a step with one try: waiting at once', () => {
    expect(transition(w, at('triage'), failed).status).toBe('waiting');
  });

  it('back with rounds left: the target step, its session resumed, the round counted on the owner', () => {
    const next = transition(w, at('review', { tries: 0, rounds: { review: 1 } }), {
      kind: 'back',
      why: 'hunk 2 leaks',
    });
    expect(next).toMatchObject({
      step: 'implement',
      status: 'running',
      tries: 0,
      rounds: { review: 2 },
      sessions: { implement: session('s-implement') },
      feedback: 'the review step sent this back: hunk 2 leaks',
    });
  });

  it('back with no rounds left: waiting, the reason is the question', () => {
    const next = transition(w, at('review', { rounds: { review: 2 } }), { kind: 'back', why: 'hunk 2 leaks' });
    expect(next).toMatchObject({ step: 'review', status: 'waiting', reason: 'hunk 2 leaks', rounds: { review: 2 } });
  });

  it('back on a step without one: counted as a failure with a failed proposal', () => {
    const next = transition(w, at('implement', { tries: 0 }), { kind: 'back', why: 'brief is wrong' });
    expect(next).toMatchObject({ step: 'implement', status: 'running', tries: 1 });
    expect(next.feedback).toBe('back failed: implement has no way back');
  });

  it('ask: waiting, same step, session kept', () => {
    const next = transition(w, at('implement', { tries: 1 }), { kind: 'ask', question: 'which API?' });
    expect(next).toMatchObject({ step: 'implement', status: 'waiting', tries: 1, reason: 'which API?' });
    expect(next.sessions.implement).toEqual(session('s-implement'));
  });

  it('stop: stopped, no try spent', () => {
    const next = transition(w, at('implement', { tries: 1 }), { kind: 'stop', why: 'safety failed' });
    expect(next).toMatchObject({ step: 'implement', status: 'stopped', tries: 1, reason: 'safety failed' });
  });

  it('a script step reruns on a refusal with tries left', () => {
    const next = transition(merge, begin(merge, start), failed);
    expect(next).toMatchObject({ step: 'merge', status: 'running', tries: 1 });
  });
});

describe('transition, waiting', () => {
  const waiting = at('merge', { status: 'waiting' });

  it('pass (merged, approved): next step, or done after the last', () => {
    expect(transition(w, waiting, { kind: 'pass' })).toMatchObject({ step: 'merge', status: 'done' });
  });

  it('back (changes requested, a mention): back.to, its session resumed with the comment', () => {
    const next = transition(w, { ...waiting, rounds: { merge: 5 } }, { kind: 'back', why: 'rename foo' });
    expect(next).toMatchObject({
      step: 'implement',
      status: 'running',
      rounds: { merge: 6 },
      sessions: { implement: session('s-implement') },
      feedback: 'the merge step sent this back: rename foo',
    });
  });

  it('back with the rounds spent parks; what a human says next grants one more round', () => {
    const one = { ...w, steps: w.steps.map(s => (s.name === 'merge' ? { ...s, back: { ...s.back!, rounds: 1 } } : s)) };
    const parked = transition(one, { ...waiting, rounds: { merge: 1 } }, { kind: 'back', why: 'rename foo' });
    expect(parked).toMatchObject({ step: 'merge', status: 'waiting', reason: 'rename foo', rounds: { merge: 1 } });
    expect(transition(one, parked, { kind: 'back', why: 'rename bar' })).toMatchObject({
      step: 'merge',
      status: 'waiting',
    });
    const granted = makeRunWithFreshRound(one, parked);
    expect(makeRunWithFreshRound(one, granted)).toBe(granted);
    expect(transition(one, granted, { kind: 'back', why: 'rename bar' })).toMatchObject({
      step: 'implement',
      status: 'running',
      rounds: { merge: 1 },
      feedback: 'the merge step sent this back: rename bar',
    });
  });

  it('a fresh round leaves a run with rounds left, or at a step without a cap, as it is', () => {
    const one = { ...w, steps: w.steps.map(s => (s.name === 'merge' ? { ...s, back: { ...s.back!, rounds: 1 } } : s)) };
    const asked = { ...waiting, reason: 'merge waits for a human' };
    expect(makeRunWithFreshRound(one, asked)).toBe(asked);
    expect(makeRunWithFreshRound(w, { ...asked, rounds: { merge: 9 } })).toEqual({ ...asked, rounds: { merge: 9 } });
  });

  it('stop (closed): stopped', () => {
    expect(transition(w, waiting, { kind: 'stop', why: 'closed' })).toMatchObject({
      status: 'stopped',
      reason: 'closed',
    });
  });

  it('ignores an outcome a waiting run cannot have', () => {
    expect(transition(w, waiting, failed)).toBe(waiting);
  });
});

describe('transition, waiting for an answer', () => {
  it('answer: running again, same session, the answer carried, the spent tries drop by one', () => {
    const asked = transition(w, at('implement', { tries: 3 }), failed);
    const next = transition(w, asked, { kind: 'answer', text: 'use the v2 API' });
    expect(next).toMatchObject({ step: 'implement', status: 'running', tries: 3, feedback: 'use the v2 API' });
    expect(next.reason).toBeUndefined();
    expect(next.answers).toEqual([{ asked: asked.reason, said: 'use the v2 API' }]);
    expect(transition(w, next, failed).status).toBe('waiting');
  });

  it('answer: the spent rounds drop by one', () => {
    const asked = transition(w, at('review', { rounds: { review: 2 } }), { kind: 'back', why: 'still wrong' });
    const next = transition(w, asked, { kind: 'answer', text: 'one more go' });
    expect(next).toMatchObject({ step: 'review', status: 'running', rounds: { review: 1 } });
    expect(transition(w, next, { kind: 'back', why: 'again' })).toMatchObject({
      step: 'implement',
      rounds: { review: 2 },
    });
  });

  it('answer to a plain ask: no counter changes', () => {
    const asked = transition(w, at('implement', { tries: 1 }), { kind: 'ask', question: 'which API?' });
    expect(transition(w, asked, { kind: 'answer', text: 'v2' })).toMatchObject({
      status: 'running',
      tries: 1,
      rounds: {},
    });
  });

  it('stop: stopped', () => {
    const asked = at('implement', { status: 'waiting', reason: 'which API?' });
    expect(transition(w, asked, { kind: 'stop', why: 'not now' })).toMatchObject({
      status: 'stopped',
      reason: 'not now',
    });
  });
});

describe('transition, settled runs', () => {
  it('running: an answer joins the feedback and keeps the try and the session', () => {
    const run = at('implement', {
      tries: 1,
      feedback: 'types failed',
      sessions: { implement: { id: 's', home: '/h' } },
    });
    expect(transition(w, run, { kind: 'answer', text: 'use v2' })).toEqual({
      ...run,
      feedback: 'types failed\n\nuse v2',
      answers: [{ asked: '', said: 'use v2' }],
    });
  });

  it('leaves done and stopped runs as they are', () => {
    const done = at('merge', { status: 'done' });
    expect(transition(w, done, { kind: 'pass' })).toBe(done);
  });
});

describe('getEventOutcome', () => {
  const said = (kind: Event['kind'], more: Partial<Event> = {}): Event => ({
    issue: 7,
    kind,
    actor: 'morgan',
    trusted: true,
    at: '2026-10-16T01:00:00Z',
    ...more,
  });
  const comment = (body: string) =>
    said('comment', {
      comment: makeCommentWithAgentRequest({ id: 'c1', author: 'morgan', body, at: '2026-10-16T01:00:00Z' }),
    });
  const waiting = at('merge', { status: 'waiting' });
  const asked = at('implement', { status: 'waiting', reason: 'which API?' });
  const kit = fixture('kit');
  const heard = (run: Run, m: Event, commands: Graph['commands'] = {}, runs = [run]) =>
    getEventOutcome(w, run, m, [], pickCommandTarget({ ...kit, commands }, runs, m, undefined));

  it('changes requested carries the review body and its line comments', () => {
    const line = (path: string, line: number, body: string) =>
      said('comment', { comment: { id: 'l', author: 'morgan', body, at: '', path, line } });
    const review = said('changes_requested', { comment: { id: 'r', author: 'morgan', body: 'fix these', at: '' } });
    const lined = [line('a.ts', 3, 'rename'), line('b.ts', 9, 'drop')];
    expect(getEventOutcome(w, waiting, review, lined)).toEqual({
      kind: 'back',
      why: 'fix these\na.ts:3, id l: rename\nb.ts:9, id l: drop',
    });
  });

  it('waiting: merged, approved or the approved label is pass', () => {
    expect(getEventOutcome(w, waiting, said('merged'))).toEqual({ kind: 'pass' });
    expect(getEventOutcome(w, waiting, said('approved'))).toEqual({ kind: 'pass' });
    expect(getEventOutcome(w, waiting, said('label', { label: 'approved' }))).toEqual({ kind: 'pass' });
  });

  it('waiting at a human step: changes requested is back, a mention is an answer for the aside', () => {
    expect(getEventOutcome(w, waiting, said('changes_requested'))).toEqual({ kind: 'back', why: 'changes requested' });
    expect(getEventOutcome(w, waiting, comment('/agent rename foo'))).toEqual({ kind: 'answer', text: 'rename foo' });
    expect(getEventOutcome(w, waiting, comment('@agent rename foo'))).toEqual({ kind: 'answer', text: 'rename foo' });
  });

  it('waiting: closed is stop', () => {
    expect(getEventOutcome(w, waiting, said('closed'))).toEqual({ kind: 'stop', why: 'closed' });
    expect(getEventOutcome(w, asked, said('closed'))).toEqual({ kind: 'stop', why: 'closed' });
  });

  it('waiting at an agent step: a mention is the answer, unless it is a command', () => {
    expect(getEventOutcome(w, asked, comment('/agent use v2'))).toEqual({ kind: 'answer', text: 'use v2' });
    expect(getEventOutcome(w, asked, comment('/agent stop wrong issue'))).toEqual({
      kind: 'answer',
      text: 'stop wrong issue',
    });
    expect(heard(asked, comment('/agent:stop wrong issue'))).toEqual({ kind: 'stop', why: 'wrong issue' });
  });

  it('ignores comments without the command, untrusted authors, other issues and finished runs', () => {
    expect(getEventOutcome(w, asked, comment('looks good'))).toBeUndefined();
    expect(getEventOutcome(w, asked, { ...comment('/agent v2'), trusted: false })).toBeUndefined();
    expect(getEventOutcome(w, asked, { ...comment('/agent v2'), issue: 8 })).toBeUndefined();
    expect(getEventOutcome(w, at('implement', { status: 'done' }), comment('/agent v2'))).toBeUndefined();
  });

  it('running: a comment is an answer, cancel parks the run, stop, restart and closing end it', () => {
    const running = at('implement');
    expect(getEventOutcome(w, running, comment('/agent use v2'))).toEqual({ kind: 'answer', text: 'use v2' });
    expect(heard(running, comment('/agent:cancel'))).toEqual({ kind: 'ask', question: cancelled });
    expect(heard(running, comment('/agent:stop'))).toEqual({ kind: 'stop', why: 'a human said stop' });
    expect(getEventOutcome(w, running, said('closed'))).toEqual({ kind: 'stop', why: 'closed' });
    expect(heard(running, comment('/agent:restart'))).toEqual({
      kind: 'stop',
      why: 'a human restarted it',
      restarted: true,
    });
    expect(heard(asked, comment('/agent:cancel'))).toBeUndefined();
    expect(getEventOutcome(w, running, comment('/agent:stop'))).toBeUndefined();
  });

  it.each([
    ['/agent stop doing X and do Y', 'stop doing X and do Y'],
    ['/agent restart is fine, just fix the test', 'restart is fine, just fix the test'],
    ['/agent cancel that, use v2', 'cancel that, use v2'],
    ['/agent: stop here', 'stop here'],
    ['/agent :restart', 'restart'],
    ['@agent stop', 'stop'],
  ])('text after a space is an answer whatever its first word: %s', (body, text) => {
    expect(getEventOutcome(w, at('implement'), comment(body))).toEqual({ kind: 'answer', text });
  });

  it.each([
    ['/agent:stop', 'implement', { kind: 'stop', why: 'a human said stop' }],
    ['/agent:stop wrong issue', 'implement', { kind: 'stop', why: 'wrong issue' }],
    ['Thanks. /agent:stop', 'implement', { kind: 'stop', why: 'Thanks.' }],
    ['/agent:cancel', 'implement', { kind: 'ask', question: cancelled }],
    ['/agent:restart', 'implement', { kind: 'stop', why: 'a human restarted it', restarted: true }],
    ['/agent:restart:review', 'implement', { kind: 'stop', why: 'a human restarted it', restarted: true }],
    ['/agent:issue:restart:triage', 'implement', { kind: 'stop', why: 'a human restarted it', restarted: true }],
    ['/agent:issue use v2', 'implement', { kind: 'answer', text: 'use v2' }],
    ['/agent:restart:nope', 'implement', undefined],
    ['/agent:plan use v2', 'implement', undefined],
    ['/agent:bogus', 'implement', undefined],
    ['/agent:stop:now', 'implement', undefined],
  ])('a colon command on a working run: %s', (body, step, outcome) => {
    expect(heard(at(step), comment(body))).toEqual(outcome);
  });

  it.each([
    ['on for everyone trusted', {}, 'morgan', true, { kind: 'stop', why: 'a human said stop' }],
    ['on', { stop: true }, 'morgan', true, { kind: 'stop', why: 'a human said stop' }],
    ['turned off', { stop: false }, 'morgan', true, undefined],
    ['kept to a login', { stop: ['ana'] }, 'morgan', true, undefined],
    ['the login it is kept to', { stop: ['morgan'] }, 'morgan', true, { kind: 'stop', why: 'a human said stop' }],
    ['the login, untrusted', { stop: ['morgan'] }, 'morgan', false, undefined],
  ])('a stop %s', (_, commands, actor, trusted, outcome) => {
    const m = { ...comment('/agent:stop'), actor, trusted };
    expect(heard(at('implement'), m, commands)).toEqual(outcome);
  });

  it.each([
    ['/agent fix it', {}, undefined],
    ['/agent:stop', { restart: false }, { verb: 'stop', text: '', run: 'r1', workflow: 'issue' }],
    [
      '/agent:restart:review again',
      {},
      { verb: 'restart', step: 'review', text: 'again', run: 'r1', workflow: 'issue' },
    ],
    ['/agent:plan fix it', {}, { text: 'fix it', workflow: 'plan' }],
    ['/agent:issue:restart', {}, { verb: 'restart', text: '', run: 'r1', workflow: 'issue' }],
    [
      '/agent:bogus',
      {},
      '`/agent:bogus` is not a command. Use `/agent:stop`, `/agent:cancel`, `/agent:restart`, `/agent:restart:<step>`, `/agent:issue`, `/agent:plan`.',
    ],
    [
      '/agent:restart:nope',
      {},
      '`/agent:restart:nope`: issue has no step nope. Its steps are triage, implement, review, merge.',
    ],
    ['/agent:restart', { restart: false }, '`/agent:restart` is turned off here.'],
    ['/agent:restart', { restart: ['ana', 'bob'] }, 'Only ana, bob may use `/agent:restart`.'],
    ['/agent:plan fix it', { plan: false }, '`/agent:plan` is turned off here.'],
    ['/agent:issue:restart', { restart: false }, '`/agent:restart` is turned off here.'],
  ])('picks what %s with %j asks, and of which run', (body, commands, expected) => {
    const target = pickCommandTarget({ ...kit, commands }, [at('implement')], comment(body), undefined);
    expect(
      target && ('why' in target ? target.why : { ...target, run: target.run?.id, workflow: target.workflow?.name })
    ).toEqual(expected);
  });

  it('reads a command as its whole token, so dotted names and shared prefixes stay apart and a bad suffix is refused', () => {
    const issue = kit.workflows.issue!;
    const dotted = {
      ...kit,
      workflows: {
        ...kit.workflows,
        issue: { ...issue, steps: [...issue.steps, { ...issue.steps[1]!, name: 'implement.more' }] },
        'plan.more': { ...kit.workflows.plan!, name: 'plan.more' },
      },
    };
    const pick = (body: string) => {
      const target = pickCommandTarget(dotted, [at('implement')], comment(body), undefined);
      return target && ('why' in target ? target.why : [target.verb, target.step, target.workflow?.name, target.text]);
    };
    const valid =
      '`/agent:stop`, `/agent:cancel`, `/agent:restart`, `/agent:restart:<step>`, `/agent:issue`, `/agent:plan`, `/agent:plan.more`';
    expect(
      [
        '/agent:restart:implement.more please',
        '/agent:restart:implement please',
        '/agent:plan.more go',
        '/agent:plan go',
        '/agent:stop:!',
        '/agent:stop, now',
        '/agent:restart:',
        '/agent: fix it',
      ].map(pick)
    ).toEqual([
      ['restart', 'implement.more', 'issue', 'please'],
      ['restart', 'implement', 'issue', 'please'],
      [undefined, undefined, 'plan.more', 'go'],
      [undefined, undefined, 'plan', 'go'],
      `\`/agent:stop:!\` is not a command. Use ${valid}.`,
      `\`/agent:stop,\` is not a command. Use ${valid}.`,
      `\`/agent:restart:\` is not a command. Use ${valid}.`,
      undefined,
    ]);
    expect(comment('/agent:restart:implement.more please').comment?.agentRequest).toBe(
      ':restart:implement.more please'
    );
  });

  it('gates commands the CLI or a router tells like any other', () => {
    const cli = { ...comment('/agent:restart'), source: 'cli' as const };
    const told = { ...comment('/agent:stop'), actor: 'router-1' };
    const commands = { restart: false, stop: ['morgan'] };
    expect(pickCommandTarget({ ...kit, commands }, [at('implement')], cli, undefined)).toEqual({
      why: '`/agent:restart` is turned off here.',
    });
    expect(pickCommandTarget({ ...kit, commands }, [at('implement')], told, undefined, at('implement'))).toEqual({
      why: 'Only morgan may use `/agent:stop`.',
    });
  });

  const told = (body: string) => ({ ...comment(body), actor: 'router-1' });

  it('refuses a command naming a workflow that is told to a run of another one', () => {
    const live = at('implement', { status: 'waiting', reason: 'which API?' });
    expect(
      ['/agent:plan:restart:implement', '/agent:plan more tests'].map(b =>
        pickCommandTarget(kit, [], told(b), undefined, live)
      )
    ).toEqual([
      { why: '`/agent:plan:restart:implement` names plan, but the run it goes to is issue.' },
      { why: '`/agent:plan` names plan, but the run it goes to is issue.' },
    ]);
    expect(heard(live, told('/agent:plan:restart:implement'), {}, [live])).toBeUndefined();
  });

  it('restarts the live run a restart picks, validated against that run, and leaves the newer finished run alone', () => {
    const live = at('implement', { status: 'waiting', reason: 'which API?' });
    const finished = begin(kit.workflows.plan!, { id: 'p1', issue: 7, started: '2026-10-16T00:30:00Z' });
    const done = { ...finished, status: 'done' as const };
    const m = comment('/agent:restart:triage');
    expect(pickCommandTarget(kit, [live, done], m, undefined)).toMatchObject({
      run: { id: 'r1' },
      workflow: { name: 'issue' },
    });
    expect(heard(live, m, {}, [live, done])).toEqual({ kind: 'stop', why: 'a human restarted it', restarted: true });
  });

  it('gives a command to the newest live run only', () => {
    const older = at('implement', { status: 'waiting', reason: 'which API?' });
    const newer = { ...at('implement'), id: 'r2', started: '2026-10-16T00:30:00Z' };
    const m = comment('/agent:stop');
    expect(heard(older, m, {}, [older, newer])).toBeUndefined();
    expect(heard(newer, m, {}, [older, newer])).toEqual({ kind: 'stop', why: 'a human said stop' });
  });

  it('folds a burst into one outcome: the first that is not an answer, else every answer', () => {
    const answer = (text: string) => ({ kind: 'answer', text }) as const;
    expect(fold([answer('a'), answer('b')])).toEqual(answer('a\n\nb'));
    expect(fold([answer('a'), { kind: 'stop', why: 'x' }, { kind: 'pass' }])).toEqual({ kind: 'stop', why: 'x' });
    expect(fold([])).toBeUndefined();
  });
});
