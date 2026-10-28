import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { Effect, Either, Schema } from 'effect';
import { JsonValue } from '../src/meta.ts';
import type * as PluginModule from '../src/plugin.ts';
import type * as HarnessModule from '../src/harnesses.ts';

const manifest = 'virtual:agentgraph-pages';
const entry = 'virtual:agentgraph-page/';

const readStudioPages = async () => {
  const dir = process.env.AGI_STUDIO_DIR;
  if (!dir) return [];
  const { readConfiguredGraph, makeHarnessConfigProvider }: typeof HarnessModule = await import(
    new URL('../src/harnesses.ts', import.meta.url).href
  );
  const graph = await Effect.runPromise(
    Effect.either(
      readConfiguredGraph(dir).pipe(
        Effect.withConfigProvider(makeHarnessConfigProvider(JSON.parse(process.env.AGI_STUDIO_HARNESS_CHOICE ?? '{}')))
      )
    )
  );
  if (Either.isLeft(graph)) return [];
  const { readPlugins }: typeof PluginModule = await import(new URL('../src/plugin.ts', import.meta.url).href);
  return (await readPlugins(graph.right.dir, graph.right.plugins)).pages;
};

export const makeStudioPagesPlugin = (): Plugin => {
  const pages = readStudioPages();
  const clients = new Set<ServerResponse>();
  let dispose: (() => void) | undefined;
  return {
    name: 'agentgraph:pages',
    enforce: 'pre',
    async config() {
      const loaded = await pages;
      return {
        resolve: {
          alias: { '@jannik-stacks/agi/studio': fileURLToPath(new URL('./src/plugins.ts', import.meta.url)) },
          dedupe: ['react', 'react-dom', 'jotai', 'effect'],
        },
        server: { fs: { allow: loaded.map(page => dirname(fileURLToPath(page.page))) } },
      };
    },
    resolveId(source) {
      if (source === manifest || source.startsWith(entry)) return `\0${source}`;
    },
    async load(id) {
      const loaded = await pages;
      if (id === `\0${manifest}`)
        return `export const pages = [${loaded
          .map(
            page =>
              `{name:${JSON.stringify(page.name)},title:${JSON.stringify(page.title)},href:${JSON.stringify(`/plugins/${page.name}`)},load:()=>import(${JSON.stringify(entry + page.name)})}`
          )
          .join(',')}];`;
      const page = id.startsWith(`\0${entry}`) && loaded.find(page => page.name === id.slice(entry.length + 1));
      if (page) return `export { default } from ${JSON.stringify(fileURLToPath(page.page))};`;
    },
    async transform(code, id) {
      if (id !== fileURLToPath(new URL('./src/styles.css', import.meta.url))) return;
      return (
        code + (await pages).map(page => `\n@source ${JSON.stringify(dirname(fileURLToPath(page.page)))};`).join('')
      );
    },
    closeBundle() {
      dispose?.();
    },
    async configureServer(server) {
      const loaded = await pages;
      const roots = [
        ...new Set(
          [
            ...(process.env.AGI_STUDIO_DATA ? [process.env.AGI_STUDIO_DATA] : []),
            ...loaded.flatMap(page => page.watch),
          ].map(root => {
            try {
              return realpathSync(root);
            } catch {
              return resolve(root);
            }
          })
        ),
      ];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = (_event: string, path: string) => {
        if (!roots.some(root => path === root || path.startsWith(root + sep))) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const client of clients) client.write('data: changed\n\n');
        }, 150);
      };
      server.watcher.add(roots);
      server.watcher.on('all', changed);
      dispose = () => {
        clearTimeout(timer);
        server.watcher.off('all', changed);
        for (const client of clients) client.end();
        clients.clear();
      };
      server.httpServer?.once('close', dispose);
      server.middlewares.use('/api/events', (req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(': open\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
      });
      server.middlewares.use('/api/plugins', (req, res) => {
        res.setHeader('content-type', 'application/json');
        const name = /^\/([a-zA-Z][a-zA-Z0-9_]*)\/data(?:\?.*)?$/.exec(req.url ?? '')?.[1];
        const page = loaded.find(page => page.name === name);
        if (!page) {
          res.statusCode = 404;
          return res.end('{"error":"Unknown plugin page"}');
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end('{"error":"GET required"}');
        }
        void Effect.runPromise(
          Effect.gen(function* () {
            const value = yield* page.read();
            return yield* Schema.encodeUnknown(page.dataSchema, { onExcessProperty: 'error' })(value);
          })
        )
          .then(value => {
            if (!Schema.is(JsonValue)(value)) throw new Error('Plugin data must be JSON');
            const text = JSON.stringify(value);
            if (Buffer.byteLength(text) > 16_777_216) throw new Error('Plugin data exceeds 16 MiB');
            res.end(text);
          })
          .catch(() => {
            res.statusCode = 500;
            res.end('{"error":"Could not read plugin data"}');
          });
      });
    },
  };
};
