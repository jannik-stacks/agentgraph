import { execFile } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const probe = join(import.meta.dirname, '..', 'bin', 'leak-probe.ts');
const canary = 'FAKE-canary-7f3a9c';

const runProbe = async (env: Record<string, string>, ...sections: string[]) => {
  try {
    const { stdout } = await promisify(execFile)('node', [probe, ...sections], { env: { NODE_OPTIONS: '', ...env } });
    return { code: 0, out: stdout };
  } catch (e) {
    const { code, stdout } = e as { code: number; stdout: string };
    return { code, out: stdout };
  }
};

describe('leak-probe', () => {
  it('names every planted key by where it sits, splits off keys at rest, and never prints a value', async () => {
    const dir = tmp('probe');
    const home = join(dir, 'home');
    const fake = 'sk-bh-scout-0123456789abcdef';
    write(dir, {
      'home/.keys.env': `AGENTGRAPH_LLM_API_KEY_SCOUT=${canary}\n`,
      'home/clean.txt': 'nothing here\n',
      'home/master.env': 'export LITELLM_MASTER_KEY="unprefixed-master-value"\n',
      'home/header.ts': 'const pem = "-----BEGIN PRIVATE KEY-----\\n";\n',
      'home/.env.example': `KEY=${fake}\n`,
      'home/apply.test.ts': `const key = '${fake}';\n`,
      'home/target/debug/out': `${fake}\n`,
      'home/lib.rlib': `\0${fake}\n`,
      'home/stray/keys.env': `AGENTGRAPH_LLM_API_KEY_SCOUT=${fake}\n`,
      'home/old/id_rsa': `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\n${'B'.repeat(64)}\n`,
      'home/.config/agentgraph/app/key.pem': `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(64)}\n`,
      'bin/ps': `#!/bin/sh\ncase "$3" in *,comm=) printf '  4242 /usr/bin/node\\n  4343 /usr/bin/node\\n  4444 /usr/bin/node\\n'; exit 0;; esac\ne=; [ "$1" = axeww ] && e=" LITELLM_MASTER_KEY=unprefixed-master-value DB_PASSWORD=correct horse battery"\necho "  4242 ${canary} --key x"\necho "  4343 node app"\necho "  4444 node app.js$e"\n`,
      'bin/docker': `#!/bin/sh\n[ "$1" = ps ] && { echo abc; exit 0; }\nprintf '/agentgraph-litellm\\t["LITELLM_MASTER_KEY=${canary}","PATH=/bin"]\\n'\n`,
    });
    for (const shim of ['ps', 'docker']) chmodSync(join(dir, 'bin', shim), 0o755);
    const server = createServer((req, res) => res.end(req.url?.endsWith('.keys.env') ? canary : 'clean'));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const studio = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { code, out } = await runProbe({
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        HOME: home,
        PROBE_CANARY: canary,
        PROBE_PATHS: home,
        PROBE_STUDIO: studio,
        AGENTGRAPH_APP_KEY: canary,
        AGENTGRAPH_DIR: '.agentgraph',
      });
      expect(code).toBe(1);
      expect(out.split('\n').filter(Boolean).sort()).toEqual(
        [
          'look at this',
          '  env AGENTGRAPH_APP_KEY',
          `  file ${join(home, '.keys.env')}  1 key(s)`,
          '  ps 4242 node  argv',
          '  ps 4444 node app.js  LITELLM_MASTER_KEY DB_PASSWORD',
          `  file ${join(home, 'stray/keys.env')}  1 key(s)`,
          `  file ${join(home, 'old/id_rsa')}  1 key(s)`,
          `  studio ${join(home, '.keys.env')}`,
          'expected',
          `  file ${join(home, '.config/agentgraph/app/key.pem')}  1 key(s)`,
          '  docker /agentgraph-litellm  LITELLM_MASTER_KEY',
          'look at 7: 1 env, 3 file, 2 ps, 1 studio; expected 2: 1 file, 1 docker',
        ].sort()
      );
      expect(out).not.toContain(canary);
      expect(out).not.toContain(fake);
    } finally {
      server.close();
    }
  });

  it('passes a clean environment', async () => {
    const dir = tmp('probe-clean');
    write(dir, { 'home/notes.txt': 'nothing here\n' });
    const { code, out } = await runProbe(
      { PATH: process.env.PATH ?? '', PROBE_CANARY: canary, PROBE_PATHS: join(dir, 'home') },
      'env',
      'files'
    );
    expect([code, out.trim()]).toEqual([0, 'nothing to look at']);
  });

  it('says so when a probe could not run', async () => {
    const dir = tmp('probe-skip');
    write(dir, {
      'bin/docker': '#!/bin/sh\necho "daemon down" >&2\nexit 1\n',
      'home/.keys.env': 'AGENTGRAPH_LLM_API_KEY_SCOUT=sk-bh-scout-0123456789abcdef\n',
    });
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    const { code, out } = await runProbe(
      {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        PROBE_PATHS: join(dir, 'home'),
        PROBE_STUDIO: 'http://127.0.0.1:9',
      },
      'docker',
      'studio'
    );
    expect([code, out.trim()]).toEqual([
      3,
      'skip docker: docker ps failed: daemon down\nskip studio: no answer from the studio\nnothing to look at, but not every probe ran',
    ]);
  });

  it('refuses an unknown section', async () => {
    expect((await runProbe({ PATH: process.env.PATH ?? '' }, 'memory')).code).toBe(2);
    expect((await runProbe({ PATH: process.env.PATH ?? '' }, 'toString')).code).toBe(2);
  });
});
