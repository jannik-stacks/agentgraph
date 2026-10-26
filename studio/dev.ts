import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Either } from 'effect';
import { createServer } from 'vite';
import { makeHarnessConfigProvider, readConfiguredGraph } from '../src/harnesses.ts';
import { ensureBase, ensureGraph, ensureInstance, findRepo } from '../src/instance.ts';
import { readHostSettings } from '../src/services.ts';
import { formatInstanceFlags } from '../src/status.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    data: { type: 'string' },
    forge: { type: 'string' },
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
  Effect.either(readConfiguredGraph(graphDir).pipe(Effect.withConfigProvider(makeHarnessConfigProvider(choice))))
);
if (Either.isLeft(loaded))
  console.error(`the graph does not load, so the studio shows no workflow:\n${loaded.left.message}`);

process.env.VITE_AGI_DIR = graphDir;
process.env.VITE_AGI_DATA = dataDir;
process.env.VITE_AGI_HARNESS_CHOICE = JSON.stringify(choice);
const forge = instance?.forge ?? values.forge;
if (forge) process.env.VITE_AGI_FORGE = resolve(forge);
if (instance) process.env.VITE_AGI_FLAGS = formatInstanceFlags(instance.repo, root);
if (values.bench) process.env.VITE_AGI_BENCH = [...values.bench, ...positionals].map(d => resolve(d)).join(':');
if (values.tune) process.env.VITE_AGI_TUNE = resolve(values.tune);
const vite = await createServer({ root: import.meta.dirname });
await vite.listen().catch((e: Error) => {
  console.error(`agi: ${e.message}; pick another port with AGI_PORT`);
  process.exit(1);
});
vite.printUrls();
