import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startStudioServer, studioDir } from './studio.ts';

const root = join(studioDir, '..');

describe('studio dev server', () => {
  it('serves files from the studio, src and node_modules only, and no env or key file there', async () => {
    // UNEXPECTED: a probe under the studio root reloads the studio servers of tests running alongside.
    const planted = join(root, 'node_modules', `.probe-${randomUUID()}`);
    const { server, base } = await startStudioServer();
    try {
      mkdirSync(planted);
      writeFileSync(join(planted, '.keys.env'), 'AGENTGRAPH_LLM_API_KEY_SCOUT=FAKE-canary\n');
      writeFileSync(join(planted, 'app.env'), 'AGENTGRAPH_APP_ID=FAKE-canary\n');
      const status = async (file: string) => (await fetch(`${base}/@fs${file}`)).status;
      expect(await status(join(root, 'node_modules/effect/package.json'))).toBe(200);
      expect(await status(join(root, 'src/workflow.ts'))).not.toBe(403);
      expect(await status(join(studioDir, 'package.json'))).toBe(200);
      expect(await status(join(root, 'package.json'))).toBe(403);
      expect(await status(join(root, 'infra/local/README.md'))).toBe(403);
      expect(await status(join(planted, '.keys.env'))).toBe(403);
      expect(await status(join(planted, 'app.env'))).toBe(403);
    } finally {
      await server.close();
      rmSync(planted, { recursive: true, force: true });
    }
  }, 30_000);
});
