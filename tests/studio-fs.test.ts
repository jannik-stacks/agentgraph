import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { studioDir } from './studio.ts';

const root = join(studioDir, '..');

describe('studio dev server', () => {
  it('serves files from the studio, src and node_modules only, and no env or key file there', async () => {
    const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
    const planted = mkdtempSync(join(studioDir, 'src', '.probe-'));
    writeFileSync(join(planted, '.keys.env'), 'AGENTGRAPH_LLM_API_KEY_SCOUT=FAKE-canary\n');
    writeFileSync(join(planted, 'app.env'), 'AGENTGRAPH_APP_ID=FAKE-canary\n');
    const server = await createServer({
      configFile: join(studioDir, 'vite.config.ts'),
      root: studioDir,
      server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
      logLevel: 'silent',
    });
    try {
      await server.listen();
      const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
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
