import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { Effect, Schema } from 'effect';
import { JsonValue } from '../src/meta.ts';
import type * as PluginModule from '../src/plugin.ts';
import type * as ResultsModule from '../bin/results.ts';
import { ResultsData } from './src/results/data.ts';
import { resultSources } from './src/results/result.ts';
import { BenchData } from './src/bench/data.ts';
import { readBench } from './src/bench/read.ts';
import { makeServedGraph, startWatch } from './served.ts';

const manifest = 'virtual:agentgraph-pages';

const entry = 'virtual:agentgraph-page/';

const readStudioPages = async (served: ReturnType<typeof makeServedGraph>) => {
  const graph = (await served.read())?.graph;
  const { readPlugins, makePlugin }: typeof PluginModule = await import(
    new URL('../src/plugin.ts', import.meta.url).href
  );
  const data = process.env.AGI_STUDIO_DATA;
  const bench = (process.env.AGI_STUDIO_BENCH ?? '').split(':').filter(Boolean);
  const tune = process.env.AGI_STUDIO_TUNE;
  const results = makePlugin({
    name: 'results',
    studio: {
      title: 'Results',
      page: new URL('./src/results/ResultsPage.tsx', import.meta.url),
      dataSchema: ResultsData,
      watch: () => [...(data ? [data] : []), ...bench, ...(tune ? [tune] : [])],
      read: () =>
        Effect.gen(function* () {
          const { readRunResults }: typeof ResultsModule = yield* Effect.promise(
            () => import(new URL('../bin/results.ts', import.meta.url).href)
          );
          const current = (yield* Effect.promise(served.read))?.graph;
          return Object.fromEntries(
            resultSources.map(from => {
              try {
                const sheet =
                  from === 'tune' && !tune
                    ? { fields: [], runs: [] }
                    : readRunResults(
                        from,
                        {
                          ...(data && { data }),
                          bench,
                          ...(tune && { tune }),
                        },
                        current
                      );
                const candidates = Object.fromEntries(
                  sheet.runs.flatMap(row => ('step' in row ? [[row.key, row.step]] : []))
                );
                return [from, Schema.decodeUnknownSync(ResultsData.value)({ kind: 'ready', sheet, candidates })];
              } catch {
                return [from, { kind: 'failed', why: 'Could not read this result source' }];
              }
            })
          ) as typeof ResultsData.Type;
        }),
    },
  });
  const builtins = [
    results,
    makePlugin({
      name: 'bench',
      studio: {
        title: 'Bench',
        page: new URL('./src/bench/BenchPage.tsx', import.meta.url),
        dataSchema: BenchData,
        watch: () => bench,
        read: () => Effect.promise(() => readBench(bench)),
      },
    }),
  ];
  const { pages } = await readPlugins(graph?.dir, graph?.plugins, undefined, builtins);
  return pages
    .filter(page => page.name !== 'bench' || bench.length)
    .map(page => ({
      ...page,
      href: builtins.some(b => b.name === page.name) ? `/${page.name}` : `/plugins/${page.name}`,
    }));
};

export const makeStudioPagesPlugin = (served = makeServedGraph()): Plugin => {
  const pages = readStudioPages(served);
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
      if (id !== `\0${manifest}` && !id.startsWith(`\0${entry}`)) return;
      const loaded = await pages;
      if (id === `\0${manifest}`)
        return `export const pages = [${loaded
          .map(
            page =>
              `{name:${JSON.stringify(page.name)},title:${JSON.stringify(page.title)},href:${JSON.stringify(page.href)},load:()=>import(${JSON.stringify(entry + page.name)})}`
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
      dispose = startWatch(
        server,
        [
          ...(process.env.AGI_STUDIO_DATA ? [{ root: process.env.AGI_STUDIO_DATA, topic: 'data' }] : []),
          ...loaded.flatMap(page => page.watch.map(root => ({ root, topic: page.name }))),
        ],
        topics => server.ws.send('agi:changed', { topics })
      );
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
            return yield* Schema.encodeUnknownEffect(page.dataSchema, { onExcessProperty: 'error' })(value);
          })
        )
          .then(value => {
            if (!Schema.is(JsonValue)(value)) throw new Error('Plugin data must be JSON');
            const text = JSON.stringify(value);
            if (Buffer.byteLength(text) > 16_777_216) throw new Error('Plugin data exceeds 16 MiB');
            res.end(text);
          })
          .catch((e: Error) => {
            server.config.logger.error(`studio  plugin ${page.name} could not read its data: ${e.message}`);
            res.statusCode = 500;
            res.end('{"error":"Could not read plugin data"}');
          });
      });
    },
  };
};
