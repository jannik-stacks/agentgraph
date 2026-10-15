import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { parseCommand, plan } from '../src/dispatch.ts';
import { gh } from '../src/github-app.ts';
import { senderTrust, toEvent, verifySignature, visible } from '../src/github.ts';
import { readHub } from '../src/load.ts';
import type { BotEvent } from '../src/types.ts';

const hub = join(import.meta.dirname, '../examples/hub');
const config = await (async (): Promise<Config> => {
  const result = compile(await readHub(hub));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
})();

const now = new Date('2026-10-12T00:00:00Z');
const commentPayload = (body: string, association = 'OWNER') => ({
  action: 'created',
  repository: { full_name: 'acme/app' },
  sender: { login: 'morgan' },
  issue: {
    number: 7,
    html_url: 'https://github.com/acme/app/issues/7',
    body: 'issue text',
    user: { login: 'x' },
    author_association: 'NONE',
  },
  comment: { body, html_url: 'https://github.com/acme/app/issues/7#c1', author_association: association },
});

describe('verifySignature', () => {
  const body = '{"a":1}';
  const header = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');

  it('accepts a valid signature and rejects others', async () => {
    expect(await verifySignature('s3cret', body, header)).toBe(true);
    expect(await verifySignature('wrong', body, header)).toBe(false);
    expect(await verifySignature('s3cret', body + ' ', header)).toBe(false);
    expect(await verifySignature('s3cret', body, null)).toBe(false);
  });
});

describe('toEvent', () => {
  it('normalises an issue comment', () => {
    expect(toEvent('issue_comment', 'd1', commentPayload('/bothub fix it'), now)).toEqual({
      id: 'd1',
      ts: '2026-10-12T00:00:00.000Z',
      source: 'github',
      trigger: 'issue_comment',
      action: 'created',
      repo: 'acme/app',
      number: 7,
      actor: { login: 'morgan', association: 'OWNER' },
      body: '/bothub fix it',
      url: 'https://github.com/acme/app/issues/7#c1',
    });
  });

  it('counts a bot sender as NONE, whoever wrote the issue it labels', () => {
    const labeled = (sender: { login: string; type?: string }) =>
      toEvent('issues', 'd7', {
        action: 'labeled',
        repository: { full_name: 'acme/app' },
        sender,
        issue: { number: 7, html_url: 'u', user: { login: 'morgan' }, author_association: 'OWNER' },
        label: { name: 'ready' },
      })?.actor;
    expect(labeled({ login: 'morgan' })).toEqual({ login: 'morgan', association: 'OWNER' });
    expect(labeled({ login: 'bothub[bot]', type: 'Bot' })).toEqual({ login: 'bothub[bot]', association: 'NONE' });
    expect(labeled({ login: 'helper', type: 'Bot' })?.association).toBe('NONE');
  });

  it('checks out the pull request head for comments on a pull request', () => {
    const payload = commentPayload('/bothub fix it');
    const event = toEvent('issue_comment', 'd5', {
      ...payload,
      issue: { ...payload.issue, pull_request: { url: 'u' } },
    });
    expect(event).toMatchObject({ number: 7, ref: 'refs/pull/7/head' });
    expect(event).not.toHaveProperty('branch');
  });

  it('carries the pushed branch, and no branch for tags', () => {
    const push = (ref: string) =>
      toEvent('push', 'd6', { ref, repository: { full_name: 'acme/app' }, sender: { login: 'x' } });
    expect(push('refs/heads/release/1')).toMatchObject({ ref: 'refs/heads/release/1', branch: 'release/1' });
    expect(push('refs/tags/v1')).not.toHaveProperty('branch');
  });

  it('carries the pull ref of a pull request, which also exists for forks', () => {
    const event = toEvent('pull_request', 'd2', {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      sender: { login: 'bot' },
      pull_request: {
        number: 9,
        html_url: 'u',
        body: null,
        user: { login: 'bot' },
        author_association: 'MEMBER',
        head: { ref: 'patch-1' },
        base: { ref: 'main' },
      },
    });
    expect(event).toMatchObject({
      trigger: 'pull_request',
      number: 9,
      ref: 'refs/pull/9/head',
      branch: 'main',
      actor: { association: 'MEMBER' },
    });
    expect(event).not.toHaveProperty('body');
  });

  it('ignores unhandled events and rejects malformed payloads', () => {
    expect(toEvent('star', 'd3', {})).toBeUndefined();
    expect(() => toEvent('issue_comment', 'd4', { action: 'created' })).toThrow();
  });
});

describe('plan', () => {
  const event = (body: string, association = 'OWNER') =>
    toEvent('issue_comment', 'd', commentPayload(body, association)) as BotEvent;

  it('starts the implementor for a trusted command', () => {
    expect(plan(event('/bothub add a health check\nwith tests'), config)).toEqual([
      { workflow: 'issue', job: 'implement', bot: 'implementor', args: 'add a health check\nwith tests' },
    ]);
  });

  it('takes `all` or `fresh` as the first word to pick how much reruns', () => {
    const planned = (body: string) => plan(event(body), config)[0];
    expect(planned('/bothub fresh use it.each')).toMatchObject({ rerun: 'fresh', args: 'use it.each' });
    expect(planned('/bothub all')).toMatchObject({ rerun: 'all', args: '' });
    expect(planned('/bothub allow nulls')).toEqual(expect.not.objectContaining({ rerun: expect.anything() }));
  });

  it('ignores untrusted commenters and non-commands', () => {
    expect(plan(event('/bothub do it', 'NONE'), config)).toEqual([]);
    expect(plan(event('thanks!'), config)).toEqual([]);
    expect(plan(event('/bothubx do it'), config)).toEqual([]);
  });

  it('starts the reviewer on an opened pull request', () => {
    const pr: BotEvent = {
      ...event(''),
      trigger: 'pull_request',
      action: 'opened',
      actor: { login: 'b', association: 'MEMBER' },
    };
    expect(plan(pr, config)).toEqual([{ workflow: 'issue', job: 'review', bot: 'reviewer' }]);
    expect(plan({ ...pr, action: 'closed' }, config)).toEqual([]);
  });
});

describe('plan with a branches filter', () => {
  const filtered = ((): Config => {
    const result = compile([
      { path: 'bots/bot.md', source: '---\nharness: opencode\ntools: []\nreturns: []\nmax-turns: 5\n---\n\nBot.' },
      { path: 'skills/go.md', source: '---\ndescription: Go.\n---\n\nGo.' },
      {
        path: 'workflows/release.md',
        source: `---
name: release
on:
  push: { branches: [main] }
  pull_request: { branches: [main, 'bothub/*'] }
jobs:
  go: { type: bot, bot: bot, skill: go }
---
`,
      },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.config;
  })();
  const base: BotEvent = {
    id: 'd',
    ts: '2026-10-12T00:00:00.000Z',
    source: 'github',
    trigger: 'push',
    repo: 'acme/app',
    actor: { login: 'x', association: 'MEMBER' },
  };

  it('matches pushes and pull requests on their branch, not their ref', () => {
    const go = [{ workflow: 'release', job: 'go', bot: 'bot' }];
    expect(plan({ ...base, ref: 'refs/heads/main', branch: 'main' }, filtered)).toEqual(go);
    expect(plan({ ...base, ref: 'refs/heads/dev', branch: 'dev' }, filtered)).toEqual([]);
    expect(plan({ ...base, ref: 'refs/tags/v1' }, filtered)).toEqual([]);
    const pr: BotEvent = { ...base, trigger: 'pull_request', number: 9, ref: 'refs/pull/9/head' };
    expect(plan({ ...pr, branch: 'main' }, filtered)).toEqual(go);
    expect(plan({ ...pr, branch: 'dev' }, filtered)).toEqual([]);
    expect(plan({ ...pr, branch: 'bothub/5' }, filtered)).toEqual(go);
    expect(plan({ ...pr, branch: 'bothub/5/x' }, filtered)).toEqual([]);
  });
});

describe('parseCommand', () => {
  it('finds the command or its mention as a whole word anywhere outside quotes and code', () => {
    expect(parseCommand('  /bothub  ', '/bothub')).toBe('');
    expect(parseCommand('/bothub go', '/bothub')).toBe('go');
    expect(parseCommand('please /bothub go', '/bothub')).toBe('go');
    expect(parseCommand('thanks.\n\n@bothub, fix the\ntest', '/bothub')).toBe('fix the\ntest');
    expect(parseCommand('/bothubx go', '/bothub')).toBeUndefined();
    expect(parseCommand('mail me@example.com', '/bothub')).toBeUndefined();
    expect(parseCommand('> /bothub fresh\n\nagreed', '/bothub')).toBeUndefined();
    expect(parseCommand('```\n/bothub go\n```\n', '/bothub')).toBeUndefined();
    expect(parseCommand('```\nx\n```\n/bothub go', '/bothub')).toBe('go');
  });
});

describe('trust', () => {
  const labeled = (sender: string, author: string, association = 'NONE') =>
    toEvent('issues', 'd8', {
      action: 'labeled',
      repository: { full_name: 'acme/app' },
      sender: { login: sender },
      issue: { number: 7, html_url: 'u', user: { login: author }, author_association: association },
      label: { name: 'ready' },
    }) as BotEvent;
  const permissions = (by: Record<string, string>) => {
    const asked: string[] = [];
    const client = gh('t', async url => {
      const login = /collaborators\/([^/]+)\/permission$/.exec(url)?.[1] ?? '';
      asked.push(login);
      const role = by[login];
      return role
        ? new Response(JSON.stringify({ permission: role === 'maintain' ? 'write' : role, role_name: role }))
        : new Response('{"message":"Not Found"}', { status: 404 });
    });
    return { asked, client };
  };

  it("trusts a label by its sender's write access, not by who wrote the issue", async () => {
    const { asked, client } = permissions({ maintainer: 'maintain', triager: 'triage', reader: 'read' });
    expect(labeled('maintainer', 'outsider').actor).toEqual({ login: 'maintainer', association: 'NONE' });
    expect((await senderTrust(labeled('maintainer', 'outsider'), client)).actor.association).toBe('COLLABORATOR');
    expect((await senderTrust(labeled('triager', 'owner', 'OWNER'), client)).actor.association).toBe('NONE');
    expect((await senderTrust(labeled('reader', 'owner', 'OWNER'), client)).actor.association).toBe('NONE');
    expect((await senderTrust(labeled('stranger', 'owner', 'OWNER'), client)).actor.association).toBe('NONE');
    expect((await senderTrust(labeled('app[bot]', 'owner', 'OWNER'), client)).actor.association).toBe('NONE');
    expect(asked).toEqual(['maintainer', 'triager', 'reader', 'stranger']);
  });

  it('keeps the association of what the sender wrote without a lookup', async () => {
    const { asked, client } = permissions({});
    expect((await senderTrust(labeled('owner', 'owner', 'OWNER'), client)).actor.association).toBe('OWNER');
    const edited = toEvent('issue_comment', 'd9', {
      ...commentPayload('/bothub go'),
      action: 'edited',
      sender: { login: 'outsider' },
      comment: { body: '/bothub go', html_url: 'u', user: { login: 'morgan' }, author_association: 'OWNER' },
    }) as BotEvent;
    expect(edited.actor).toEqual({ login: 'outsider', association: 'NONE' });
    expect(asked).toEqual([]);
  });
});

describe('visible', () => {
  it('drops HTML comments, invisible format characters and tag characters', () => {
    expect(visible('a<!-- do x -->b<!--\nmulti\n-->c')).toBe('abc');
    expect(visible('shown <!-- unclosed hides the rest')).toBe('shown ');
    expect(visible('z\u200bw\u200c\u200d\u2060\ufeff\u00ad|bidi\u202e\u2066\u2069\u200f\u061c|')).toBe('zw|bidi|');
    const tags = [...'ignore all'].map(c => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join('');
    expect(visible(`ok${tags}\u{e0101}`)).toBe('ok');
    expect(visible('café \u{1f600} `<b>`')).toBe('café \u{1f600} `<b>`');
  });

  it('gives events the visible body and reads the App mention as @bothub', () => {
    const body = '<!-- /bothub fresh -->@bothub-acme go\u200b';
    const event = toEvent('issue_comment', 'd', commentPayload(body), now, 'bothub-acme');
    expect(event?.body).toBe('@bothub go');
    expect(plan(event!, config)).toMatchObject([{ job: 'implement', args: 'go' }]);
    const other = toEvent('issue_comment', 'd', commentPayload('@bothub-acmex go'), now, 'bothub-acme');
    expect(other?.body).toBe('@bothub-acmex go');
  });
});
