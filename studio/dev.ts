import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { api, serve } from '../src/api.ts';
import { openStore } from '../src/store.ts';
import { apiPort } from './vite.config.ts';

const { values } = parseArgs({
  options: { hub: { type: 'string' }, infra: { type: 'string' }, data: { type: 'string' } },
});
const hubDir = resolve(values.hub ?? join(import.meta.dirname, '..', 'examples', 'acme-app'));
const infraDir = resolve(values.infra ?? join(import.meta.dirname, '..', 'infra'));
const dataDir = resolve(values.data ?? process.env.BOTHUB_DATA ?? join(homedir(), '.bothub'));
const store = openStore(dataDir);

await serve(api({ hubDir, store, roots: [{ name: 'infra', dir: infraDir }] }), apiPort);
console.log(`api    http://127.0.0.1:${apiPort}\nhub    ${hubDir}\ninfra  ${infraDir}\ndata   ${dataDir}`);
for (const dir of [hubDir, infraDir]) if (!existsSync(dir)) console.log(`${dir} does not exist yet; it lists nothing`);
if (!(await store.list()).length) console.log(`no runs yet; add one with: npm run seed -- ${dataDir}`);

process.env.VITE_BHM_HUB = hubDir;
process.env.VITE_BHM_DATA = dataDir;
const vite = await createServer({ root: import.meta.dirname });
await vite.listen();
vite.printUrls();
