#!/usr/bin/env node
import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect, Redacted } from 'effect';
import { ensureDocker } from '../src/docker.ts';
import type { Instruction } from '../src/engine.ts';
import { fileForge, Forge } from '../src/forge.ts';
import { readInstallationReach } from '../src/github.ts';
import { readConfiguredHub } from '../src/harnesses.ts';
import {
  defaultHub,
  ensureHub,
  ensureInstance,
  writePullToRepo,
  findInstances,
  findRepo,
  mergePull,
  ensureBase,
  writeClosed,
  writeComment,
  writeReview,
  type Instance,
} from '../src/instance.ts';
import { createLoopLock, isLoopHeld, readEngineEnv, start, writeTriggeringIssue } from '../src/main.ts';
import { findRunsWaitingOnPeople, formatIssueList, formatIssueTimeline, formatNextSteps } from '../src/status.ts';
import { fileStore, pruneLogs, Store } from '../src/store.ts';
import type { Run } from '../src/workflow.ts';

const usage = `usage: npx agentgraph <verb> [flags]
  start "<title>[\\n<body>]" [--workflow <name>]   files an issue and drives it until it waits or ends
  loop [--once]                                   drives every open issue, again every AGENTGRAPH_EVERY minutes
  show [<n>]                                      what needs you and every issue, or one issue in full
  say <n> "<text>" [--line <path>:<line>]         an /agent comment on issue n, then drives it
  review <n> approve|changes ["<text>"]           a review of issue n's pull request; changes drives it
  merge <n>                                       merges issue n's pull request and closes the issue
  export <n> [--as <branch>] [--patch <file>]     writes issue n's branch into your repo again
  close <n>                                       closes issue n
  check [<check>... --runs [--issue <n>]]        validates the hub, or runs checks again on ended runs
  dispatch <n> --workflow <name> [--step <step>]  starts a workflow that takes dispatch on issue n
  prune-logs [--apply]                            counts the check logs no trace names, or deletes them
flags: --data <dir> --repo <dir> --base <branch> --hub <dir> --forge github|<dir> --logs all|failed|off`;

const { values, positionals } = parseArgs({
  options: {
    data: { type: 'string' },
    repo: { type: 'string' },
    base: { type: 'string' },
    hub: { type: 'string' },
    forge: { type: 'string' },
    logs: { type: 'string' },
    workflow: { type: 'string' },
    step: { type: 'string' },
    issue: { type: 'string' },
    line: { type: 'string' },
    as: { type: 'string' },
    patch: { type: 'string' },
    once: { type: 'boolean' },
    apply: { type: 'boolean' },
    runs: { type: 'boolean' },
  },
  allowPositionals: true,
});
const [verb = '', ...rest] = positionals;
const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
if (values.logs) process.env.AGENTGRAPH_CHECK_LOGS = values.logs;
const n = Number(rest[0]);
const numbered = () => (Number.isInteger(n) && n > 0 ? n : fail(`${verb} takes an issue number\n${usage}`));
const said = () => rest.slice(1).join(' ').trim();
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;
const listRuns = (data: string, filter: Parameters<Store['Type']['list']>[0] = {}) =>
  Effect.runPromise(Effect.flatMap(Store, s => s.list(filter)).pipe(Effect.provide(fileStore(data))));
const printRuns = (runs: Run[]) => {
  for (const run of runs) console.log(`${run.id} ${run.step} ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
};
const checkHub = async (hub: string) => {
  const problems = await Effect.runPromise(
    readConfiguredHub(hub).pipe(
      Effect.map(() => []),
      Effect.catchTag('HubError', e => Effect.succeed(e.problems))
    )
  );
  for (const p of problems) console.error(`${p.path}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s)` : 'ok');
  process.exit(problems.length ? 1 : 0);
};

let sandboxed: Promise<void> | undefined;
const ensureSandbox = (after: string) =>
  (sandboxed ??= process.env.AGENTGRAPH_SANDBOX_URL
    ? Promise.resolve()
    : Effect.runPromise(ensureDocker(line => console.log(`sandbox  ${line}`))).then(
        version => console.log(`sandbox  docker ${version}`),
        (e: Error) => fail(`${e.message}\n${after}`, 1)
      ));

const stopping = new AbortController();
const trapInterrupt = () =>
  process.on('SIGINT', () => {
    if (stopping.signal.aborted) process.exit(130);
    console.error('stopping; runs resume where they were on the next drive (Ctrl-C again quits now)');
    stopping.abort();
  });

if (verb === 'check' && values.hub && !values.runs) await checkHub(resolve(values.hub));

const app = ['AGENTGRAPH_APP_ENV', 'AGENTGRAPH_APP_ID', 'AGENTGRAPH_APP_KEY', 'AGENTGRAPH_APP_KEY_FILE'];
if (values.forge !== undefined || app.some(name => process.env[name])) await runOnForge();
else await runOnInstance();

async function runOnForge() {
  const data = resolve(values.data ?? process.env.AGENTGRAPH_DATA ?? join(homedir(), '.agentgraph'));
  const folder = values.forge && values.forge !== 'github' ? resolve(values.forge) : undefined;
  if (folder) process.env.AGENTGRAPH_FORGE = folder;
  const hub = values.hub && resolve(values.hub);
  const needHub = () => hub ?? fail(`${verb} on a forge needs --hub`);
  switch (verb) {
    case 'loop': {
      if (values.once) return printRuns(await start({ hub: needHub(), issue: 'all', data }));
      process.env.AGENTGRAPH_DATA = data;
      if (hub)
        Object.assign(process.env, {
          AGENTGRAPH_HUB: hub,
          AGENTGRAPH_REPO: (await Effect.runPromise(readConfiguredHub(hub))).repo,
        });
      await start();
      return;
    }
    case 'show': {
      const env = await readEngineEnv();
      const { AGENTGRAPH_APP_ID: id, AGENTGRAPH_APP_KEY: key } = env;
      if (!folder && (!id || !key)) fail('set AGENTGRAPH_APP_ENV to the App env file');
      const { repo } = await Effect.runPromise(readConfiguredHub(needHub()));
      const lines = [
        ...(folder ? [] : await Effect.runPromise(readInstallationReach({ repo, id: id!, key: Redacted.make(key!) }))),
        ...findRunsWaitingOnPeople(await listRuns(data)).flatMap(run =>
          formatNextSteps(run, folder ? undefined : repo)
        ),
      ];
      console.log(lines.length ? `Needs you\n${lines.join('\n')}` : 'Nothing needs you');
      return;
    }
    case 'check':
    case 'dispatch':
      return printRuns(await start({ hub: needHub(), issue: 'all', data, instruction: instructed() }));
    case 'prune-logs':
      return prune(data);
    default:
      fail(`${verb || 'a verb'} does not run on --forge or with App credentials\n${usage}`);
  }
}

function instructed(): Instruction {
  if (verb === 'dispatch') {
    if (!values.workflow) fail('dispatch takes --workflow <name>');
    return {
      kind: 'dispatch',
      issue: numbered(),
      workflow: values.workflow!,
      ...(values.step && { step: values.step }),
    };
  }
  if (!values.runs || rest.length === 0)
    fail('usage: npx agentgraph check <check>... --runs [--workflow <name>] [--issue <n>]');
  return {
    kind: 'check',
    checks: rest,
    ...(values.workflow !== undefined && { workflow: values.workflow }),
    ...(values.issue !== undefined && { issue: Number(values.issue) }),
  };
}

async function prune(data: string) {
  const { files, bytes } = await pruneLogs(data, values.apply);
  console.log(`${values.apply ? 'deleted' : 'would delete'} ${files} unreferenced log(s), ${bytes} bytes`);
}

async function runOnInstance() {
  const root = resolve(values.data ?? process.env.AGENTGRAPH_DATA ?? join(homedir(), '.agentgraph'));
  const repo = await findRepo(resolve(values.repo ?? '.'));
  if (!repo) {
    if (verb !== 'show') fail(`${verb || 'agentgraph'} runs inside a git repo, or pass --repo <dir>\n${usage}`);
    return showInstances(root);
  }
  const i = await ensureInstance(root, repo, values.base).catch((e: Error) => fail(e.message));
  if (i.made) console.log(`data     ${i.dir} (new)`);
  Object.assign(process.env, { AGENTGRAPH_FORGE: i.forge, AGENTGRAPH_TRUST: i.owner });
  const forgeOf = () => Effect.runPromise(Effect.provide(Forge, fileForge(i.forge)));
  const synced = async () => {
    const why = await ensureBase(i);
    if (why) fail(why, 1);
    return ensureHub(i, values.hub);
  };
  switch (verb) {
    case 'start': {
      const text = rest.join(' ').trim();
      if (!text) fail(`start takes the issue text\n${usage}`);
      const hub = await synced();
      const loaded = await Effect.runPromise(readConfiguredHub(hub)).catch((e: Error) => fail(e.message, 1));
      header(i, hub);
      await ensureSandbox('Nothing was filed.');
      const issue = await writeTriggeringIssue(
        { ...loaded, trust: [i.owner] },
        i.forge,
        text,
        i.owner,
        values.workflow
      ).catch((e: Error) => fail(e.message));
      console.log(`#${issue} ${text.split('\n')[0]}`);
      return drive(i, issue, hub);
    }
    case 'say': {
      if (!said()) fail(`say takes text\n${usage}`);
      await writeComment(i.forge, i.owner, numbered(), `/agent ${said()}`, values.line).catch((e: Error) =>
        fail(e.message)
      );
      return drive(i, n, await synced());
    }
    case 'review': {
      const verdict = ({ approve: 'approved', changes: 'changes_requested' } as const)[
        rest[1] as 'approve' | 'changes'
      ];
      if (!verdict) fail('review takes approve or changes');
      const text = rest.slice(2).join(' ').trim();
      await writeReview(i.forge, i.owner, numbered(), verdict, text).catch((e: Error) => fail(e.message));
      if (verdict === 'changes_requested') return drive(i, n, await synced());
      console.log(`approved #${n}`);
      return;
    }
    case 'merge': {
      const pull = await mergePull(i, numbered()).catch((e: Error) => fail(e.message, 1));
      console.log(`${pull.base} at ${pull.head.slice(0, 7)} in agentgraph`);
      return report(i, n, `git merge ${pull.branch}`);
    }
    case 'export': {
      numbered();
      const result = await writePullToRepo(i, n, {
        ...(values.as && { as: values.as }),
        ...(values.patch && { patch: values.patch }),
      });
      if (!result) fail(`#${n} has no pull request`, 1);
      if (result && 'why' in result) fail(`${result.why}; try --as <branch> or --patch <file>`, 1);
      return report(i, n);
    }
    case 'close':
      writeClosed(i.forge, i.owner, numbered());
      console.log(`closed #${n}`);
      return;
    case 'show':
      return rest[0] ? showIssue(await forgeOf(), numbered(), i) : showAll(i, await forgeOf());
    case 'check':
      if (!values.runs) return checkHub(await synced());
      return printRuns(await start({ hub: await synced(), issue: 'all', data: i.data, instruction: instructed() }));
    case 'dispatch':
      return printRuns(
        await start({ hub: await synced(), issue: 'all', data: i.data, base: i.base, instruction: instructed() })
      );
    case 'loop':
      return loop(i);
    case 'prune-logs':
      return prune(i.data);
    default:
      fail(usage);
  }
}

function header(i: Instance, hub: string) {
  console.log(`agentgraph ${version}: ${hub === defaultHub ? 'default hub' : `hub ${hub}`}, local forge`);
  console.log(`repo     ${i.repo}, base ${i.base}`);
}

const watchRuns = (i: Instance, issue: number) => {
  const shown = new Map<string, string>();
  const look = async () => {
    for (const run of await listRuns(i.data, { issue }).catch(() => [])) {
      const now = `${run.step}: ${run.status === 'running' ? 'working' : run.status}`;
      if (shown.get(run.id) !== now) console.log(`#${issue} ${now}`);
      shown.set(run.id, now);
    }
  };
  const timer = setInterval(() => void look(), 1000);
  return async () => {
    clearInterval(timer);
    await look();
  };
};

async function drive(i: Instance, issue: number, hub: string) {
  if (!sandboxed) header(i, hub);
  trapInterrupt();
  if (await isLoopHeld(i.data)) {
    console.log(`a loop drives this repo; following #${issue}`);
    const before = JSON.stringify((await listRuns(i.data, { issue })).at(-1));
    const stop = watchRuns(i, issue);
    for (;;) {
      await new Promise(done => setTimeout(done, 2000));
      const last = (await listRuns(i.data, { issue })).toSorted((a, b) => a.started.localeCompare(b.started)).at(-1);
      if (stopping.signal.aborted || (last && last.status !== 'running' && JSON.stringify(last) !== before)) break;
    }
    await stop();
    return stopping.signal.aborted ? process.exit(130) : report(i, issue);
  }
  await ensureSandbox(`#${issue} is posted; npx agentgraph loop --once drives it once docker runs.`);
  const stop = watchRuns(i, issue);
  const runs = await start(
    { hub, issue, data: i.data, marked: true, base: i.base },
    undefined,
    {},
    stopping.signal
  ).catch((e: unknown) => {
    if (!stopping.signal.aborted) throw e;
    return undefined;
  });
  await stop();
  if (!runs) {
    console.log(`stopped; npx agentgraph say ${issue} "go on" resumes it`);
    process.exit(130);
  }
  if (runs.length === 0) console.log(`nothing to do on #${issue}`);
  return report(i, issue);
}

async function report(i: Instance, issue: number, next?: string) {
  const result = await writePullToRepo(i, issue, values.as ? { as: values.as } : {});
  if (result && 'why' in result)
    console.log(`not written to your repo: ${result.why}\n  npx agentgraph export ${issue} --as <branch>`);
  else if (result) {
    const { ref, base, stat } = result;
    if (stat) console.log(`\n${stat}`);
    console.log(`In your repo: ${ref}    git diff ${base}...${ref}`);
    console.log(`Worktree:     git worktree add ../${basename(i.repo)}-${issue} ${ref}`);
  }
  const waiting = findRunsWaitingOnPeople(await listRuns(i.data, { issue })).flatMap(run => formatNextSteps(run));
  const steps = [...(next ? [`  ${next}`] : []), ...waiting.filter(l => l.startsWith('  '))];
  if (steps.length) console.log(`Next:\n${steps.join('\n')}`);
}

async function loop(i: Instance) {
  const release = await createLoopLock(i.data).catch(() => fail(`another loop drives ${i.repo}`, 1));
  await ensureSandbox('Nothing was driven.');
  trapInterrupt();
  const every = Number(process.env.AGENTGRAPH_EVERY ?? 5);
  try {
    while (!stopping.signal.aborted) {
      const why = await ensureBase(i);
      if (why) console.error(why);
      else {
        const hub = await ensureHub(i, values.hub);
        const runs = await start(
          { hub, issue: 'all', data: i.data, base: i.base },
          undefined,
          {},
          stopping.signal
        ).catch((e: unknown) => (stopping.signal.aborted ? [] : (console.error(e), [])));
        printRuns(runs);
        for (const issue of new Set(runs.map(r => r.issue))) {
          const result = await writePullToRepo(i, issue);
          if (result)
            console.log(
              'why' in result ? `#${issue} not written: ${result.why}` : `#${issue} in your repo as ${result.ref}`
            );
        }
      }
      if (values.once) break;
      await new Promise<void>(done => {
        const quiet = setTimeout(finish, every * 60_000);
        const watcher = watch(i.forge, finish);
        stopping.signal.addEventListener('abort', finish);
        function finish() {
          clearTimeout(quiet);
          watcher.close();
          done();
        }
      });
    }
  } finally {
    await release();
  }
}

async function showAll(i: Instance, forge: Forge['Type']) {
  const lines = findRunsWaitingOnPeople(await listRuns(i.data)).flatMap(run => formatNextSteps(run));
  console.log(lines.length ? `Needs you\n${lines.join('\n')}\n` : 'Nothing needs you\n');
  console.log(formatIssueList(await Effect.runPromise(forge.issues())));
}

async function showIssue(forge: Forge['Type'], issue: number, i: Instance) {
  const t = await Effect.runPromise(forge.issue(issue)).catch((e: Error) => fail(e.message, 1));
  const diff = join(i.forge, String(issue), 'diff.patch');
  console.log(formatIssueTimeline(t, existsSync(diff) ? readFileSync(diff, 'utf8') : ''));
}

async function showInstances(root: string) {
  const all = findInstances(root);
  if (all.length === 0) console.log(`no instances under ${root}`);
  for (const i of all) {
    const waiting = findRunsWaitingOnPeople(await listRuns(i.data)).flatMap(run => formatNextSteps(run));
    console.log(`${i.repo}${existsSync(i.repo) ? '' : ' (gone)'}  ${i.dir}`);
    for (const line of waiting) console.log(`  ${line}`);
  }
}
