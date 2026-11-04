import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import { readRealPath } from '../src/instance.ts';
import type * as MainModule from '../src/main.ts';
import type * as HarnessesModule from '../src/harnesses.ts';

const readServedGraph = async () => {
  const startup = process.env.AGI_STUDIO_DIR;
  if (!startup) return;
  const { ConfigProvider, Effect, Result } = await import('effect');
  const { readConfiguredGraph }: typeof HarnessesModule = await import(
    new URL('../src/harnesses.ts', import.meta.url).href
  );
  const { readInstanceEnv }: typeof MainModule = await import(new URL('../src/main.ts', import.meta.url).href);
  const { readInstance, ensureInstanceGraph } = await import(new URL('../src/instance.ts', import.meta.url).href);
  const reference = JSON.parse(process.env.AGI_STUDIO_INSTANCE ?? 'null');
  const instance = reference ? readInstance(reference.root, reference.name) : undefined;
  const scope = await readInstanceEnv(instance, JSON.parse(process.env.AGI_STUDIO_HARNESS_CHOICE ?? '{}'));

  const dir = instance
    ? await ensureInstanceGraph(instance, process.env.AGI_STUDIO_GRAPH ?? scope.env.AGENTGRAPH_DIR)
    : (process.env.AGI_STUDIO_GRAPH ?? scope.env.AGENTGRAPH_DIR ?? startup);
  const files = reference
    ? [join(reference.root, reference.name, 'instance.yaml'), ...(instance?.env ? [instance.env] : [])]
    : [];
  const loaded = await Effect.runPromise(
    Effect.result(
      readConfiguredGraph(dir, instance).pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
    )
  );
  return Result.isSuccess(loaded)
    ? { dir, files, name: basename(dir), graph: loaded.success, problems: [] }
    : { dir, files, name: basename(dir), graph: undefined, problems: loaded.failure.problems };
};

const dataInfra = /^(cache|homes|logs|\.attic|\.locks|\.envs|.+\.git)$/;
const benchInfra = /^(homes|work|tree|engine|logs|target|node_modules|\.attic|\.cache|\.locks|\.envs|.+\.git)$/;
const neverServed = /\.lockb?$|^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|[jt]sconfig.*\.json)$/;

export const layouts = {
  data: (names: string[]) => !dataInfra.test(names[0]!) && names.length <= 2,
  bench: (names: string[]) => !names.some(name => benchInfra.test(name)),
  tune: (names: string[]) => names.length <= 3,
  any: () => true,
};

export type WatchRoot = { root: string; topic: string; layout: (names: string[]) => boolean };

export const makeUnservedFilter = (roots: WatchRoot[]) => {
  const all = roots.flatMap(({ root, layout }) =>
    [...new Set([resolve(root), readRealPath(root)])].map(root => ({ root, layout }))
  );
  return (path: string) => {
    const under = all.filter(({ root }) => path.startsWith(root + sep));
    if (!under.length) return false;
    if (neverServed.test(basename(path)) || existsSync(join(path, '.git'))) return true;
    return !under.some(({ root, layout }) => layout(path.slice(root.length + 1).split(sep)));
  };
};

export const servedIds = ['virtual:fixtures', 'virtual:served'];

export const makeServedGraph = () => {
  let served: ReturnType<typeof readServedGraph> | undefined;
  return {
    read: () =>
      (served ??= readServedGraph().catch((e: unknown) => {
        served = undefined;
        throw e;
      })),
    forget: () => {
      served = undefined;
    },
  };
};

export const startWatch = (server: ViteDevServer, roots: WatchRoot[], send: (topics: string[]) => void) => {
  const real = roots.map(({ root, topic }) => ({ root: readRealPath(root), topic }));
  const topics = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = (_event: string, path: string) => {
    const hit = real.filter(({ root }) => path === root || path.startsWith(root + sep));
    if (!hit.length) return;
    for (const { topic } of hit) topics.add(topic);
    clearTimeout(timer);
    timer = setTimeout(() => {
      send([...topics]);
      topics.clear();
    }, 150);
  };
  server.watcher.add([...new Set(real.map(({ root }) => root))]);
  server.watcher.on('all', changed);
  const stop = async () => {
    clearTimeout(timer);
    server.watcher.off('all', changed);
    server.httpServer?.off('close', close);
    await server.watcher.unwatch(real.map(({ root }) => root));
  };
  const close = () => void stop();
  server.httpServer?.once('close', close);
  return stop;
};
