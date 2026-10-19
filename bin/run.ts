/**
 * Looks at one issue once: reenters its parked run, or begins one, and drives it until it parks or ends.
 * Usage: node bin/run.ts --hub <dir> --issue <n> --data <dir>
 *        node bin/run.ts --hub <dir> --all --data <dir>   (one pass over every open issue)
 *        node bin/run.ts check --hub <dir>   (loads the hub and prints every problem with its file)
 *        node bin/run.ts status --hub <dir> --data <dir>   (needs BOTHUB_APP_ENV, or --forge; read-only)
 *        node bin/run.ts loop --hub <dir> --data <dir>   (looks at every open issue each BOTHUB_EVERY minutes)
 *        node bin/run.ts loop --data <dir>   (the same with the repo's own .bothub/; BOTHUB_REPO names the repo)
 * With --forge <dir>, the runs act on a forge folder (see bin/forge.ts) instead of GitHub, and need no App.
 * --instance <dir> stands for the hub, forge and data of an instance, and loads its keys.env; without --hub, --forge
 * or --data, the instance is the one around the working directory, if any.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Redacted } from 'effect';
import { appEnv, start } from '../src/main.ts';
import { loadHub } from '../src/hub.ts';
import { instanceAt } from '../src/instance.ts';
import { needsYou } from '../src/status.ts';
import { fileStore } from '../src/store.ts';

const { values, positionals } = parseArgs({
  options: {
    hub: { type: 'string' },
    issue: { type: 'string' },
    all: { type: 'boolean' },
    data: { type: 'string' },
    forge: { type: 'string' },
    instance: { type: 'string' },
  },
  allowPositionals: true,
});
const around = values.instance ?? (values.hub || values.forge || values.data ? undefined : '.');
const instance = around === undefined ? undefined : instanceAt(around);
if (values.instance && !instance) {
  console.error(`no instance.yaml at or above ${values.instance}`);
  process.exit(2);
}
if (instance) {
  Object.assign(values, { hub: instance.hub, forge: instance.forge, data: instance.data });
  if (existsSync(instance.keys)) for (const [k, v] of Object.entries(await appEnv(instance.keys))) process.env[k] ??= v;
}
if (values.forge) process.env.BOTHUB_FORGE = resolve(values.forge);
const issue = values.all ? 'all' : Number(values.issue);

if (positionals[0] === 'check') {
  if (!values.hub) {
    console.error('usage: node bin/run.ts check --hub <dir>');
    process.exit(2);
  }
  const problems = await Effect.runPromise(
    loadHub(resolve(values.hub)).pipe(
      Effect.map(() => []),
      Effect.catchTag('HubError', e => Effect.succeed(e.problems))
    )
  );
  for (const p of problems) console.error(`${p.path}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s)` : 'ok');
  process.exit(problems.length ? 1 : 0);
}

if (positionals[0] === 'status') {
  if (!values.hub || !values.data) {
    console.error('usage: node bin/run.ts status --hub <dir> --data <dir>');
    process.exit(2);
  }
  const hub = resolve(values.hub);
  const data = resolve(values.data);
  const env = await appEnv(process.env.BOTHUB_APP_ENV);
  const id = env.BOTHUB_APP_ID ?? process.env.BOTHUB_APP_ID;
  const key = env.BOTHUB_APP_KEY ?? process.env.BOTHUB_APP_KEY;
  if (!values.forge && (!id || !key)) {
    console.error('set BOTHUB_APP_ENV to the App env file');
    process.exit(2);
  }
  const forge = values.forge ? resolve(values.forge) : undefined;
  const again = instance
    ? `--instance ${instance.dir}`
    : `--hub ${hub} --data ${data}${forge ? ` --forge ${forge}` : ''}`;
  const lines = await Effect.runPromise(
    loadHub(hub).pipe(
      Effect.flatMap(h =>
        needsYou(forge ? undefined : { repo: h.repo, id: id!, key: Redacted.make(key!) }, {
          again,
          ...(forge && { forge }),
        })
      ),
      Effect.provide(fileStore(data))
    )
  );
  console.log(lines.length ? `Needs you\n${lines.join('\n')}` : 'Nothing needs you');
  process.exit(0);
}

if (positionals[0] === 'loop') {
  if (!values.data) {
    console.error('usage: node bin/run.ts loop [--hub <dir>] --data <dir>');
    process.exit(2);
  }
  process.env.BOTHUB_DATA = resolve(values.data);
  if (values.hub) {
    const hub = await Effect.runPromise(loadHub(resolve(values.hub)));
    Object.assign(process.env, { BOTHUB_HUB: resolve(values.hub), BOTHUB_REPO: hub.repo });
  }
  await start();
}

if (!values.hub || !values.data || (issue !== 'all' && (!Number.isInteger(issue) || issue < 1))) {
  console.error('usage: node bin/run.ts --hub <dir> (--issue <n> | --all) --data <dir>');
  process.exit(2);
}

const runs = await start({ hub: resolve(values.hub), issue, data: resolve(values.data) });
for (const run of runs) console.log(`${run.id} ${run.step} ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
if (runs.length === 0) console.log(issue === 'all' ? 'nothing to do' : `nothing to do on #${issue}`);
