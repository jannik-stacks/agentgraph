import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import { readRealPath } from '../src/instance.ts';
import type * as HarnessesModule from '../src/harnesses.ts';

const readServedGraph = async () => {
  const dir = process.env.AGI_STUDIO_DIR;
  if (!dir) return;
  const { ConfigProvider, Effect, Result } = await import('effect');
  const { makeHarnessConfigProvider, readConfiguredGraph }: typeof HarnessesModule = await import(
    new URL('../src/harnesses.ts', import.meta.url).href
  );
  const choice = JSON.parse(process.env.AGI_STUDIO_HARNESS_CHOICE ?? '{}');
  const loaded = await Effect.runPromise(
    Effect.result(
      readConfiguredGraph(dir).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, makeHarnessConfigProvider(choice))
      )
    )
  );
  return Result.isSuccess(loaded)
    ? { name: basename(dir), graph: loaded.success, problems: [] }
    : { name: basename(dir), graph: undefined, problems: loaded.failure.problems };
};

const unserved =
  /^(homes|cache|work|tree|engine|logs|target|node_modules|\.attic|\.cache|\.locks|\.envs|.+\.git)$|\.lock$|^[jt]sconfig.*\.json$/;

const isServed = (path: string, { root, depth }: { root: string; depth: number }) => {
  const names = path.slice(root.length + 1).split(sep);
  return names.length <= depth && !names.some(name => unserved.test(name));
};

export const readDataRoots = () => [
  ...(process.env.AGI_STUDIO_DATA ? [{ root: process.env.AGI_STUDIO_DATA, depth: 4 }] : []),
  ...(process.env.AGI_STUDIO_BENCH ?? '')
    .split(':')
    .filter(Boolean)
    .map(root => ({ root, depth: Infinity })),
  ...(process.env.AGI_STUDIO_TUNE ? [{ root: process.env.AGI_STUDIO_TUNE, depth: 4 }] : []),
];

export const makeUnservedFilter = (roots: { root: string; depth: number }[]) => {
  const all = roots.flatMap(({ root, depth }) =>
    [...new Set([resolve(root), readRealPath(root)])].map(root => ({ root, depth }))
  );
  return (path: string) => {
    const under = all.filter(({ root }) => path.startsWith(root + sep));
    return !!under.length && (!under.some(root => isServed(path, root)) || existsSync(join(path, '.git')));
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

export const startWatch = (
  server: ViteDevServer,
  roots: { root: string; topic: string }[],
  send: (topics: string[]) => void
) => {
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
  const stop = () => {
    clearTimeout(timer);
    server.watcher.off('all', changed);
  };
  server.httpServer?.once('close', stop);
  return stop;
};
