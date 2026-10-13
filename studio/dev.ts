import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { api, serve } from '../src/api.ts';
import { loadPrices } from '../src/prices.ts';
import { openStore } from '../src/store.ts';
import { apiPort } from './vite.config.ts';

const { values } = parseArgs({
  options: { hub: { type: 'string' }, infra: { type: 'string' }, data: { type: 'string' } },
});
const hubDir = resolve(values.hub ?? join(import.meta.dirname, '..', 'examples', 'acme-app'));
const infraDir = resolve(values.infra ?? join(import.meta.dirname, '..', 'infra'));
const dataDir = resolve(values.data ?? process.env.BOTHUB_DATA ?? join(homedir(), '.bothub'));
const store = openStore(dataDir);

const fail = (message: string) => {
  console.error(`bhm: ${message}`);
  process.exit(1);
};

const prices = loadPrices({ file: join(infraDir, 'local', 'prices.json') });
await serve(api({ hubDir, store, roots: [{ name: 'infra', dir: infraDir }], prices }), apiPort).catch((e: Error) =>
  fail(`${e.message}; stop it, or pick other ports with BHM_API_PORT and BHM_PORT`)
);
const real = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
console.log(
  [
    `api    http://127.0.0.1:${apiPort}`,
    `hub    ${hubDir}`,
    `infra  ${infraDir}`,
    `data   ${dataDir}${real !== dataDir ? ` -> ${real}` : ''}`,
  ].join('\n')
);
for (const dir of [hubDir, infraDir]) if (!existsSync(dir)) console.log(`${dir} does not exist yet; it lists nothing`);
if (!(await store.list()).length) console.log(`no runs yet; add one with: npm run seed -- ${dataDir}`);

process.env.VITE_BHM_HUB = hubDir;
process.env.VITE_BHM_DATA = dataDir;
const vite = await createServer({ root: import.meta.dirname });
await vite.listen().catch((e: Error) => fail(`${e.message}; pick another port with BHM_PORT`));
vite.printUrls();
