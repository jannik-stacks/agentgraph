import { describe, expect, it } from 'vitest';
import { forwardToGateway, type Network, reachOf } from '../examples/deploy/cloudflare/gateway.ts';

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
    const plain = await sent({ authorization: 'Bearer session' }, 'https://litellm.example.com/v1/');
    const aig = await sent(
      { authorization: 'Bearer session' },
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
      JSON.stringify({ 'cf-aig-authorization': 'Bearer gw', authorization: '' })
    );
    expect(plain).toEqual({
      url: 'https://litellm.example.com/v1/chat/completions?x=1',
      headers: { authorization: 'Bearer session', 'content-type': 'text/plain;charset=UTF-8' },
      redirect: 'manual',
    });
    expect(aig.url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions?x=1');
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
