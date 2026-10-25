/**
 * Creates the agentgraph GitHub App through the manifest flow and saves its id in `<dir>/<slug>/app.env`, 0600. On macOS
 * the key goes into the login Keychain, which asks on every read; elsewhere, or when the Keychain refuses, into a 0600
 * `key.pem` beside it. Point `AGENTGRAPH_APP_ENV` at the `app.env` it prints, then install the App on the repo.
 * Usage: node bin/setup-app.ts [--org <org>] [--name agentgraph] [--dir ~/.config/agentgraph] [--port 5189]
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The one agentgraph App: private, no webhook, and only the permissions the engine uses. */
const makeGithubAppSetupManifest = (name: string, base: string) => ({
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

const saveKeyInKeychain = async (slug: string, pem: string) => {
  const item = `agentgraph-app-${slug}`;
  const base64 = Buffer.from(pem).toString('base64');
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -T "" -a agentgraph -s ${item} -w ${base64}\n`,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  execFileSync('security', ['find-generic-password', '-a', 'agentgraph', '-s', item], { stdio: 'ignore' });
  return { file: '/dev/fd/3', start: `3< <(security find-generic-password -s ${item} -w | base64 -d)` };
};

const escape = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Serves the manifest page on 127.0.0.1, trades GitHub's code for the App and resolves to the saved env file. */
export const setupApp = async ({
  dir = join(homedir(), '.config', 'agentgraph'),
  name = 'agentgraph',
  org,
  port = 5189,
  fetch = globalThis.fetch,
  log = (line: string) => process.stderr.write(`${line}\n`),
  listening,
  saveKey,
}: {
  saveKey?: (slug: string, pem: string) => Promise<{ file: string; start: string }>;
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
    const env = join(home, 'app.env');
    const kept = await saveKey?.(app.slug, app.pem).catch((e: Error) => void log(`not in the Keychain: ${e.message}`));
    const file = kept?.file ?? join(home, 'key.pem');
    if (!kept) await writeFile(file, app.pem, { mode: 0o600 });
    else log(`the key is in the Keychain; start agentgraph with ${kept.start}`);
    await writeFile(env, `AGENTGRAPH_APP_ID=${app.id}\nAGENTGRAPH_APP_KEY_FILE=${file}\n`, { mode: 0o600 });
    return env;
  };

  const answer = async (url: URL): Promise<{ status: number; body?: string; location?: string; env?: string }> => {
    if (url.pathname === '/') {
      const target = org
        ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
        : 'https://github.com/settings/apps/new';
      const json = escape(JSON.stringify(makeGithubAppSetupManifest(name, base)));
      return {
        status: 200,
        body:
          `<form id="f" method="post" action="${target}?state=${state}"><input type="hidden" name="manifest" value="${json}">` +
          `<p>Sending the agentgraph App manifest to GitHub. Click Create there.</p><button>Continue to GitHub</button></form>` +
          `<script>document.getElementById('f').submit()</script>`,
      };
    }
    if (url.pathname !== '/created') return { status: 404, body: '<p>Not found.</p>' };
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.get('state') !== state)
      return { status: 400, body: '<p>State mismatch. Start the setup again.</p>' };
    const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentgraph' },
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
          body && `<!doctype html><meta charset="utf-8"><title>agentgraph setup</title>${body}`,
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
    ...(process.platform === 'darwin' && { saveKey: saveKeyInKeychain }),
  });
  console.log(env);
}
