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
  it('names every planted canary by where it sits and never prints its value', async () => {
    const dir = tmp('probe');
    write(dir, {
      'home/.keys.env': `AGENTGRAPH_LLM_API_KEY_SCOUT=${canary}\n`,
      'home/clean.txt': 'nothing here\n',
      'bin/ps': `#!/bin/sh\necho "  4242 node app --key ${canary}"\necho "  4343 node app"\n`,
      'bin/docker': `#!/bin/sh\n[ "$1" = ps ] && { echo abc; exit 0; }\nprintf '/agentgraph-litellm\\t["LITELLM_MASTER_KEY=${canary}","PATH=/bin"]\\n'\n`,
    });
    for (const shim of ['ps', 'docker']) chmodSync(join(dir, 'bin', shim), 0o755);
    const server = createServer((req, res) => res.end(req.url?.endsWith('.keys.env') ? canary : 'clean'));
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const studio = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const { code, out } = await runProbe({
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        PROBE_CANARY: canary,
        PROBE_PATHS: join(dir, 'home'),
        PROBE_STUDIO: studio,
        AGENTGRAPH_APP_KEY: canary,
        AGENTGRAPH_HUB: '.agentgraph',
      });
      expect(code).toBe(1);
      expect(out.split('\n').filter(Boolean).sort()).toEqual(
        [
          'env AGENTGRAPH_APP_KEY',
          `file ${join(dir, 'home/.keys.env')}`,
          'ps 4242',
          'docker /agentgraph-litellm LITELLM_MASTER_KEY',
          `studio ${join(dir, 'home/.keys.env')}`,
          '5 hit(s)',
        ].sort()
      );
      expect(out).not.toContain(canary);
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
    expect([code, out.trim()]).toEqual([0, 'no hits']);
  });

  it('refuses an unknown section', async () => {
    expect((await runProbe({ PATH: process.env.PATH ?? '' }, 'memory')).code).toBe(2);
  });
});
