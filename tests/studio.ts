import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The studio sources, which the root typecheck leaves to the studio's own tsconfig. */
export const studioDir = join(import.meta.dirname, '..', 'studio');

/** Imports a module under `studio/src` without pulling it into the root typecheck. */
export const studioModule = <T>(path: string): Promise<T> =>
  import(/* @vite-ignore */ pathToFileURL(join(studioDir, 'src', path)).href) as Promise<T>;

// UNEXPECTED: servers sharing the config's cache folder rewrite each other's prebundled deps and send reloads.
export const createStudioServer = async () => {
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  return createServer({
    configFile: join(studioDir, 'vite.config.ts'),
    root: studioDir,
    cacheDir: mkdtempSync(join(tmpdir(), 'agentgraph-vite-')),
    optimizeDeps: { noDiscovery: true },
    server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
    logLevel: 'silent',
  });
};

export const startStudioServer = async () => {
  const server = await createStudioServer();
  await server.listen();
  const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
  return { server, base };
};
