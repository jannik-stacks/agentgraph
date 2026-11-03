import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigProvider, Effect, Result } from 'effect';
import { createServer } from 'vite';
import { makeHarnessConfigProvider, readConfiguredGraph } from '../src/harnesses.ts';
import { ensureBase, ensureGraph, ensureInstance, findRepo } from '../src/instance.ts';
import { readHostSettings } from '../src/services.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    data: { type: 'string' },
    tracker: { type: 'string' },
    repo: { type: 'string' },
    bench: { type: 'string', multiple: true },
    tune: { type: 'string' },
  },
});
const { data: root, config } = await readHostSettings(values).catch((e: Error) => {
  console.error(e.message);
  return process.exit(2);
});
const repo = values.repo === undefined ? undefined : await findRepo(resolve(values.repo));
if (values.repo && !repo) {
  console.error(`${values.repo} is not in a git repo`);
  process.exit(2);
}
const instance = repo === undefined ? undefined : await ensureInstance(root, repo);
const moved = instance && (await ensureBase(instance));
if (moved) console.error(`${moved}\nThe studio shows the graph of agentgraph's base.`);
const graphDir = resolve(
  values.dir ?? (instance ? await ensureGraph(instance) : join(import.meta.dirname, '..', 'examples', 'sandbox'))
);
const dataDir = resolve(instance?.data ?? root);
const real = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
console.log(`graph  ${graphDir}\ndata   ${dataDir}${real !== dataDir ? ` -> ${real}` : ''}`);
const choice = { config, provider: instance?.provider };
const loaded = await Effect.runPromise(
  Effect.result(
    readConfiguredGraph(graphDir).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, makeHarnessConfigProvider(choice))
    )
  )
);
if (Result.isFailure(loaded))
  console.error(`the graph does not load, so the studio shows no workflow:\n${loaded.failure.message}`);

process.env.AGI_STUDIO_DIR = graphDir;
process.env.AGI_STUDIO_DATA = dataDir;
process.env.AGI_STUDIO_HARNESS_CHOICE = JSON.stringify(choice);
const tracker = instance?.tracker ?? values.tracker;
if (tracker) process.env.AGI_STUDIO_TRACKER = resolve(tracker);
if (values.bench) process.env.AGI_STUDIO_BENCH = [...values.bench, ...positionals].map(d => resolve(d)).join(':');
if (values.tune) process.env.AGI_STUDIO_TUNE = resolve(values.tune);
const vite = await createServer({ root: import.meta.dirname });
await vite.listen().catch((e: Error) => {
  console.error(`agi: ${e.message}; pick another port with AGI_PORT`);
  process.exit(1);
});
vite.printUrls();
