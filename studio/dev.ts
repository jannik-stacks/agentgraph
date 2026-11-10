import { existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import { ensureInstance, findInstances, findRepo, readPickedInstance } from '../src/instance.ts';
import { readHostSettings } from '../src/services.ts';
import { makeServedGraphs, type StudioInstances } from './served.ts';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    data: { type: 'string' },
    instance: { type: 'string', multiple: true },
    tracker: { type: 'string' },
    repo: { type: 'string' },
    auth: { type: 'string' },
    plugins: { type: 'string' },
  },
});
const quit = (e: Error) => {
  console.error(e.message);
  return process.exit(2);
};
const { data: root } = await readHostSettings(values).catch(quit);
const named = values.instance ?? [];
if (values.repo !== undefined && named.length > 1) quit(new Error('--repo makes or reads one instance; drop it'));
for (const name of named) await readPickedInstance(root, name, values.repo !== undefined).catch(quit);
const repo = values.repo === undefined ? undefined : await findRepo(resolve(values.repo));
if (values.repo !== undefined && !repo) quit(new Error(`${values.repo} is not in a git repo`));
const names = repo
  ? [basename((await ensureInstance(root, named[0], repo).catch(quit)).dir)]
  : named.length || values.dir
    ? named
    : findInstances(root).map(i => basename(i.dir));
if (names.length > 1 && values.dir)
  quit(new Error('--dir picks the graph of one instance; set graph in each instance.yaml'));
const reserved = names.find(name => name === 'plugins' || name === 'runs');
if (reserved)
  quit(
    new Error(
      `an instance named ${reserved} would hide the studio pages at /${reserved}; rename ${join(root, reserved)}`
    )
  );
if (names.length && values.tracker)
  quit(new Error('--tracker is for a studio of one --dir; set tracker in instance.yaml'));

if (names.length) {
  const instances: StudioInstances = { root, names, ...(values.dir && { graph: resolve(values.dir) }) };
  process.env.AGI_STUDIO_INSTANCES = JSON.stringify(instances);
} else {
  const sandbox = join(import.meta.dirname, '..', 'examples', 'sandbox');
  process.env.AGI_STUDIO_DIR = resolve(values.dir ?? process.env.AGENTGRAPH_DIR ?? sandbox);
  process.env.AGI_STUDIO_DATA = root;
  if (values.tracker) process.env.AGI_STUDIO_TRACKER = resolve(values.tracker);
}
if (values.auth) process.env.AGI_STUDIO_AUTH = values.auth;
const plugins = values.plugins ?? process.env.AGENTGRAPH_STUDIO_PLUGINS;
if (plugins) process.env.AGI_STUDIO_PLUGINS = resolve(plugins);

for (const one of await makeServedGraphs().read()) {
  if ((named.length || repo) && one.problems.some(p => p.path === 'instance.yaml'))
    quit(new Error(one.problems[0]!.message));
  const tag = one.name ? `${one.name}  ` : '';
  const real = one.data && existsSync(one.data) ? realpathSync(one.data) : one.data;
  console.log(
    `${tag}graph  ${one.dir ?? 'none'}\n${tag}data   ${one.data ?? 'none'}${real !== one.data ? ` -> ${real}` : ''}`
  );
  if (one.problems.length)
    console.error(
      `${tag}the graph does not load, so the studio shows no workflow:\n${one.problems.map(p => `${p.path}: ${p.message}`).join('\n')}`
    );
}

const vite = await createServer({ root: import.meta.dirname }).catch((e: Error) => {
  console.error(`agi: the studio does not start: ${e.message}`);
  return process.exit(2);
});
await vite.listen().catch((e: Error) => {
  console.error(`agi: ${e.message}; pick another port with AGI_PORT`);
  process.exit(1);
});
vite.printUrls();
const base = vite.resolvedUrls?.local[0];
for (const name of names) console.log(`  ${name}  ${base}${encodeURIComponent(name)}/runs`);
