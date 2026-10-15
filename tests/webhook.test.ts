import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { githubApp } from '../src/github-app.ts';
import type { BotEvent } from '../src/types.ts';
import { replay, webhook, type Delivery } from '../src/webhook.ts';

const secret = 'test-secret';
const url = 'http://127.0.0.1:5181/webhook';
const repository = { full_name: 'acme/app' };
const sender = { login: 'morgan' };
const issue = {
  number: 7,
  html_url: 'https://github.com/acme/app/issues/7',
  body: 'issue text',
  user: { login: 'x' },
  author_association: 'NONE',
};
const comment = (body: string, onPull = false) => ({
  action: 'created',
  installation: { id: 42 },
  repository,
  sender,
  issue: onPull ? { ...issue, pull_request: { url: 'u' } } : issue,
  comment: { body, html_url: `${issue.html_url}#c1`, author_association: 'OWNER' },
});

const hmac = (body: string, key = secret) => 'sha256=' + createHmac('sha256', key).update(body).digest('hex');

const request = (name: string, payload: unknown, headers: Record<string, string | null> = {}) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const all: Record<string, string | null> = {
    'x-github-event': name,
    'x-github-delivery': 'delivery-1',
    'x-hub-signature-256': hmac(body),
    ...headers,
  };
  return new Request(url, {
    method: 'POST',
    headers: Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== null)),
    body,
  });
};

const receiver = (options: Partial<Parameters<typeof webhook>[0]> = {}) => {
  const received: { event: BotEvent; deliveryId: string; delivery: Delivery }[] = [];
  let done: Promise<unknown> = Promise.resolve();
  const handler = webhook({
    secret,
    onEvent: (event, deliveryId, delivery) => void received.push({ event, deliveryId, delivery }),
    waitUntil: work => (done = work),
    ...options,
  });
  return { handler, received, settled: () => done };
};

describe('webhook signature', () => {
  it('accepts a valid signature', async () => {
    const { handler, received, settled } = receiver();
    expect((await handler(request('issue_comment', comment('/bothub go')))).status).toBe(202);
    await settled();
    expect(received).toHaveLength(1);
  });

  it('rejects a wrong or missing signature with 401', async () => {
    const { handler, received } = receiver();
    const payload = comment('/bothub go');
    const wrong = request('issue_comment', payload, { 'x-hub-signature-256': hmac(JSON.stringify(payload), 'nope') });
    expect((await handler(wrong)).status).toBe(401);
    expect((await handler(request('issue_comment', payload, { 'x-hub-signature-256': null }))).status).toBe(401);
    expect((await handler(request('issue_comment', payload, { 'x-hub-signature-256': 'sha1=abc' }))).status).toBe(401);
    expect(received).toEqual([]);
  });

  it('signs the raw bytes, so a re-serialised body fails', async () => {
    const { handler } = receiver();
    const raw = '{"action": "created"}';
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'd',
        'x-hub-signature-256': hmac(JSON.stringify(JSON.parse(raw))),
      },
      body: raw,
    });
    expect((await handler(req)).status).toBe(401);
  });

  it('refuses to start without a secret', () => {
    expect(() => webhook({ secret: '', onEvent: () => {} })).toThrow();
  });
});

describe('webhook delivery', () => {
  it('passes the delivery id, event name and installation through', async () => {
    const { handler, received, settled } = receiver();
    await handler(request('issue_comment', comment('/bothub go'), { 'x-github-delivery': 'abc-123' }));
    await settled();
    expect(received[0]).toMatchObject({
      deliveryId: 'abc-123',
      event: { id: 'abc-123', source: 'github' },
      delivery: { name: 'issue_comment', installation: 42 },
    });
  });

  it('maps a comment on an issue', async () => {
    const { handler, received, settled } = receiver();
    await handler(request('issue_comment', comment('/bothub go')));
    await settled();
    expect(received[0]?.event).toMatchObject({
      trigger: 'issue_comment',
      action: 'created',
      repo: 'acme/app',
      number: 7,
      body: '/bothub go',
      actor: { login: 'morgan', association: 'OWNER' },
    });
    expect(received[0]?.event).not.toHaveProperty('ref');
  });

  it('maps a comment on a pull request to its head ref', async () => {
    const { handler, received, settled } = receiver();
    await handler(request('issue_comment', comment('/bothub go', true)));
    await settled();
    expect(received[0]?.event).toMatchObject({ trigger: 'issue_comment', number: 7, ref: 'refs/pull/7/head' });
  });

  it('maps a push', async () => {
    const { handler, received, settled } = receiver();
    await handler(request('push', { ref: 'refs/heads/main', repository, sender }));
    await settled();
    expect(received[0]?.event).toMatchObject({ trigger: 'push', ref: 'refs/heads/main', branch: 'main' });
  });

  it('maps an opened pull request', async () => {
    const { handler, received, settled } = receiver();
    const pull_request = {
      number: 9,
      html_url: 'https://github.com/acme/app/pull/9',
      body: null,
      user: { login: 'b' },
      author_association: 'FIRST_TIME_CONTRIBUTOR',
      base: { ref: 'main' },
    };
    await handler(request('pull_request', { action: 'opened', repository, sender, pull_request }));
    await settled();
    expect(received[0]?.event).toMatchObject({
      trigger: 'pull_request',
      action: 'opened',
      number: 9,
      ref: 'refs/pull/9/head',
      branch: 'main',
      actor: { association: 'NONE' },
    });
  });

  it('answers unknown events with 204 and does nothing', async () => {
    const { handler, received } = receiver();
    expect((await handler(request('star', { action: 'created', repository, sender }))).status).toBe(204);
    expect((await handler(request('ping', { zen: 'Keep it logically awesome.' }))).status).toBe(204);
    expect(received).toEqual([]);
  });

  it('rejects malformed deliveries with 400', async () => {
    const { handler } = receiver();
    expect((await handler(request('issue_comment', '{not json'))).status).toBe(400);
    expect((await handler(request('issue_comment', { action: 'created' }))).status).toBe(400);
    expect((await handler(request('issue_comment', comment('x'), { 'x-github-delivery': null }))).status).toBe(400);
  });

  it('answers before the callback finishes and reports its errors', async () => {
    let release = () => {};
    const blocked = new Promise<void>(done => (release = done));
    const onError = vi.fn();
    const { handler, settled } = receiver({
      onEvent: async () => {
        await blocked;
        throw new Error('boom');
      },
      onError,
    });
    expect((await handler(request('issue_comment', comment('/bothub go')))).status).toBe(202);
    expect(onError).not.toHaveBeenCalled();
    release();
    await settled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), 'delivery-1');
  });

  it('only accepts POST', async () => {
    const { handler } = receiver();
    expect((await handler(new Request(url))).status).toBe(405);
  });
});

describe('webhook body limit', () => {
  it('rejects a declared or streamed body over the limit with 413', async () => {
    const { handler, received } = receiver({ maxBytes: 64 });
    const big = comment('x'.repeat(200));
    expect((await handler(request('issue_comment', big))).status).toBe(413);
    const body = JSON.stringify(big);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const streamed = new Request(url, {
      method: 'POST',
      headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': 'd', 'x-hub-signature-256': hmac(body) },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect((await handler(streamed)).status).toBe(413);
    expect(received).toEqual([]);
  });
});

describe('replay', () => {
  it('signs a saved payload so the receiver accepts it', async () => {
    const { handler, received, settled } = receiver();
    const payload = JSON.stringify(comment('/bothub go'), null, 2);
    const res = await replay({
      url,
      secret,
      event: 'issue_comment',
      payload,
      deliveryId: 'replay-1',
      fetch: (input, init) => handler(new Request(input, init)),
    });
    expect(res.status).toBe(202);
    await settled();
    expect(received[0]).toMatchObject({ deliveryId: 'replay-1', event: { body: '/bothub go' } });
  });

  it('is refused with the wrong secret', async () => {
    const { handler } = receiver();
    const res = await replay({
      url,
      secret: 'other',
      event: 'push',
      payload: JSON.stringify({ ref: 'refs/heads/main', repository, sender }),
      fetch: (input, init) => handler(new Request(input, init)),
    });
    expect(res.status).toBe(401);
  });
});

describe('githubApp per repository', () => {
  it('looks up the installation once and reuses its token', async () => {
    const { privateKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----`;
    const calls: string[] = [];
    const fetch = async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${input.replace('https://api.github.com', '')}`);
      if (input.endsWith('/installation')) return Response.json({ id: 42 });
      if (input.endsWith('/access_tokens'))
        return Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      return Response.json({ ok: true });
    };
    const app = githubApp({ appId: 1, privateKey: pem }, { fetch });
    const gh = app.repoClient('acme/app');
    await gh('GET', '/repos/acme/app');
    await gh('GET', '/repos/acme/app/issues/1');
    expect(await app.repoToken('acme/app')).toBe('ghs_test');
    expect(calls).toEqual([
      'GET /repos/acme/app/installation',
      'POST /app/installations/42/access_tokens',
      'GET /repos/acme/app',
      'GET /repos/acme/app/issues/1',
    ]);
  });
});
