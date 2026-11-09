import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The studio sources, which the root typecheck leaves to the studio's own tsconfig. */
export const studioDir = join(import.meta.dirname, '..', 'studio');

const importFile = <T>(file: string, query = ''): Promise<T> =>
  import(/* @vite-ignore */ pathToFileURL(file).href + query) as Promise<T>;

/** Imports a module under `studio/src` without pulling it into the root typecheck. */
export const studioModule = <T>(path: string) => importFile<T>(join(studioDir, 'src', path));

export const studioDependency = <T>(name: string) =>
  importFile<T>(createRequire(join(studioDir, 'package.json')).resolve(name));

let configs = 0;

// UNEXPECTED: servers sharing the config's cache folder rewrite each other's prebundled deps and send reloads.
export const createStudioServer = async (include: string[] = []) => {
  const { createServer, mergeConfig } = await import(
    pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href
  );
  const { default: config } = await importFile<{ default: object }>(
    join(studioDir, 'vite.config.ts'),
    `?server=${++configs}`
  );
  return createServer(
    mergeConfig(config, {
      configFile: false,
      root: studioDir,
      cacheDir: mkdtempSync(join(tmpdir(), 'agentgraph-vite-')),
      optimizeDeps: { noDiscovery: true, include },
      server: { port: 0, strictPort: false, warmup: { clientFiles: [] } },
      logLevel: 'silent',
    })
  );
};

export const startStudioServer = async () => {
  const server = await createStudioServer();
  await server.listen();
  const base: string = server.resolvedUrls.local[0].replace(/\/$/, '');
  return { server, base };
};
