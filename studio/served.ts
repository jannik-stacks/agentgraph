import { existsSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import { type Instance, readRealPath } from '../src/instance.ts';
import type * as InstanceModule from '../src/instance.ts';
import type * as MainModule from '../src/main.ts';
import type * as HarnessesModule from '../src/harnesses.ts';
import type * as ServicesModule from '../src/services.ts';
import type { Graph } from '../src/folder.ts';
import type { Problem } from '../src/workflow.ts';

export type ServedGraph = {
  name: string;
  title: string;
  dir?: string;
  data?: string;
  files: string[];
  local: boolean;
  graph?: Graph;
  problems: Problem[];
};

export type StudioInstances = { root: string; names: string[]; graph?: string };

const loadGraph = async (
  dir: string,
  instance: Instance | undefined,
  scope: Pick<Awaited<ReturnType<typeof MainModule.readInstanceEnv>>, 'config'>
) => {
  const { ConfigProvider, Effect, Result } = await import('effect');
  const { readConfiguredGraph }: typeof HarnessesModule = await import(
    new URL('../src/harnesses.ts', import.meta.url).href
  );
  const loaded = await Effect.runPromise(
    Effect.result(
      readConfiguredGraph(dir, instance).pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
    )
  );
  return Result.isSuccess(loaded) ? { graph: loaded.success, problems: [] } : { problems: loaded.failure.problems };
};

const readChoice = () => JSON.parse(process.env.AGI_STUDIO_HARNESS_CHOICE ?? '{}');

const readInstanceServed = async ({ root, graph: explicit }: StudioInstances, name: string): Promise<ServedGraph> => {
  const { readInstance, ensureInstanceGraph }: typeof InstanceModule = await import(
    new URL('../src/instance.ts', import.meta.url).href
  );
  const { readInstanceEnv }: typeof MainModule = await import(new URL('../src/main.ts', import.meta.url).href);
  const { makeTrackerSetup, settings }: typeof ServicesModule = await import(
    new URL('../src/services.ts', import.meta.url).href
  );
  const { ConfigProvider, Effect } = await import('effect');
  const files = [join(root, name, 'instance.yaml')];
  let data: string | undefined;
  try {
    const instance = readInstance(root, name);
    if (!instance) throw new Error(`there is no instance ${name} under ${root}`);
    data = instance.data;
    if (instance.env) files.push(instance.env);
    const scope = await readInstanceEnv(instance, readChoice());
    const whyTracker = `the tracker folder ${instance.tracker} has no origin.git; restore it, or move ${instance.dir} aside to start anew`;
    if (scope.env.AGENTGRAPH_TRACKER === 'folder' && !existsSync(join(instance.tracker, 'origin.git')))
      throw new Error(whyTracker);
    const dir = await ensureInstanceGraph(instance, explicit ?? scope.env.AGENTGRAPH_DIR);
    scope.env.AGENTGRAPH_DIR = dir;
    const setup = await makeTrackerSetup(
      await Effect.runPromise(settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config)))
    );
    if (setup.origin.local && !existsSync(setup.origin.origin)) throw new Error(whyTracker);
    const local = !!setup.origin.local;
    return { name, title: name, dir, data: instance.data, files, local, ...(await loadGraph(dir, instance, scope)) };
  } catch (e) {
    const problems = [{ path: 'instance.yaml', message: (e as Error).message }];
    return { name, title: name, ...(data && { data }), files, local: false, problems };
  }
};

const readPlainServed = async (): Promise<ServedGraph> => {
  const { AGI_STUDIO_DIR: dir, AGI_STUDIO_DATA: data, AGI_STUDIO_TRACKER: tracker } = process.env;
  const plain = { name: '', title: basename(dir ?? data ?? ''), ...(data && { data }), files: [], local: !!tracker };
  if (!dir) return { ...plain, problems: [] };
  const { readInstanceEnv }: typeof MainModule = await import(new URL('../src/main.ts', import.meta.url).href);
  const config = data && join(data, 'config.ts');
  const scope = await readInstanceEnv(
    undefined,
    readChoice(),
    config && existsSync(config) ? { AGENTGRAPH_CONFIG: config } : {}
  );
  return { ...plain, dir, ...(await loadGraph(dir, undefined, scope)) };
};

const readServedGraphs = async (): Promise<ServedGraph[]> => {
  const listed = process.env.AGI_STUDIO_INSTANCES;
  if (listed) {
    const instances: StudioInstances = JSON.parse(listed);
    return Promise.all(instances.names.map(name => readInstanceServed(instances, name)));
  }
  return process.env.AGI_STUDIO_DIR || process.env.AGI_STUDIO_DATA ? [await readPlainServed()] : [];
};

export const makeServedTopic = (name: string, topic: string) => (name ? `${name}:${topic}` : topic);

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

export const makeServedGraphs = () => {
  let served: Promise<ServedGraph[]> | undefined;
  return {
    read: () =>
      (served ??= readServedGraphs().catch((e: unknown) => {
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
