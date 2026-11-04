import { readInstanceEnv } from '../src/main.ts';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigProvider, Effect, Result } from 'effect';
import { createServer } from 'vite';
import { readConfiguredGraph } from '../src/harnesses.ts';
import { ensureInstanceGraph, ensureInstance, readPickedInstance, findRepo } from '../src/instance.ts';
import { readHostSettings, makeTrackerSetup, settings } from '../src/services.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    data: { type: 'string' },
    instance: { type: 'string' },
    tracker: { type: 'string' },
    repo: { type: 'string' },
    bench: { type: 'string', multiple: true },
    tune: { type: 'string' },
  },
});
const quit = (e: Error) => {
  console.error(e.message);
  return process.exit(2);
};
const { data: root, config } = await readHostSettings(values).catch(quit);
const saved = await readPickedInstance(root, values.instance, values.repo !== undefined).catch(quit);
const repo = values.repo === undefined ? saved?.checkout : await findRepo(resolve(values.repo));
if (values.repo && !repo) quit(new Error(`${values.repo} is not in a git repo`));
const instance = repo === undefined ? undefined : await ensureInstance(root, values.instance, repo).catch(quit);
const choice = JSON.parse(process.env.AGI_STUDIO_HARNESS_CHOICE ?? '{}');
const scope = await readInstanceEnv(
  instance,
  choice,
  config ? { AGENTGRAPH_CONFIG: config } : {},
  values.tracker === undefined ? {} : { AGENTGRAPH_TRACKER: values.tracker }
);
const whyTracker =
  instance &&
  `the tracker folder ${instance.tracker} has no origin.git; restore it, or move ${instance.dir} aside to start anew`;
if (instance && scope.env.AGENTGRAPH_TRACKER === 'folder' && !existsSync(join(instance.tracker, 'origin.git')))
  quit(new Error(whyTracker!));
const graphDir = instance
  ? await ensureInstanceGraph(instance, values.dir ?? scope.env.AGENTGRAPH_DIR).catch(quit)
  : resolve(values.dir ?? scope.env.AGENTGRAPH_DIR ?? join(import.meta.dirname, '..', 'examples', 'sandbox'));
scope.env.AGENTGRAPH_DIR = graphDir;
const setup =
  instance &&
  (await makeTrackerSetup(
    await Effect.runPromise(settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config)))
  ).catch(quit));
if (instance && setup?.origin.local && !existsSync(setup.origin.origin)) quit(new Error(whyTracker!));
if (instance) process.env.AGI_STUDIO_INSTANCE = JSON.stringify({ root, name: basename(instance.dir) });
const dataDir = resolve(instance?.data ?? root);
const real = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
console.log(`graph  ${graphDir}\ndata   ${dataDir}${real !== dataDir ? ` -> ${real}` : ''}`);
const loaded = await Effect.runPromise(
  Effect.result(
    readConfiguredGraph(graphDir, instance).pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
  )
);
if (Result.isFailure(loaded))
  console.error(`the graph does not load, so the studio shows no workflow:\n${loaded.failure.message}`);

process.env.AGI_STUDIO_DIR = graphDir;
if (values.dir !== undefined) process.env.AGI_STUDIO_GRAPH = resolve(values.dir);
process.env.AGI_STUDIO_DATA = dataDir;
process.env.AGI_STUDIO_HARNESS_CHOICE = JSON.stringify(choice);
const tracker = setup?.origin.local ? dirname(setup.origin.origin) : instance ? undefined : values.tracker;
if (tracker) process.env.AGI_STUDIO_TRACKER = resolve(tracker);
if (values.bench) process.env.AGI_STUDIO_BENCH = [...values.bench, ...positionals].map(d => resolve(d)).join(':');
if (values.tune) process.env.AGI_STUDIO_TUNE = resolve(values.tune);
const vite = await createServer({ root: import.meta.dirname }).catch((e: Error) => {
  console.error(`agi: the studio does not start: ${e.message}`);
  return process.exit(2);
});
await vite.listen().catch((e: Error) => {
  console.error(`agi: ${e.message}; pick another port with AGI_PORT`);
  process.exit(1);
});
vite.printUrls();
