import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { parseCommand, plan } from '../src/dispatch.ts';
import { toEvent, verifySignature } from '../src/github.ts';
import type { BotEvent } from '../src/types.ts';

const hub = join(import.meta.dirname, '../examples/hub');
const config = ((): Config => {
  const files = ['personas', 'workflows'].flatMap((dir) =>
    readdirSync(join(hub, dir)).map((name) => ({ path: `${dir}/${name}`, source: readFileSync(join(hub, dir, name), 'utf8') })),
  );
  const result = compile(files);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
})();

const now = new Date('2026-10-12T00:00:00Z');
const commentPayload = (body: string, association = 'OWNER') => ({
  action: 'created',
  repository: { full_name: 'acme/app' },
  sender: { login: 'morgan' },
  issue: { number: 7, html_url: 'https://github.com/acme/app/issues/7', body: 'issue text', user: { login: 'x' }, author_association: 'NONE' },
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

  it('carries the head ref of a pull request', () => {
    const event = toEvent('pull_request', 'd2', {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      sender: { login: 'bot' },
      pull_request: { number: 9, html_url: 'u', body: null, user: { login: 'bot' }, author_association: 'MEMBER', head: { ref: 'bothub/7' } },
    });
    expect(event).toMatchObject({ trigger: 'pull_request', number: 9, ref: 'bothub/7', actor: { association: 'MEMBER' } });
    expect(event).not.toHaveProperty('body');
  });

  it('ignores unhandled events and rejects malformed payloads', () => {
    expect(toEvent('star', 'd3', {})).toBeUndefined();
    expect(() => toEvent('issue_comment', 'd4', { action: 'created' })).toThrow();
  });
});

describe('plan', () => {
  const event = (body: string, association = 'OWNER') => toEvent('issue_comment', 'd', commentPayload(body, association)) as BotEvent;

  it('starts the implementor for a trusted command', () => {
    expect(plan(event('/bothub add a health check\nwith tests'), config)).toEqual([
      { workflow: 'issue-command', job: 'implement', persona: 'implementor', args: 'add a health check\nwith tests' },
    ]);
  });

  it('ignores untrusted commenters and non-commands', () => {
    expect(plan(event('/bothub do it', 'NONE'), config)).toEqual([]);
    expect(plan(event('thanks!'), config)).toEqual([]);
    expect(plan(event('/bothubx do it'), config)).toEqual([]);
  });

  it('starts the reviewer on an opened pull request', () => {
    const pr: BotEvent = { ...event(''), trigger: 'pull_request', action: 'opened', actor: { login: 'b', association: 'MEMBER' } };
    expect(plan(pr, config)).toEqual([{ workflow: 'issue-command', job: 'review', persona: 'reviewer' }]);
    expect(plan({ ...pr, action: 'closed' }, config)).toEqual([]);
  });
});

describe('parseCommand', () => {
  it('requires the command as a whole word at the start', () => {
    expect(parseCommand('  /bothub  ', '/bothub')).toBe('');
    expect(parseCommand('/bothub go', '/bothub')).toBe('go');
    expect(parseCommand('please /bothub go', '/bothub')).toBeUndefined();
  });
});
