import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupApp } from '../bin/setup-app.ts';
import { tmp } from './fixtures.ts';

describe('setupApp', () => {
  it('creates the App from the manifest and saves its id and key 0600', async () => {
    const dir = tmp('config');
    const exchanged: string[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      exchanged.push(`${init?.method} ${url}`);
      return Response.json({
        id: 7,
        slug: 'agentgraph-acme',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\n',
        html_url: 'https://github.com/apps/agentgraph-acme',
        client_secret: 'not kept',
      });
    }) as typeof globalThis.fetch;
    const logged: string[] = [];
    let base = '';
    let ready = () => {};
    const started = new Promise<void>(resolve => (ready = resolve));
    const finished = setupApp({
      dir,
      port: 0,
      fetch,
      log: line => logged.push(line),
      listening: url => ((base = url), ready()),
    });
    await started;

    const page = await (await globalThis.fetch(`${base}/`)).text();
    const state = /\?state=([\w-]+)/.exec(page)?.[1];
    const sent = JSON.parse(/value="([^"]+)"/.exec(page)![1]!.replace(/&quot;/g, '"'));
    expect(sent).toMatchObject({
      public: false,
      redirect_url: `${base}/created`,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
      default_events: [],
    });
    expect(sent).not.toHaveProperty('hook_attributes');
    expect(page).toContain('action="https://github.com/settings/apps/new?state=');

    expect((await globalThis.fetch(`${base}/created?code=c1&state=wrong`)).status).toBe(400);
    const created = await globalThis.fetch(`${base}/created?code=c1&state=${state}`, { redirect: 'manual' });
    expect(created.headers.get('location')).toBe('https://github.com/apps/agentgraph-acme/installations/new');
    expect(exchanged).toEqual(['POST https://api.github.com/app-manifests/c1/conversions']);

    const env = await finished;
    const home = join(dir, 'agentgraph-acme');
    expect(env).toBe(join(home, 'app.env'));
    expect(readFileSync(env, 'utf8')).toBe(`AGENTGRAPH_APP_ID=7\nAGENTGRAPH_APP_KEY_FILE=${join(home, 'key.pem')}\n`);
    expect(statSync(join(home, 'key.pem')).mode & 0o777).toBe(0o600);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(home, 'key.pem'), 'utf8')).toContain('secret');
    expect(logged.join('\n')).not.toContain('secret');
  });
});
