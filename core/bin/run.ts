/**
 * Looks at one issue once: reenters its parked run, or begins one, and drives it until it parks or ends.
 * Usage: node core/bin/run.ts --hub <dir> --issue <n> --data <dir>
 *        node core/bin/run.ts --hub <dir> --all --data <dir>   (one pass over every open issue)
 *        node core/bin/run.ts check --hub <dir>   (loads the hub and prints every problem with its file)
 *        node core/bin/run.ts status --hub <dir> --data <dir>   (needs BOTHUB_APP_ENV; read-only)
 *        node core/bin/run.ts loop --hub <dir> --data <dir>   (looks at every open issue each BOTHUB_EVERY minutes)
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Redacted } from 'effect';
import { appEnv, start } from '../src/main.ts';
import { loadHub } from '../src/hub.ts';
import { needsYou } from '../src/status.ts';
import { fileStore } from '../src/store.ts';

const { values, positionals } = parseArgs({
  options: { hub: { type: 'string' }, issue: { type: 'string' }, all: { type: 'boolean' }, data: { type: 'string' } },
  allowPositionals: true,
});
const issue = values.all ? 'all' : Number(values.issue);

if (positionals[0] === 'check') {
  if (!values.hub) {
    console.error('usage: node core/bin/run.ts check --hub <dir>');
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
    console.error('usage: node core/bin/run.ts status --hub <dir> --data <dir>');
    process.exit(2);
  }
  const hub = resolve(values.hub);
  const data = resolve(values.data);
  const env = await appEnv(process.env.BOTHUB_APP_ENV);
  const id = env.BOTHUB_APP_ID ?? process.env.BOTHUB_APP_ID;
  const key = env.BOTHUB_APP_KEY ?? process.env.BOTHUB_APP_KEY;
  if (!id || !key) {
    console.error('set BOTHUB_APP_ENV to the App env file');
    process.exit(2);
  }
  const lines = await Effect.runPromise(
    loadHub(hub).pipe(
      Effect.flatMap(h => needsYou({ repo: h.repo, id, key: Redacted.make(key) }, { hub, data })),
      Effect.provide(fileStore(data))
    )
  );
  console.log(lines.length ? `Needs you\n${lines.join('\n')}` : 'Nothing needs you');
  process.exit(0);
}

if (positionals[0] === 'loop') {
  if (!values.hub || !values.data) {
    console.error('usage: node core/bin/run.ts loop --hub <dir> --data <dir>');
    process.exit(2);
  }
  const hub = await Effect.runPromise(loadHub(resolve(values.hub)));
  Object.assign(process.env, {
    BOTHUB_HUB: resolve(values.hub),
    BOTHUB_DATA: resolve(values.data),
    BOTHUB_REPO: hub.repo,
  });
  await start();
}

if (!values.hub || !values.data || (issue !== 'all' && (!Number.isInteger(issue) || issue < 1))) {
  console.error('usage: node core/bin/run.ts --hub <dir> (--issue <n> | --all) --data <dir>');
  process.exit(2);
}

const runs = await start({ hub: resolve(values.hub), issue, data: resolve(values.data) });
for (const run of runs) console.log(`${run.id} ${run.step} ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
if (runs.length === 0) console.log(issue === 'all' ? 'nothing to do' : `nothing to do on #${issue}`);
