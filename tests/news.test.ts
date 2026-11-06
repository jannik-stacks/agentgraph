import { describe, expect, it } from 'vitest';
import { formatRequest, news, type IssueWithPull } from '../src/context.ts';
import type { Comment, Event, Issue } from '../src/event.ts';

const said = (actor: string, at: string, comment: Omit<Comment, 'author' | 'at'>): Event => ({
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
  it('shows replies that came after the request in its review thread, so a settled ask gets no second answer', () => {
    const thread = { path: 'kit/package.json', under: '1' };
    const request = said('morgan', '2026-10-19T17:00:00Z', { id: '2', body: '/agent', agentRequest: '', ...thread });
    const settled = said('morgan', '2026-10-19T17:02:00Z', { id: '3', body: 'Renamed in cb8b13e.', ...thread });
    const elsewhere = said('morgan', '2026-10-19T17:03:00Z', { id: '4', body: 'and this?', path: 'kit/src/a.ts' });
    const text = formatRequest(pull([asked, request, settled, elsewhere]), request.at);
    expect(text).toContain('Earlier in its review thread');
    expect(text).toContain('Later in its review thread:\n\n@morgan on kit/package.json, id 1: Renamed in cb8b13e.');
    expect(text).not.toContain('and this?');
  });
});
