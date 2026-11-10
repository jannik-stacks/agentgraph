import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { Effect, Schema } from 'effect';
import { JsonValue } from '../src/meta.ts';
import type { InstanceHosts } from '../src/types.ts';
import type * as FolderModule from '../src/folder.ts';
import type * as ReadModule from '../src/read.ts';
import type * as PluginModule from '../src/plugin.ts';
import type * as ResultsModule from '../bin/results.ts';
import { ResultsData } from './src/results/data.ts';
import {
  layouts,
  makeServedGraphs,
  makeServedTopic,
  makeUnservedFilter,
  readModule,
  readQuery,
  servedIds,
  startWatch,
  type ServedGraph,
  type WatchRoot,
} from './served.ts';

const manifest = 'virtual:agentgraph-pages';

const entry = 'virtual:agentgraph-page/';

const makeResultsPlugin = async (served: ServedGraph) => {
  const { makePlugin } = await readModule<typeof PluginModule>('src/plugin.ts');
  const { data } = served;
  return makePlugin({
    name: 'results',
    studio: {
      title: 'Results',
      page: new URL('./src/results/ResultsPage.tsx', import.meta.url),
      dataSchema: ResultsData,
      watch: () => (data ? [data] : []),
      read: () =>
        Effect.gen(function* () {
          const { readRunResults } = yield* Effect.promise(() => readModule<typeof ResultsModule>('bin/results.ts'));
          try {
            return Schema.decodeUnknownSync(ResultsData)({ kind: 'ready', sheet: readRunResults(data, served.graph) });
          } catch {
            return { kind: 'failed' as const, why: 'Could not read the results' };
          }
        }),
    },
  });
};

const readHosts = (served: ServedGraph[]): InstanceHosts =>
  Object.fromEntries(
    served.flatMap(({ name, host, problems }) =>
      host || problems.length ? [[name, host ?? { why: problems.map(p => p.message).join('; ') }]] : []
    )
  );

const readFolderPages = async (dir: string | undefined, instances: InstanceHosts) => {
  if (!dir) return [];
  const { readPlugins } = await readModule<typeof PluginModule>('src/plugin.ts');
  const { parseGraphSettings } = await readModule<typeof FolderModule>('src/folder.ts');
  const { readOrUndefined } = await readModule<typeof ReadModule>('src/read.ts');
  const text = await readFile(join(dir, 'settings.yaml'), 'utf8').catch(readOrUndefined);
  const settings = parseGraphSettings(text, message => {
    throw new Error(`${dir}/settings.yaml: ${message}`);
  });
  const { pages, names } = await readPlugins(dir, settings?.plugins, { instances });
  const idle = names.filter(name => !pages.some(page => page.name === name));
  if (idle.length) throw new Error(`${dir}: ${idle.join(', ')} serve no studio page, the only member read here`);
  return pages;
};

const readStudioPages = async (served: ReturnType<typeof makeServedGraphs>) => {
  const { readPlugins } = await readModule<typeof PluginModule>('src/plugin.ts');
  const all = await served.read();
  const scoped = await Promise.all(
    all.map(async one => {
      const { pages } = await readPlugins(one.graph?.dir, one.graph?.plugins, {
        builtins: [await makeResultsPlugin(one)],
        instances: readHosts([one]),
      });
      return pages.map(page => ({ ...page, instance: one.name }));
    })
  );
  const studio = await readFolderPages(process.env.AGI_STUDIO_PLUGINS, readHosts(all));
  const pages = [...scoped.flat(), ...studio.map(page => ({ ...page, instance: undefined }))].map(page => ({
    ...page,
    key: page.instance ? `${page.instance}/${page.name}` : page.name,
    href: page.builtin ? `/${page.name}` : `/plugins/${page.name}`,
  }));
  const twice = pages.find((page, i) => pages.findIndex(other => other.key === page.key) !== i);
  if (twice) throw new Error(`studio page ${twice.name} is defined twice`);
  return pages;
};

const readWatchRoots = (pages: Awaited<ReturnType<typeof readStudioPages>>, served: ServedGraph[]): WatchRoot[] => {
  return [
    ...served.flatMap(one => [
      ...(one.dir ? [{ root: one.dir, topic: makeServedTopic(one.name, 'graph'), layout: layouts.any }] : []),
      ...one.files.map(root => ({ root, topic: makeServedTopic(one.name, 'graph'), layout: () => false })),
      ...(one.data ? [{ root: one.data, topic: makeServedTopic(one.name, 'data'), layout: layouts.data }] : []),
    ]),
    ...(process.env.AGI_STUDIO_PLUGINS
      ? [{ root: process.env.AGI_STUDIO_PLUGINS, topic: 'graph', layout: layouts.any }]
      : []),
    ...pages.flatMap(page =>
      page.watch.map(root => ({
        root,
        topic: makeServedTopic(page.instance ?? '', page.name),
        layout: layouts.data,
      }))
    ),
  ];
};

export const makeStudioPagesPlugin = (
  served = makeServedGraphs()
): Plugin & { readStores: () => Promise<readonly string[]> } => {
  let pages = readStudioPages(served);
  let roots: WatchRoot[] = [];
  let unserved = makeUnservedFilter(roots);
  let dispose: (() => Promise<void>) | undefined;
  return {
    readStores: async () => (await pages).flatMap(page => (page.instance === undefined ? page.watch : [])),
    name: 'agentgraph:pages',
    enforce: 'pre',
    async config() {
      const loaded = await pages;
      roots = readWatchRoots(loaded, await served.read());
      unserved = makeUnservedFilter(roots);
      return {
        resolve: {
          alias: { '@jannik-stacks/agi/studio': fileURLToPath(new URL('./src/plugins.ts', import.meta.url)) },
          dedupe: ['react', 'react-dom', 'jotai', 'effect', 'd3-scale'],
        },
        server: {
          fs: { allow: loaded.map(page => dirname(fileURLToPath(page.page))) },
          watch: { ignored: [(path: string) => unserved(path)] },
        },
      };
    },
    resolveId(source) {
      if (source === manifest || source.startsWith(entry)) return `\0${source}`;
      return undefined;
    },
    async load(id) {
      if (id !== `\0${manifest}` && !id.startsWith(`\0${entry}`)) return;
      const loaded = await pages;
      if (id === `\0${manifest}`)
        return `export const pages = [${loaded
          .map(
            page =>
              `{name:${JSON.stringify(page.name)},title:${JSON.stringify(page.title)},href:${JSON.stringify(page.href)},builtin:${page.builtin},instance:${JSON.stringify(page.instance)},load:()=>import(${JSON.stringify(entry + page.key)})}`
          )
          .join(',')}];`;
      const page = id.startsWith(`\0${entry}`) && loaded.find(page => page.key === id.slice(entry.length + 1));
      if (page) return `export { default } from ${JSON.stringify(fileURLToPath(page.page))};`;
      return undefined;
    },
    async transform(code, id) {
      if (id !== fileURLToPath(new URL('./src/styles.css', import.meta.url))) return;
      return (
        code + (await pages).map(page => `\n@source ${JSON.stringify(dirname(fileURLToPath(page.page)))};`).join('')
      );
    },
    async closeBundle() {
      await dispose?.();
    },
    async configureServer(server) {
      let loaded = await pages;
      const initial = new Set(loaded.map(page => dirname(fileURLToPath(page.page))));
      const allowed = server.config.server.fs.allow.filter(root => !initial.has(root));
      const watch = async () => {
        await dispose?.();
        dispose = startWatch(server, roots, topics => {
          if (!topics.some(topic => topic.split(':').at(-1) === 'graph'))
            return server.ws.send('agi:changed', { topics });
          served.forget();
          pages = readStudioPages(served);
          void pages
            .then(async current => {
              loaded = current;
              roots = readWatchRoots(loaded, await served.read());
              unserved = makeUnservedFilter(roots);
              server.config.server.fs.allow = [
                ...new Set([...allowed, ...loaded.map(page => dirname(fileURLToPath(page.page)))]),
              ];
              await watch();
              for (const id of [...servedIds, manifest]) {
                const module = server.moduleGraph.getModuleById(`\0${id}`);
                if (module) server.moduleGraph.invalidateModule(module);
              }
              for (const [id, module] of server.moduleGraph.idToModuleMap)
                if (id.startsWith(`\0${entry}`)) server.moduleGraph.invalidateModule(module);
              server.ws.send({ type: 'full-reload' });
            })
            .catch((e: Error) => server.config.logger.error(e.message));
        });
      };
      await watch();
      server.middlewares.use('/api/plugins', (req, res) => {
        res.setHeader('content-type', 'application/json');
        const name = /^\/([^/?]+)\/data(?:\?.*)?$/.exec(req.url ?? '')?.[1];
        const instance = readQuery(req).get('instance') ?? '';
        const page = loaded.find(page => page.key === (instance ? `${instance}/${name}` : name));
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
        return undefined;
      });
    },
  };
};
