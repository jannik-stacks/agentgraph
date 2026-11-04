import { basename, sep } from 'node:path';
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
