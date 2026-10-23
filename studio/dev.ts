import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Either } from 'effect';
import { createServer } from 'vite';
import { loadHub } from '../src/hub.ts';
import { instanceAt } from '../src/instance.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: 'string' },
    data: { type: 'string' },
    instance: { type: 'string' },
    bench: { type: 'string', multiple: true },
    tune: { type: 'string' },
  },
});
const instance = values.instance === undefined ? undefined : instanceAt(values.instance);
if (values.instance && !instance) {
  console.error(`no instance.yaml at or above ${values.instance}`);
  process.exit(2);
}
const hubDir = resolve(values.hub ?? instance?.hub ?? join(import.meta.dirname, '..', 'examples', 'sandbox'));
const dataDir = resolve(values.data ?? instance?.data ?? process.env.AGENTGRAPH_DATA ?? join(homedir(), '.agentgraph'));
const real = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
console.log(`hub    ${hubDir}\ndata   ${dataDir}${real !== dataDir ? ` -> ${real}` : ''}`);
const loaded = await Effect.runPromise(Effect.either(loadHub(hubDir)));
if (Either.isLeft(loaded))
  console.error(`the hub does not load, so the studio shows no workflow:\n${loaded.left.message}`);

process.env.VITE_AGI_HUB = hubDir;
process.env.VITE_AGI_DATA = dataDir;
if (values.bench) process.env.VITE_AGI_BENCH = [...values.bench, ...positionals].map(d => resolve(d)).join(':');
if (values.tune) process.env.VITE_AGI_TUNE = resolve(values.tune);
const vite = await createServer({ root: import.meta.dirname });
await vite.listen().catch((e: Error) => {
  console.error(`agi: ${e.message}; pick another port with AGI_PORT`);
  process.exit(1);
});
vite.printUrls();
