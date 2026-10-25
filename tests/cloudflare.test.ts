import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type Network, reachOf } from '../examples/deploy/cloudflare/gateway.ts';
import { forwardToGateway } from '../examples/deploy/gateway/forward.ts';
import { startGateway } from '../examples/deploy/gateway/server.ts';

const sent = async (headers: Record<string, string>, base: string, extra?: string) => {
  const calls: { url: string; init: RequestInit }[] = [];
  await forwardToGateway(
    new Request('http://gateway.internal/v1/chat/completions?x=1', { method: 'POST', headers, body: '{}' }),
    base,
    extra,
    async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response('ok');
    }
  );
  const [call] = calls;
  return {
    url: call!.url,
    headers: Object.fromEntries(new Headers(call!.init.headers)),
    redirect: call!.init.redirect,
  };
};

const box = (...networks: Network[]) => new Map(networks.map(network => [network, 1]));

describe('cloudflare gateway', () => {
  it('sends a session request to the gateway base, with the gateway headers set or removed', async () => {
    const plain = await sent({ authorization: 'Bearer session' }, 'https://litellm.example.com/');
    const aig = await sent(
      { authorization: 'Bearer session' },
      'https://gateway.ai.cloudflare.com/v1/acct/gw',
      JSON.stringify({ 'cf-aig-authorization': 'Bearer gw', authorization: '' })
    );
    expect(plain).toEqual({
      url: 'https://litellm.example.com/v1/chat/completions?x=1',
      headers: { authorization: 'Bearer session', 'content-type': 'text/plain;charset=UTF-8' },
      redirect: 'manual',
    });
    expect(aig.url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/v1/chat/completions?x=1');
    expect(aig.headers).toEqual({ 'cf-aig-authorization': 'Bearer gw', 'content-type': 'text/plain;charset=UTF-8' });
  });

  it('lets a box reach the gateway and registries only while a command on that network runs', () => {
    const egress = [/^registry\.npmjs\.org$/];
    const reach = (running: Map<Network, number>) =>
      ['gateway.internal', 'registry.npmjs.org', 'example.com'].map(host => reachOf(running, egress, host));
    expect(reach(box())).toEqual(['none', 'none', 'none']);
    expect(reach(box('none'))).toEqual(['none', 'none', 'none']);
    expect(reach(box('models'))).toEqual(['gateway', 'none', 'none']);
    expect(reach(box('egress'))).toEqual(['gateway', 'pass', 'none']);
    expect(reach(box('open'))).toEqual(['gateway', 'pass', 'pass']);
    expect(reach(new Map([['egress', 0]]))).toEqual(['none', 'none', 'none']);
  });
});

describe('gateway relay', () => {
  it('streams the answer of GATEWAY_URL back with GATEWAY_HEADERS applied', async () => {
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const server = startGateway(
      { GATEWAY_URL: 'https://openrouter.ai/api', GATEWAY_HEADERS: JSON.stringify({ authorization: 'Bearer real' }) },
      0,
      async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init!.headers),
          body: new TextDecoder().decode(init!.body as ArrayBuffer),
        });
        return new Response('data: one\n\ndata: two\n\n', {
          status: 201,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
    );
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const answer = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer session', 'content-type': 'application/json' },
        body: '{"model":"m"}',
      });
      expect([answer.status, answer.headers.get('content-type'), await answer.text()]).toEqual([
        201,
        'text/event-stream',
        'data: one\n\ndata: two\n\n',
      ]);
      expect(calls.map(c => [c.url, c.headers.get('authorization'), c.headers.has('host'), c.body])).toEqual([
        ['https://openrouter.ai/api/v1/messages', 'Bearer real', false, '{"model":"m"}'],
      ]);
      const unset = startGateway({}, 0);
      await new Promise(resolve => unset.once('listening', resolve));
      const missing = await fetch(`http://127.0.0.1:${(unset.address() as AddressInfo).port}/v1/models`);
      unset.close();
      expect(missing.status).toBe(502);
      const broken = await forwardToGateway(
        new Request('http://gateway/v1/models'),
        'https://example.com',
        JSON.stringify({ authorization: 'Bearer secret\nvalue' })
      );
      expect([broken.status, await broken.text()]).toEqual([502, 'gateway: request failed\n']);
      const large = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        body: new Uint8Array(33 * 1024 * 1024),
      });
      expect(large.status).toBe(413);
    } finally {
      server.close();
    }
  });
});
