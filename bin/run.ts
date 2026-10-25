#!/usr/bin/env node
/**
 * Looks at one issue once: reenters its parked run, or begins one, and drives it until it parks or ends.
 * Usage: node bin/run.ts --hub <dir> --issue <n> --data <dir>
 *        node bin/run.ts --hub <dir> --all --data <dir>   (one pass over every open issue)
 *        node bin/run.ts say --hub <dir> --data <dir> --issue <n> [--comment <review comment id>] "<text>"
 *        node bin/run.ts tell --data <dir> --issue <n> "<text>"
 *        node bin/run.ts dispatch --hub <dir> --data <dir> --workflow <name> --issue <n> [--step <step>]
 *        node bin/run.ts start --hub <dir> --data <dir> --forge <dir> [--workflow <name>] "<title>[\n<body>]"
 *          (files an issue on the forge folder with the workflow's label and runs it)
 *        node bin/run.ts check --hub <dir>   (loads the hub and prints every problem with its file)
 *        node bin/run.ts status --hub <dir> --data <dir>   (needs AGENTGRAPH_APP_ENV, or --forge; read-only)
 *        node bin/run.ts loop --hub <dir> --data <dir>   (looks at every open issue each AGENTGRAPH_EVERY minutes)
 *        node bin/run.ts loop --data <dir>   (the same with the repo's own .agentgraph/; AGENTGRAPH_REPO names the repo)
 *        node bin/run.ts prune-logs --data <dir> [--apply]   (counts the check logs no trace names; --apply deletes them)
 * With --forge <dir>, the runs act on a forge folder (see bin/forge.ts) instead of GitHub, and need no App.
 * --instance <dir> stands for the hub, forge and data of an instance, and loads its keys.env; without --hub, --forge
 * or --data, the instance is the one around the working directory, if any.
 * --logs all|failed|off says which check output the data dir keeps, as AGENTGRAPH_CHECK_LOGS.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Redacted } from 'effect';
import { tell, type Instruction } from '../src/engine.ts';
import { readAppEnvWithKey, start, writeTriggeringIssue } from '../src/main.ts';
import { readConfiguredHub } from '../src/harnesses.ts';
import { instanceAt } from '../src/instance.ts';
import { findRunsWaitingOnPeople, formatNextSteps } from '../src/status.ts';
import { readInstallationReach } from '../src/github.ts';
import { fileStore, pruneLogs, Store } from '../src/store.ts';

const { values, positionals } = parseArgs({
  options: {
    hub: { type: 'string' },
    comment: { type: 'string' },
    workflow: { type: 'string' },
    step: { type: 'string' },
    issue: { type: 'string' },
    all: { type: 'boolean' },
    data: { type: 'string' },
    forge: { type: 'string' },
    instance: { type: 'string' },
    logs: { type: 'string' },
    apply: { type: 'boolean' },
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
  if (instance.logs) process.env.AGENTGRAPH_CHECK_LOGS ??= instance.logs;
  if (existsSync(instance.keys))
    for (const [k, v] of Object.entries(await readAppEnvWithKey(instance.keys))) process.env[k] ??= v;
}
if (values.forge) process.env.AGENTGRAPH_FORGE = resolve(values.forge);
if (values.logs) process.env.AGENTGRAPH_CHECK_LOGS = values.logs;
let issue: number | 'all' = values.all ? 'all' : Number(values.issue);

const command = positionals[0];
let instruction: Instruction | undefined;
if (command === 'say' || command === 'tell' || command === 'dispatch') {
  const text = positionals.slice(1).join(' ');
  if (
    !values.data ||
    issue === 'all' ||
    !Number.isInteger(issue) ||
    issue < 1 ||
    (command !== 'tell' && !values.hub) ||
    (command === 'dispatch' ? !values.workflow || positionals.length !== 1 : !text.trim())
  ) {
    console.error(
      `usage: node bin/run.ts ${command} ${command === 'tell' ? '' : '--hub <dir> '}--data <dir> --issue <n> ${command === 'dispatch' ? '--workflow <name> [--step <step>]' : '[options] "<text>"'}`
    );
    process.exit(2);
  }
  if (command === 'tell') {
    const run = await Effect.runPromise(tell(issue, text).pipe(Effect.provide(fileStore(resolve(values.data)))));
    console.log(`told ${run.id}`);
    process.exit(0);
  }
  instruction =
    command === 'say'
      ? { kind: 'say', issue, text, ...(values.comment !== undefined && { comment: values.comment }) }
      : {
          kind: 'dispatch',
          issue,
          workflow: values.workflow!,
          ...(values.step !== undefined && { step: values.step }),
        };
}

if (command === 'start') {
  const text = positionals.slice(1).join(' ').trim();
  if (!values.hub || !values.data || !values.forge || !text) {
    console.error('usage: node bin/run.ts start --hub <dir> --data <dir> --forge <dir> [--workflow <name>] "<text>"');
    process.exit(2);
  }
  const hub = await Effect.runPromise(readConfiguredHub(resolve(values.hub)));
  const author = instance?.owner ?? execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
  issue = await writeTriggeringIssue(hub, resolve(values.forge), text, author, values.workflow).catch((e: Error) => {
    console.error(e.message);
    process.exit(2);
  });
  console.log(`#${issue}`);
}

if (positionals[0] === 'check') {
  if (!values.hub) {
    console.error('usage: node bin/run.ts check --hub <dir>');
    process.exit(2);
  }
  const problems = await Effect.runPromise(
    readConfiguredHub(resolve(values.hub)).pipe(
      Effect.map(() => []),
      Effect.catchTag('HubError', e => Effect.succeed(e.problems))
    )
  );
  for (const p of problems) console.error(`${p.path}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s)` : 'ok');
  process.exit(problems.length ? 1 : 0);
}

if (positionals[0] === 'prune-logs') {
  if (!values.data) {
    console.error('usage: node bin/run.ts prune-logs --data <dir> [--apply]');
    process.exit(2);
  }
  const { files, bytes } = await pruneLogs(resolve(values.data), values.apply);
  console.log(`${values.apply ? 'deleted' : 'would delete'} ${files} unreferenced log(s), ${bytes} bytes`);
  process.exit(0);
}

if (positionals[0] === 'status') {
  if (!values.hub || !values.data) {
    console.error('usage: node bin/run.ts status --hub <dir> --data <dir>');
    process.exit(2);
  }
  const hub = resolve(values.hub);
  const data = resolve(values.data);
  const env = await readAppEnvWithKey(process.env.AGENTGRAPH_APP_ENV);
  const id = env.AGENTGRAPH_APP_ID ?? process.env.AGENTGRAPH_APP_ID;
  const key = env.AGENTGRAPH_APP_KEY ?? process.env.AGENTGRAPH_APP_KEY;
  if (!values.forge && (!id || !key)) {
    console.error('set AGENTGRAPH_APP_ENV to the App env file');
    process.exit(2);
  }
  const forge = values.forge ? resolve(values.forge) : undefined;
  const again = instance
    ? `--instance ${instance.dir}`
    : `--hub ${hub} --data ${data}${forge ? ` --forge ${forge}` : ''}`;
  const { repo } = await Effect.runPromise(readConfiguredHub(hub));
  const runs = await Effect.runPromise(Effect.flatMap(Store, s => s.list()).pipe(Effect.provide(fileStore(data))));
  const lines = [
    ...(forge ? [] : await Effect.runPromise(readInstallationReach({ repo, id: id!, key: Redacted.make(key!) }))),
    ...findRunsWaitingOnPeople(runs).flatMap(run => formatNextSteps(run, { again, repo, ...(forge && { forge }) })),
  ];
  console.log(lines.length ? `Needs you\n${lines.join('\n')}` : 'Nothing needs you');
  process.exit(0);
}

if (positionals[0] === 'loop') {
  if (!values.data) {
    console.error('usage: node bin/run.ts loop [--hub <dir>] --data <dir>');
    process.exit(2);
  }
  process.env.AGENTGRAPH_DATA = resolve(values.data);
  if (values.hub) {
    const hub = await Effect.runPromise(readConfiguredHub(resolve(values.hub)));
    Object.assign(process.env, { AGENTGRAPH_HUB: resolve(values.hub), AGENTGRAPH_REPO: hub.repo });
  }
  await start();
}

if (!values.hub || !values.data || (issue !== 'all' && (!Number.isInteger(issue) || issue < 1))) {
  console.error('usage: node bin/run.ts --hub <dir> (--issue <n> | --all) --data <dir>');
  process.exit(2);
}

const runs = await start({
  hub: resolve(values.hub),
  issue,
  data: resolve(values.data),
  ...(instruction && { instruction }),
  ...(command === 'start' && { marked: true as const }),
});
for (const run of runs) console.log(`${run.id} ${run.step} ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
if (runs.length === 0) console.log(issue === 'all' ? 'nothing to do' : `nothing to do on #${issue}`);
