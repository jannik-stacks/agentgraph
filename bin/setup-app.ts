/**
 * Creates the bothub GitHub App through the manifest flow and saves its id and key, both 0600, under
 * `<dir>/<slug>/`. Point `BOTHUB_APP_ENV` at the `app.env` it prints, then install the App on the repo.
 * Usage: node bin/setup-app.ts [--org <org>] [--name bothub] [--dir ~/.config/bothub] [--port 5189]
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The one bothub App: private, no webhook, and only the permissions the engine uses. */
export const manifest = (name: string, base: string) => ({
  name,
  url: 'https://github.com',
  redirect_url: `${base}/created`,
  public: false,
  default_permissions: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    metadata: 'read',
    checks: 'read',
    statuses: 'read',
  },
  default_events: [],
});

const escape = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Serves the manifest page on 127.0.0.1, trades GitHub's code for the App and resolves to the saved env file. */
export const setupApp = async ({
  dir = join(homedir(), '.config', 'bothub'),
  name = 'bothub',
  org,
  port = 5189,
  fetch = globalThis.fetch,
  log = (line: string) => process.stderr.write(`${line}\n`),
  listening,
}: {
  dir?: string;
  name?: string;
  org?: string;
  port?: number;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
  listening?: (url: string) => void;
}): Promise<string> => {
  const state = randomUUID();
  let base = '';
  let finish: (env: string) => void = () => {};
  const done = new Promise<string>(resolve => (finish = resolve));

  const save = async (app: { id: number; slug: string; pem: string }) => {
    if (!/^[a-z0-9-]+$/.test(app.slug)) throw new Error(`unexpected App slug "${app.slug}"`);
    const home = join(dir, app.slug);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const key = join(home, 'key.pem');
    const env = join(home, 'app.env');
    await writeFile(key, app.pem, { mode: 0o600 });
    await writeFile(env, `BOTHUB_APP_ID=${app.id}\nBOTHUB_APP_KEY_FILE=${key}\n`, { mode: 0o600 });
    return env;
  };

  const answer = async (url: URL): Promise<{ status: number; body?: string; location?: string; env?: string }> => {
    if (url.pathname === '/') {
      const target = org
        ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
        : 'https://github.com/settings/apps/new';
      const json = escape(JSON.stringify(manifest(name, base)));
      return {
        status: 200,
        body:
          `<form id="f" method="post" action="${target}?state=${state}"><input type="hidden" name="manifest" value="${json}">` +
          `<p>Sending the bothub App manifest to GitHub. Click Create there.</p><button>Continue to GitHub</button></form>` +
          `<script>document.getElementById('f').submit()</script>`,
      };
    }
    if (url.pathname !== '/created') return { status: 404, body: '<p>Not found.</p>' };
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.get('state') !== state)
      return { status: 400, body: '<p>State mismatch. Start the setup again.</p>' };
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bothub' },
    });
    if (!res.ok) return { status: 502, body: `<p>GitHub refused the code (${res.status}). Start the setup again.</p>` };
    const app = (await res.json()) as { id: number; slug: string; pem: string; html_url: string };
    const env = await save(app);
    log(`created App ${app.slug}; id and key saved under ${join(dir, app.slug)}`);
    log(`install it on the repo: ${app.html_url}/installations/new`);
    return { status: 302, location: `${app.html_url}/installations/new`, env };
  };

  const server = createServer((req, res) => {
    answer(new URL(req.url ?? '/', base)).then(
      ({ status, body, location, env }) => {
        res.writeHead(status, location ? { location } : { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          body && `<!doctype html><meta charset="utf-8"><title>bothub setup</title>${body}`,
          () => env && finish(env)
        );
      },
      (e: Error) => {
        res.writeHead(500).end(escape(e.message));
      }
    );
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  log(`open ${base}/ to create the App`);
  listening?.(base);
  try {
    return await done;
  } finally {
    server.close();
    server.closeAllConnections();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { org: { type: 'string' }, name: { type: 'string' }, dir: { type: 'string' }, port: { type: 'string' } },
  });
  const env = await setupApp({
    ...(values.org && { org: values.org }),
    ...(values.name && { name: values.name }),
    ...(values.dir && { dir: values.dir }),
    ...(values.port && { port: Number(values.port) }),
  });
  console.log(env);
}
