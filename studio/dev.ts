import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Either } from 'effect';
import { createServer } from 'vite';
import { loadHub } from '../src/hub.ts';

const { values } = parseArgs({ options: { hub: { type: 'string' }, data: { type: 'string' } } });
const hubDir = resolve(values.hub ?? join(import.meta.dirname, '..', 'examples', 'acme-app'));
const dataDir = resolve(values.data ?? process.env.BOTHUB_DATA ?? join(homedir(), '.bothub'));
const real = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
console.log(`hub    ${hubDir}\ndata   ${dataDir}${real !== dataDir ? ` -> ${real}` : ''}`);
const loaded = await Effect.runPromise(Effect.either(loadHub(hubDir)));
if (Either.isLeft(loaded))
  console.error(`the hub does not load, so the studio shows no workflow:\n${loaded.left.message}`);

process.env.VITE_BHM_HUB = hubDir;
process.env.VITE_BHM_DATA = dataDir;
const vite = await createServer({ root: import.meta.dirname });
await vite.listen().catch((e: Error) => {
  console.error(`bhm: ${e.message}; pick another port with BHM_PORT`);
  process.exit(1);
});
vite.printUrls();
