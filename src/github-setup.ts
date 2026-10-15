import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { serve } from './api.ts';
import type { Fetch } from './github-app.ts';

/** The one bothub App: private, no webhook, and only the permissions the runner uses. */
export const manifest = (name: string, base: string) => ({
  name,
  url: 'https://github.com',
  redirect_url: `${base}/created`,
  setup_url: `${base}/installed`,
  setup_on_update: false,
  public: false,
  default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
  default_events: [],
});

type Created = { id: number; slug: string; pem: string; html_url: string };

const html = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>bothub setup</title>${body}`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const escape = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Creates the bothub GitHub App through the manifest flow on a page served on 127.0.0.1. The page sends the manifest
 * to GitHub, where the user clicks Create; GitHub redirects back with a code, which is exchanged for the App's id,
 * slug and private key. They are written to `<dir>/<slug>/key.pem` and `<dir>/<slug>/app.env`, both 0600. GitHub
 * then shows the install page; once installed, the installation id is added to `app.env`. Resolves to the env file.
 */
export const setupApp = async ({
  dir = join(homedir(), '.config', 'bothub'),
  name = 'bothub',
  org,
  port = 5189,
  fetch: fetcher = globalThis.fetch,
  log = (line: string) => process.stderr.write(`${line}\n`),
  listening,
}: {
  dir?: string;
  name?: string;
  org?: string;
  port?: number;
  fetch?: Fetch;
  log?: (line: string) => void;
  listening?: (url: string) => void;
}) => {
  const state = randomUUID();
  let base = '';
  let created: { slug: string; env: string; html_url: string } | undefined;
  let finish: (env: string) => void = () => {};
  const done = new Promise<string>(resolve => (finish = resolve));

  const save = async (app: Created) => {
    if (!/^[a-z0-9-]+$/.test(app.slug)) throw new Error(`unexpected App slug "${app.slug}"`);
    const home = join(dir, app.slug);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const key = join(home, 'key.pem');
    const env = join(home, 'app.env');
    await writeFile(key, app.pem, { mode: 0o600 });
    const lines = [`BOTHUB_APP_ID=${app.id}`, `BOTHUB_APP_SLUG=${app.slug}`, `BOTHUB_APP_KEY_FILE=${key}`];
    await writeFile(env, `${lines.join('\n')}\n`, { mode: 0o600 });
    return { slug: app.slug, env, html_url: app.html_url };
  };

  const handler = async (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === '/') {
      const target = org
        ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
        : 'https://github.com/settings/apps/new';
      const json = escape(JSON.stringify(manifest(name, base)));
      return html(
        `<form id="f" method="post" action="${target}?state=${state}"><input type="hidden" name="manifest" value="${json}">` +
          `<p>Sending the bothub App manifest to GitHub. Click Create there.</p><button>Continue to GitHub</button></form>` +
          `<script>document.getElementById('f').submit()</script>`
      );
    }
    if (url.pathname === '/created') {
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.get('state') !== state) return html('<p>State mismatch. Start the setup again.</p>', 400);
      if (created) return Response.redirect(`${created.html_url}/installations/new`, 302);
      const res = await fetcher(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bothub' },
      });
      if (!res.ok) return html(`<p>GitHub refused the code (${res.status}). Start the setup again.</p>`, 502);
      const app = (await res.json()) as Created;
      created = await save(app);
      log(`created App ${created.slug}; id, slug and key saved under ${join(dir, created.slug)}`);
      log(`install it: ${created.html_url}/installations/new`);
      return Response.redirect(`${created.html_url}/installations/new`, 302);
    }
    if (url.pathname === '/installed' && created) {
      const id = url.searchParams.get('installation_id');
      if (url.searchParams.get('setup_action') === 'request' || !id || !/^\d+$/.test(id)) {
        log('installation requested: an owner of the organization must approve it, then run the setup again');
        finish(created.env);
        return html('<p>Installation requested. An organization owner must approve it on GitHub.</p>');
      }
      await writeFile(created.env, `BOTHUB_INSTALLATION_ID=${id}\n`, { flag: 'a', mode: 0o600 });
      log(`installed as installation ${id}; settings in ${created.env}`);
      finish(created.env);
      return html('<p>bothub is installed. You can close this tab.</p>');
    }
    return html('<p>Not found.</p>', 404);
  };

  const server = await serve(handler, port);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  log(`open ${base}/ to create the App`);
  listening?.(base);
  try {
    return await done;
  } finally {
    server.close();
  }
};

/** `bothub setup-app`: creates the bothub GitHub App and saves its settings outside the repository. */
export const setupAppCommand = defineCommand({
  meta: { name: 'setup-app', description: 'Create the bothub GitHub App and save its id, slug and key' },
  args: {
    org: { type: 'string', description: 'Organization that owns the App (default: your account)' },
    name: { type: 'string', description: 'App name, unique on GitHub', default: 'bothub' },
    dir: { type: 'string', description: 'Where to save it (default: ~/.config/bothub)' },
    port: { type: 'string', description: 'Local port for the setup page', default: '5189' },
  },
  async run({ args }) {
    const env = await setupApp({
      name: args.name,
      port: Number(args.port),
      ...(args.org && { org: args.org }),
      ...(args.dir && { dir: args.dir }),
    });
    process.stdout.write(`${env}\n`);
    return 0;
  },
});
