import { describe, expect, it } from 'vitest';
import { formatRequest, news, type IssueWithPull } from '../src/context.ts';
import type { Comment, Event, Issue } from '../src/event.ts';

const said = (actor: string, at: string, comment: Omit<Comment, 'author' | 'at'>): Event => ({
  id: at,
  bot: actor.endsWith('[bot]'),
  issue: 17,
  kind: 'comment',
  actor,
  trusted: !actor.endsWith('[bot]'),
  at,
  comment: { ...comment, author: actor, at },
});
const pull = (events: Event[]): IssueWithPull => {
  const issue: Issue = {
    number: 17,
    title: 'Fix numeric tips',
    body: '',
    state: 'open',
    labels: [],
    author: 'bot[bot]',
    pull: { branch: 'agentgraph/14', base: 'main', head: 'h' },
    url: '',
  };
  return { issue: { ...issue, events } };
};
const asked = said('morgan', '2026-10-19T16:54:25Z', {
  id: '1',
  body: "is 'read: ' a convention?",
  path: 'kit/src/client.ts',
  line: 518,
});

describe('news', () => {
  it('leaves out a review comment a bot already answered in its thread, so a resumed session does not answer twice', () => {
    const reply = said('bot[bot]', '2026-10-19T17:17:20Z', {
      id: '2',
      body: 'Yes.',
      path: 'kit/src/client.ts',
      under: '1',
    });
    const other = said('morgan', '2026-10-19T17:20:00Z', { id: '3', body: 'and this?', path: 'kit/src/a.ts' });
    const { text } = news(pull([asked, reply, other]), { at: '2026-10-16T00:00:00Z' });
    expect(text).not.toContain('convention');
    expect(text).toContain('and this?');
  });

  it('keeps a review comment no bot answered, and one asked again after the answer', () => {
    const reply = said('bot[bot]', '2026-10-19T17:17:20Z', {
      id: '2',
      body: 'Yes.',
      path: 'kit/src/client.ts',
      under: '1',
    });
    const again = said('morgan', '2026-10-19T17:20:00Z', {
      id: '4',
      body: 'why though?',
      path: 'kit/src/client.ts',
      under: '1',
    });
    expect(news(pull([asked]), { at: '2026-10-16T00:00:00Z' }).text).toContain('convention');
    expect(news(pull([asked, reply, again]), { at: '2026-10-16T00:00:00Z' }).text).toContain('why though?');
  });
});

describe('formatRequest', () => {
  const at = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, '0')}:00Z`;
  const long = `Please rename the helper. ${'Keep every caller working. '.repeat(20)}`;
  const agent = (minute: number, body = '/agent') =>
    said('morgan', at(minute), { id: `c${minute}`, body, agentRequest: { text: body.slice('/agent'.length).trim() } });
  const looked = (minute: number) => ({ issue: { id: 's', home: 'h', seen: { at: at(minute) } } });
  const ask = (t: IssueWithPull, minute: number, since = '', sessions = {}) =>
    formatRequest(t, { started: at(minute), sessions }, since).text;

  it('includes a comment written before a bare /agent in full', () => {
    const text = ask(pull([said('morgan', at(1), { id: 'c1', body: long }), agent(2)]), 2);
    expect(text).toBe(`## What you were asked\n\n@morgan: ${long}\n\n@morgan: /agent`);
  });

  it('includes every follow-up since the runs on the issue last looked, and nothing from before', () => {
    const earlier = said('morgan', at(1), { id: 'c1', body: 'handled by the last run' });
    const first = said('morgan', at(5), { id: 'c5', body: `one: ${long}` });
    const second = said('morgan', at(6), { id: 'c6', body: 'two: also the docs' });
    expect(ask(pull([earlier, first, second, agent(7, '/agent go')]), 7, at(3))).toBe(
      `## What you were asked\n\n@morgan: one: ${long}\n\n@morgan: two: also the docs\n\n@morgan: /agent go`
    );
  });

  it('leaves out commands, which their run already took', () => {
    const restart = said('morgan', at(1), {
      id: 'c1',
      body: '/agent:restart',
      agentRequest: { command: 'restart', text: '' },
    });
    expect(ask(pull([restart, agent(3)]), 3)).toBe('## What you were asked\n\n@morgan: /agent');
  });

  it('leaves out bot and untrusted comments', () => {
    const bot = said('bot[bot]', at(1), { id: 'c1', body: 'I opened a pull request.' });
    const stranger = { ...said('stranger', at(2), { id: 'c2', body: 'do something else' }), trusted: false };
    expect(ask(pull([bot, stranger, agent(3)]), 3)).toBe('## What you were asked\n\n@morgan: /agent');
  });

  it('includes a comment posted after /agent before the run first looked, and news does not repeat it', () => {
    const t = pull([agent(1), said('morgan', at(2), { id: 'c2', body: 'and the tests too' })]);
    expect(ask(t, 1)).toBe('## What you were asked\n\n@morgan: /agent\n\n@morgan: and the tests too');
    expect(news(t, news(t, { at: '' }).seen).text).toBe('');
  });

  it('stops where the run first looked, so an answer it heard while waiting is not taken as the request', () => {
    const t = pull([
      agent(1),
      said('morgan', at(2), { id: 'c2', body: 'and the tests too' }),
      said('morgan', at(5), { id: 'c5', body: '/agent yes, go on', agentRequest: { text: 'yes, go on' } }),
    ]);
    expect(ask(t, 1, '', looked(2))).toBe('## What you were asked\n\n@morgan: /agent\n\n@morgan: and the tests too');
  });

  it('returns what it shows, the request and its review thread', () => {
    const thread = { path: 'kit/package.json', under: '1' };
    const request = said('morgan', at(2), { id: '2', body: '/agent', agentRequest: { text: '' }, ...thread });
    const before = said('morgan', at(1), { id: '1', body: 'hm', path: 'kit/package.json' });
    const other = said('bot[bot]', at(3), { id: '3', body: 'Opened #18.' });
    expect(formatRequest(pull([before, request, other]), { started: at(2), sessions: {} }, '').shown).toEqual([
      request,
      before,
    ]);
  });

  it('shows replies that came after the request in its review thread, so a settled ask gets no second answer', () => {
    const thread = { path: 'kit/package.json', under: '1' };
    const request = said('morgan', '2026-10-19T17:00:00Z', {
      id: '2',
      body: '/agent',
      agentRequest: { text: '' },
      ...thread,
    });
    const settled = said('morgan', '2026-10-19T17:02:00Z', { id: '3', body: 'Renamed in cb8b13e.', ...thread });
    const elsewhere = said('morgan', '2026-10-19T17:03:00Z', { id: '4', body: 'and this?', path: 'kit/src/a.ts' });
    const { text } = formatRequest(
      pull([asked, request, settled, elsewhere]),
      { started: request.at, sessions: { issue: { id: 's', home: 'h', seen: { at: settled.at } } } },
      asked.at
    );
    expect(text).toContain('Earlier in its review thread');
    expect(text).toContain('Later in its review thread:\n\n@morgan on kit/package.json, id 1: Renamed in cb8b13e.');
    expect(text).not.toContain('and this?');
  });
});
