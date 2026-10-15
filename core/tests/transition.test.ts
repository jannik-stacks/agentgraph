import { describe, expect, it } from 'vitest';
import type { Message } from '../src/forge.ts';
import { begin, reenter, transition, type Outcome, type Run } from '../src/workflow.ts';
import { fixture } from './fixtures.ts';

// acme-app issue: triage (1 try), implement (4 tries), review (back to implement, 2 rounds), merge (wait, back to implement)
const w = fixture('acme-app').workflows.issue!;
const merge = fixture('acme-app').workflows.merge!;
const session = (id: string) => ({ id, home: `/runs/${id}` });
const start = begin(w, { id: 'r1', thread: 7, started: '2026-10-16T00:00:00Z' });
const at = (step: string, more: Partial<Run> = {}): Run => ({
  ...start,
  step,
  sessions: { triage: session('s-triage'), implement: session('s-implement'), review: session('s-review') },
  ...more,
});
const refused: Outcome = {
  kind: 'refused',
  failing: [{ check: 'types', pass: false, findings: 'x.ts:1 error', ms: 10 }],
  rejected: [],
  problems: ['no bothub block'],
};

describe('begin', () => {
  it('starts at the first step, running, with no counters', () => {
    expect(start).toEqual({
      id: 'r1',
      thread: 7,
      started: '2026-10-16T00:00:00Z',
      workflow: 'issue',
      step: 'triage',
      status: 'running',
      tries: 0,
      rounds: {},
      sessions: {},
      usd: 0,
    });
  });
});

describe('transition, running', () => {
  it('pass: next step, tries reset, a fresh session there, carry cleared', () => {
    const next = transition(w, at('triage', { tries: 0, carry: 'x' }), { kind: 'pass' });
    expect(next).toMatchObject({ step: 'implement', status: 'running', tries: 0 });
    expect(next.carry).toBeUndefined();
    expect(next.sessions.implement).toBeUndefined();
    expect(next.sessions.triage).toEqual(session('s-triage'));
  });

  it('pass into a wait step: waiting', () => {
    expect(transition(w, at('review'), { kind: 'pass' })).toMatchObject({ step: 'merge', status: 'waiting' });
  });

  it('pass on the last step: done', () => {
    expect(transition(merge, begin(merge, start), { kind: 'pass' })).toMatchObject({ step: 'merge', status: 'done' });
  });

  it('refused with tries left: same step, tries + 1, same session, the refusal carried', () => {
    const next = transition(w, at('implement', { tries: 1 }), refused);
    expect(next).toMatchObject({
      step: 'implement',
      status: 'running',
      tries: 2,
      sessions: { implement: session('s-implement') },
    });
    expect(next.carry).toBe('types: x.ts:1 error\nno bothub block');
  });

  it('refused with no tries left: asking, the refusal is the question', () => {
    const next = transition(w, at('implement', { tries: 3 }), refused);
    expect(next).toMatchObject({
      step: 'implement',
      status: 'asking',
      tries: 4,
      reason: 'types: x.ts:1 error\nno bothub block',
    });
  });

  it('refused on a step with one try: asking at once', () => {
    expect(transition(w, at('triage'), refused).status).toBe('asking');
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
      carry: 'the review step sent this back: hunk 2 leaks',
    });
  });

  it('back with no rounds left: asking, the reason is the question', () => {
    const next = transition(w, at('review', { rounds: { review: 2 } }), { kind: 'back', why: 'hunk 2 leaks' });
    expect(next).toMatchObject({ step: 'review', status: 'asking', reason: 'hunk 2 leaks', rounds: { review: 2 } });
  });

  it('back on a step without one: counted as a refusal with a rejected proposal', () => {
    const next = transition(w, at('implement', { tries: 0 }), { kind: 'back', why: 'brief is wrong' });
    expect(next).toMatchObject({ step: 'implement', status: 'running', tries: 1 });
    expect(next.carry).toBe('back rejected: implement has no way back');
  });

  it('ask: asking, same step, session kept', () => {
    const next = transition(w, at('implement', { tries: 1 }), { kind: 'ask', question: 'which API?' });
    expect(next).toMatchObject({ step: 'implement', status: 'asking', tries: 1, reason: 'which API?' });
    expect(next.sessions.implement).toEqual(session('s-implement'));
  });

  it('stop: stopped, no try spent', () => {
    const next = transition(w, at('implement', { tries: 1 }), { kind: 'stop', why: 'safety failed' });
    expect(next).toMatchObject({ step: 'implement', status: 'stopped', tries: 1, reason: 'safety failed' });
  });

  it('a script step reruns on a refusal with tries left', () => {
    const next = transition(merge, begin(merge, start), refused);
    expect(next).toMatchObject({ step: 'merge', status: 'running', tries: 1 });
  });
});

describe('transition, waiting', () => {
  const waiting = at('merge', { status: 'waiting' });

  it('pass (merged, approved): next step, or done after the last', () => {
    expect(transition(w, waiting, { kind: 'pass' })).toMatchObject({ step: 'merge', status: 'done' });
  });

  it('back (changes requested, a command comment): back.to, its session resumed with the comment', () => {
    const next = transition(w, { ...waiting, rounds: { merge: 5 } }, { kind: 'back', why: 'rename foo' });
    expect(next).toMatchObject({
      step: 'implement',
      status: 'running',
      rounds: { merge: 6 },
      sessions: { implement: session('s-implement') },
      carry: 'the merge step sent this back: rename foo',
    });
  });

  it('stop (closed): stopped', () => {
    expect(transition(w, waiting, { kind: 'stop', why: 'closed' })).toMatchObject({
      status: 'stopped',
      reason: 'closed',
    });
  });

  it('ignores an outcome a waiting run cannot have', () => {
    expect(transition(w, waiting, refused)).toBe(waiting);
  });
});

describe('transition, asking', () => {
  it('answer: running again, same session, the answer carried, the spent tries drop by one', () => {
    const asking = transition(w, at('implement', { tries: 3 }), refused);
    const next = transition(w, asking, { kind: 'answer', text: 'use the v2 API' });
    expect(next).toMatchObject({ step: 'implement', status: 'running', tries: 3, carry: 'use the v2 API' });
    expect(next.reason).toBeUndefined();
    expect(transition(w, next, refused).status).toBe('asking');
  });

  it('answer: the spent rounds drop by one', () => {
    const asking = transition(w, at('review', { rounds: { review: 2 } }), { kind: 'back', why: 'still wrong' });
    const next = transition(w, asking, { kind: 'answer', text: 'one more go' });
    expect(next).toMatchObject({ step: 'review', status: 'running', rounds: { review: 1 } });
    expect(transition(w, next, { kind: 'back', why: 'again' })).toMatchObject({
      step: 'implement',
      rounds: { review: 2 },
    });
  });

  it('answer to a plain ask: no counter changes', () => {
    const asking = transition(w, at('implement', { tries: 1 }), { kind: 'ask', question: 'which API?' });
    expect(transition(w, asking, { kind: 'answer', text: 'v2' })).toMatchObject({
      status: 'running',
      tries: 1,
      rounds: {},
    });
  });

  it('stop: stopped', () => {
    const asking = at('implement', { status: 'asking', reason: 'which API?' });
    expect(transition(w, asking, { kind: 'stop', why: 'not now' })).toMatchObject({
      status: 'stopped',
      reason: 'not now',
    });
  });
});

describe('transition, settled runs', () => {
  it('leaves done and stopped runs as they are', () => {
    const done = at('merge', { status: 'done' });
    expect(transition(w, done, { kind: 'pass' })).toBe(done);
  });
});

describe('reenter', () => {
  const said = (kind: Message['kind'], more: Partial<Message> = {}): Message => ({
    thread: 7,
    kind,
    actor: 'morgan',
    trusted: true,
    at: '2026-10-16T01:00:00Z',
    ...more,
  });
  const comment = (body: string) =>
    said('comment', { comment: { id: 'c1', author: 'morgan', body, at: '2026-10-16T01:00:00Z' } });
  const waiting = at('merge', { status: 'waiting' });
  const asking = at('implement', { status: 'asking', reason: 'which API?' });

  it('waiting: merged, approved or the approved label is pass', () => {
    expect(reenter(w, waiting, said('merged'))).toEqual({ kind: 'pass' });
    expect(reenter(w, waiting, said('approved'))).toEqual({ kind: 'pass' });
    expect(reenter(w, waiting, said('label', { label: 'approved' }))).toEqual({ kind: 'pass' });
  });

  it('waiting: changes requested or a command comment is back', () => {
    expect(reenter(w, waiting, said('changes'))).toEqual({ kind: 'back', why: 'changes requested' });
    expect(reenter(w, waiting, comment('/bothub rename foo'))).toEqual({ kind: 'back', why: 'rename foo' });
  });

  it('waiting or asking: closed is stop', () => {
    expect(reenter(w, waiting, said('closed'))).toEqual({ kind: 'stop', why: 'closed' });
    expect(reenter(w, asking, said('closed'))).toEqual({ kind: 'stop', why: 'closed' });
  });

  it('asking: a command comment is the answer, unless its first word is stop', () => {
    expect(reenter(w, asking, comment('/bothub use v2'))).toEqual({ kind: 'answer', text: 'use v2' });
    expect(reenter(w, asking, comment('/bothub stop wrong issue'))).toEqual({ kind: 'stop', why: 'wrong issue' });
  });

  it('ignores comments without the command, untrusted authors, other threads and running runs', () => {
    expect(reenter(w, asking, comment('looks good'))).toBeUndefined();
    expect(reenter(w, asking, { ...comment('/bothub v2'), trusted: false })).toBeUndefined();
    expect(reenter(w, asking, { ...comment('/bothub v2'), thread: 8 })).toBeUndefined();
    expect(reenter(w, at('implement'), comment('/bothub v2'))).toBeUndefined();
  });
});
