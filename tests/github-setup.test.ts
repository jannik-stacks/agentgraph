import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fetch } from '../src/github-app.ts';
import { setupApp } from '../src/github-setup.ts';
import { temp } from './kit.ts';

describe('setupApp', () => {
  it('creates the App from the manifest, saves its key 0600 and records the installation', async () => {
    const dir = temp('config');
    const exchanged: string[] = [];
    const fetch: Fetch = async (url, init) => {
      exchanged.push(`${init?.method} ${url}`);
      return Response.json({
        id: 7,
        slug: 'bothub-acme',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\n',
        html_url: 'https://github.com/apps/bothub-acme',
        client_secret: 'not kept',
      });
    };
    const logged: string[] = [];
    let base = '';
    let ready = () => {};
    const started = new Promise<void>(resolve => (ready = resolve));
    const listening = (url: string) => {
      base = url;
      ready();
    };
    const finished = setupApp({ dir, port: 0, fetch, log: line => logged.push(line), listening });
    await started;

    const page = await (await globalThis.fetch(`${base}/`)).text();
    const state = /\?state=([\w-]+)/.exec(page)?.[1];
    const sent = JSON.parse(/value="([^"]+)"/.exec(page)![1]!.replace(/&quot;/g, '"'));
    expect(sent).toMatchObject({
      public: false,
      redirect_url: `${base}/created`,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
    });
    expect(sent).not.toHaveProperty('hook_attributes');
    expect(page).toContain('action="https://github.com/settings/apps/new?state=');

    expect((await globalThis.fetch(`${base}/created?code=c1&state=wrong`)).status).toBe(400);
    const created = await globalThis.fetch(`${base}/created?code=c1&state=${state}`, { redirect: 'manual' });
    expect(created.headers.get('location')).toBe('https://github.com/apps/bothub-acme/installations/new');
    expect(exchanged).toEqual(['POST https://api.github.com/app-manifests/c1/conversions']);

    await globalThis.fetch(`${base}/installed?installation_id=42&setup_action=install`);
    const env = await finished;
    const home = join(dir, 'bothub-acme');
    expect(env).toBe(join(home, 'app.env'));
    expect(readFileSync(env, 'utf8')).toBe(
      `BOTHUB_APP_ID=7\nBOTHUB_APP_SLUG=bothub-acme\nBOTHUB_APP_KEY_FILE=${join(home, 'key.pem')}\nBOTHUB_INSTALLATION_ID=42\n`
    );
    expect(statSync(join(home, 'key.pem')).mode & 0o777).toBe(0o600);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(home, 'key.pem'), 'utf8')).toContain('secret');
    expect(logged.join('\n')).not.toContain('secret');
  });
});
