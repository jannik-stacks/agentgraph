import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it } from 'vitest';
import cloudflareAccess from '../examples/plugins/cloudflare-access.ts';
import { readPlugins } from '../src/plugin.ts';

it('lets in verified Cloudflare Access emails on an allowed domain and refuses the rest', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const jwks = createServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve));
  const team = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  try {
    const { auths } = await readPlugins(
      undefined,
      { 'cloudflare-access': { team: `${team}/some/path`, audience: 'studio-aud', domains: ['example.test'] } },
      { builtins: [cloudflareAccess] }
    );
    const check = auths['cloudflare-access']!({ env: {} });
    const sign = (email: string, claims: { audience?: string; key?: CryptoKey } = {}) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(team)
        .setAudience(claims.audience ?? 'studio-aud')
        .setExpirationTime('5m')
        .sign(claims.key ?? privateKey);
    const ask = async (assertion?: string) =>
      check({
        url: new URL('http://studio/'),
        headers: assertion === undefined ? {} : { 'cf-access-jwt-assertion': assertion },
      });
    expect([
      await ask(await sign('ana@example.test')),
      await ask(await sign('bo@eu.example.test')),
      await ask(await sign('eve@evilexample.test')),
      await ask(await sign('ana@example.test', { audience: 'other-app' })),
      await ask(await sign('ana@example.test', { key: other.privateKey })),
      await ask(),
    ]).toEqual([
      { kind: 'user', user: 'ana@example.test' },
      { kind: 'user', user: 'bo@eu.example.test' },
      { kind: 'refuse', why: 'eve@evilexample.test is not on an allowed domain' },
      { kind: 'refuse', why: 'the Cloudflare Access token does not verify' },
      { kind: 'refuse', why: 'the Cloudflare Access token does not verify' },
      { kind: 'refuse', why: 'open the studio through Cloudflare Access' },
    ]);
  } finally {
    jwks.close();
  }
});
