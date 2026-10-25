import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Either } from 'effect';
import { createServer } from 'vite';
import { readConfiguredHub } from '../src/harnesses.ts';
import { ensureHub, ensureInstance, findRepo } from '../src/instance.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: 'string' },
    data: { type: 'string' },
    forge: { type: 'string' },
    repo: { type: 'string' },
    bench: { type: 'string', multiple: true },
    tune: { type: 'string' },
  },
});
const root = process.env.AGENTGRAPH_DATA ?? join(homedir(), '.agentgraph');
const repo = values.repo === undefined ? undefined : await findRepo(resolve(values.repo));
if (values.repo && !repo) {
  console.error(`${values.repo} is not in a git repo`);
  process.exit(2);
}
const instance = repo === undefined ? undefined : await ensureInstance(values.data ?? root, repo);
const hubDir = resolve(
  values.hub ?? (instance ? await ensureHub(instance) : join(import.meta.dirname, '..', 'examples', 'sandbox'))
);
const dataDir = resolve(instance?.data ?? values.data ?? root);
const real = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
console.log(`hub    ${hubDir}\ndata   ${dataDir}${real !== dataDir ? ` -> ${real}` : ''}`);
const loaded = await Effect.runPromise(Effect.either(readConfiguredHub(hubDir)));
if (Either.isLeft(loaded))
  console.error(`the hub does not load, so the studio shows no workflow:\n${loaded.left.message}`);

process.env.VITE_AGI_HUB = hubDir;
process.env.VITE_AGI_DATA = dataDir;
const forge = instance?.forge ?? values.forge;
if (forge) process.env.VITE_AGI_FORGE = resolve(forge);
if (values.bench) process.env.VITE_AGI_BENCH = [...values.bench, ...positionals].map(d => resolve(d)).join(':');
if (values.tune) process.env.VITE_AGI_TUNE = resolve(values.tune);
const vite = await createServer({ root: import.meta.dirname });
await vite.listen().catch((e: Error) => {
  console.error(`agi: ${e.message}; pick another port with AGI_PORT`);
  process.exit(1);
});
vite.printUrls();
