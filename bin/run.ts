#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Effect, Redacted } from 'effect';
import { ensureDocker } from '../src/docker.ts';
import type { Instruction } from '../src/engine.ts';
import type { Hub } from '../src/hub.ts';
import { fileForge, Forge } from '../src/forge.ts';
import { readInstallationReach } from '../src/github.ts';
import {
  makeHarnessConfigProvider,
  readConfiguredHub,
  readHarnessSettings,
  splitNames,
  type Provider,
} from '../src/harnesses.ts';
import {
  defaultHub,
  ensureHub,
  ensureInstance,
  writePullToRepo,
  findInstances,
  findPull,
  findRepo,
  mergePull,
  ensureBase,
  writeClosed,
  writeComment,
  writeReview,
  writeInstanceProvider,
  writeLabels,
  type Instance,
} from '../src/instance.ts';
import { createLoopLock, isLoopHeld, readEngineEnv, start, writeTriggeringIssue } from '../src/main.ts';
import {
  findRunsWaitingOnPeople,
  formatInstanceFlags,
  formatIssueList,
  formatIssueTimeline,
  formatNextSteps,
  formatShellWord,
} from '../src/status.ts';
import { readHostSettings } from '../src/services.ts';
import { fileStore, pruneLogs, Store } from '../src/store.ts';
import type { Run } from '../src/workflow.ts';

const usage = `usage: npx agentgraph <verb> [flags]
  start "<title>[\\n<body>]" [--workflow <name>]   files an issue and drives it until it waits or ends
  loop [--once]                                   drives every open issue, again every AGENTGRAPH_EVERY minutes
  show [<n>|hub]                                  what needs you and every issue, one issue in full, or the hub
  say <n> "<text>" [--line <path>:<line>]         an /agent comment on issue n, then drives it
  review <n> approve|changes ["<text>"]           a review of issue n's pull request; changes drives it
  merge <n>                                       merges issue n's pull request and closes the issue
  export <n> [--as <branch>] [--patch <file>]     writes issue n's branch into your repo again
  close <n>                                       closes issue n
  check [<check>... --runs [--issue <n>]]        validates the hub, or runs checks again on ended runs
  dispatch <n> --workflow <name> [--step <step>]  starts a workflow that takes dispatch on issue n
  prune-logs [--apply]                            counts the check logs no trace names, or deletes them
flags: --data <dir> --repo <dir> --base <branch> --hub <dir> --forge github|<dir> --logs all|failed|off
       --provider <name> [--save] --harness <name> --model <model>; start and say take --label <label>...`;

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
    harness: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    save: { type: 'boolean' },
    label: { type: 'string', multiple: true },
  },
  allowPositionals: true,
});
const [verb = '', ...rest] = positionals;
const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
if (values.logs) process.env.AGENTGRAPH_CHECK_LOGS = values.logs;
const isIssueNumber = (k: number) => Number.isInteger(k) && k > 0;
const n = Number(rest[0]);
const numbered = () => (isIssueNumber(n) ? n : fail(`${verb} takes an issue number\n${usage}`));
const said = () => rest.slice(1).join(' ').trim();
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;
const listRuns = (data: string, filter: Parameters<Store['Type']['list']>[0] = {}) =>
  Effect.runPromise(Effect.flatMap(Store, s => s.list(filter)).pipe(Effect.provide(fileStore(data))));
const printRuns = (runs: Run[]) => {
  for (const run of runs) console.log(`${run.id} ${run.step} ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
};
const makeHarnessChoice = (provider: string | undefined) => ({
  config: host.config,
  provider,
  harness: values.harness,
});
const formatUnserved = (provider: Provider, harness: string) =>
  `${provider.name} does not serve ${harness}. It serves ${provider.harnesses.join(' and ')}.`;
const checkHub = async (hub: string, i: Pick<Instance, 'provider'> | undefined) => {
  const problems = await Effect.runPromise(
    Effect.zip(readHarnessSettings, readConfiguredHub(hub)).pipe(
      Effect.map(([{ providers = [], provider: named }, loaded]) => {
        const provider = providers.find(p => p.name === named);
        return provider ? findUnserved(provider, loaded) : [];
      }),
      Effect.catchTag('HubError', e => Effect.succeed(e.problems)),
      Effect.withConfigProvider(makeHarnessConfigProvider(makeHarnessChoice(values.provider ?? i?.provider)))
    )
  );
  for (const p of problems) console.error(`${p.path}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s)` : 'ok');
  process.exit(problems.length ? 1 : 0);
};

const noModel = `No model to use. Any one of these works:
  npx agentgraph start --provider claude "..."     Claude subscription, through claude setup-token
  npx agentgraph start --provider chatgpt "..."    ChatGPT subscription, through a device login
  export ANTHROPIC_API_KEY=...                     Anthropic API
  export AGENTGRAPH_PROXY_KEYS=...                 your LiteLLM at AGENTGRAPH_PROXY_URL`;

const pickProvider = async (i: Instance, after: string): Promise<{ provider: Provider; ready?: boolean }> => {
  const { providers = [], provider: named } = await Effect.runPromise(
    readHarnessSettings.pipe(
      Effect.withConfigProvider(makeHarnessConfigProvider(makeHarnessChoice(values.provider ?? i.provider)))
    )
  ).catch((e: Error) => fail(e.message, 1));
  if (named)
    return {
      provider:
        providers.find(p => p.name === named) ??
        fail(`no provider ${named}; the config has ${providers.map(p => p.name).join(', ')}`),
    };
  const found: { provider: Provider; ready: boolean }[] = [];
  for (const provider of providers) {
    const ready = await provider.ready(host);
    if (ready || provider.detect?.(host)) found.push({ provider, ready });
  }
  if (found.length === 0) fail(`${noModel}\n${after}`, 1);
  if (found.length === 1) {
    writeInstanceProvider(i, found[0]!.provider.name);
    return found[0]!;
  }
  const names = found.map(f => f.provider.name);
  if (!process.stdin.isTTY) fail(`${names.join(' and ')} are ready; pass --provider ${names.join(' or --provider ')}`);
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await lines.question(`${names.join(' and ')} are ready. Use which? [${names.join('/')}] `)).trim();
  lines.close();
  const picked =
    found.find(f => f.provider.name === answer) ?? fail(`${answer || 'nothing'} is not one of ${names.join(', ')}`);
  writeInstanceProvider(i, picked.provider.name);
  return picked;
};

const findUnserved = (provider: Provider, hub: Hub) =>
  Object.values(hub.agents)
    .filter(a => !provider.harnesses.includes(a.harness))
    .map(a => ({
      path: a.path,
      message: formatUnserved(provider, a.harness),
    }));

const connect = async (i: Instance, hub: string, after: string) => {
  if (!host.sandbox) {
    const docker = await Effect.runPromise(ensureDocker(line => console.log(`sandbox  ${line}`), host.image)).catch(
      (e: Error) => fail(`${e.message}\n${after}`, 1)
    );
    console.log(`sandbox  docker ${docker}`);
  }
  const { provider, ready } = await pickProvider(i, after);
  if (values.save && values.provider) writeInstanceProvider(i, provider.name);
  const harness = values.harness ?? provider.harnesses[0]!;
  if (!provider.harnesses.includes(harness)) fail(`${formatUnserved(provider, harness)}\n${after}`);
  console.log(
    `agentgraph ${version}: ${harness} on ${provider.name}, ${hub === defaultHub ? 'default hub' : `hub ${hub}`}, local forge`
  );
  console.log(`repo     ${i.repo}, base ${i.base}`);
  if (!(ready ?? (await provider.ready(host))))
    await (provider.login ?? (() => Promise.reject(new Error(`${provider.name} is not ready`))))(host).catch(
      (e: Error) => fail(`${e.message}\n${after}`, 1)
    );
  Object.assign(process.env, provider.settings?.() ?? {});
  const aliases = new Map(
    splitNames(process.env.AGENTGRAPH_MODELS ?? '').map(pair => pair.split('=', 2) as [string, string])
  );
  return { provider, ...(values.model && { model: aliases.get(values.model) ?? values.model }) };
};

const loadServedHub = async ({ provider, model }: Awaited<ReturnType<typeof connect>>, hub: string) => {
  const loaded = await Effect.runPromise(
    readConfiguredHub(hub).pipe(Effect.withConfigProvider(makeHarnessConfigProvider(makeHarnessChoice(provider.name))))
  );
  if (model)
    process.env.AGENTGRAPH_MODELS = ['*', ...Object.values(loaded.agents).flatMap(a => a.model ?? [])]
      .map(alias => `${alias}=${model}`)
      .join(',');
  const unserved = findUnserved(provider, loaded);
  if (unserved.length) throw new Error(unserved.map(p => `${p.path}: ${p.message}`).join('\n'));
  return loaded;
};

const prepare = async (i: Instance, hub: string, after: string) => {
  const connection = await connect(i, hub, after);
  const loaded = await loadServedHub(connection, hub).catch((e: Error) => fail(`${e.message}\n${after}`, 1));
  return { loaded, provider: connection.provider.name };
};

const stopping = new AbortController();
const trapInterrupt = () =>
  process.on('SIGINT', () => {
    if (stopping.signal.aborted) process.exit(130);
    console.error('stopping; runs resume where they were on the next drive (Ctrl-C again quits now)');
    stopping.abort();
  });

const host = await readHostSettings(values).catch((e: Error) => fail(e.message));
const { onForge, data: root } = host;

const selected = formatInstanceFlags(values.repo && resolve(values.repo), values.data && root);

if (verb === 'check' && values.hub && !values.runs) {
  const repo = onForge ? undefined : await findRepo(resolve(values.repo ?? '.'));
  const saved = repo ? findInstances(root).find(i => i.repo === realpathSync(repo)) : undefined;
  await checkHub(resolve(values.hub), saved);
}
if (onForge) await runOnForge();
else await runOnInstance();

async function runOnForge() {
  if (values.provider || values.harness || values.model || values.save)
    fail('--provider, --harness, --model and --save work in a repo; a forge runner reads the hub and its env');
  const folder = values.forge && values.forge !== 'github' ? resolve(values.forge) : undefined;
  if (folder) process.env.AGENTGRAPH_FORGE = folder;
  const hub = values.hub && resolve(values.hub);
  const needHub = () => hub ?? fail(`${verb} on a forge needs --hub`);
  switch (verb) {
    case 'loop': {
      if (values.once) return printRuns(await start({ hub: needHub(), issue: 'all', data: root }));
      process.env.AGENTGRAPH_DATA = root;
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
        ...findRunsWaitingOnPeople(await listRuns(root)).flatMap(run =>
          formatNextSteps(run, folder ? undefined : repo)
        ),
      ];
      console.log(lines.length ? `Needs you\n${lines.join('\n')}` : 'Nothing needs you');
      return;
    }
    case 'check':
    case 'dispatch':
      return printRuns(await start({ hub: needHub(), issue: 'all', data: root, instruction: instructed() }));
    case 'prune-logs':
      return prune(root);
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
  const issue = Number(values.issue);
  if (values.issue !== undefined && !isIssueNumber(issue)) fail('--issue takes an issue number');
  return {
    kind: 'check',
    checks: rest,
    ...(values.workflow !== undefined && { workflow: values.workflow }),
    ...(values.issue !== undefined && { issue }),
  };
}

async function prune(data: string) {
  const { files, bytes } = await pruneLogs(data, values.apply);
  console.log(`${values.apply ? 'deleted' : 'would delete'} ${files} unreferenced log(s), ${bytes} bytes`);
}

async function runOnInstance() {
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
    return ensureHub(i, values.hub).catch((e: Error) => fail(e.message, 1));
  };
  switch (verb) {
    case 'start': {
      const text = rest.join(' ').trim();
      if (!text) fail(`start takes the issue text\n${usage}`);
      const hub = await synced();
      const { loaded, provider } = await prepare(i, hub, 'Nothing was filed.');
      const issue = await writeTriggeringIssue(
        { ...loaded, trust: [i.owner] },
        i.forge,
        text,
        i.owner,
        values.workflow,
        values.label
      ).catch((e: Error) => fail(e.message));
      console.log(`#${issue} ${text.split('\n')[0]}`);
      return drive(i, issue, hub, provider);
    }
    case 'say': {
      if (!said()) fail(`say takes text\n${usage}`);
      const issue = await findIssueOf(i, numbered());
      const hub = await synced();
      const { provider } = await prepare(i, hub, 'Nothing was posted.');
      await writeComment(i.forge, i.owner, n, `/agent ${said()}`, values.line).catch((e: Error) => fail(e.message));
      if (values.label) await writeLabels(i.forge, i.owner, issue, values.label).catch((e: Error) => fail(e.message));
      return drive(i, issue, hub, provider);
    }
    case 'review': {
      const verdict = ({ approve: 'approved', changes: 'changes_requested' } as const)[
        rest[1] as 'approve' | 'changes'
      ];
      if (!verdict) fail('review takes approve or changes');
      const text = rest.slice(2).join(' ').trim();
      const issue = await findIssueOf(i, numbered());
      const hub = await synced();
      const prepared = verdict === 'changes_requested' && (await prepare(i, hub, 'Nothing was posted.'));
      await writeReview(i.forge, i.owner, n, verdict, text).catch((e: Error) => fail(e.message));
      if (prepared) return drive(i, issue, hub, prepared.provider);
      console.log(`approved #${n}`);
      return;
    }
    case 'merge': {
      await synced();
      const pull = await mergePull(i, numbered()).catch((e: Error) => fail(e.message, 1));
      console.log(`${pull.base} at ${pull.head.slice(0, 7)} in agentgraph`);
      return report(i, n, true);
    }
    case 'export': {
      numbered();
      const result = await writePullToRepo(i, n, {
        ...(values.as && { as: values.as }),
        ...(values.patch && { patch: values.patch }),
      }).catch((e: Error) => fail(e.message, 1));
      if (!result) return fail(`#${n} has no pull request`, 1);
      if ('why' in result)
        return fail(values.patch ? result.why : `${result.why}; try --as <branch> or --patch <file>`, 1);
      if (!values.patch) return report(i, n);
      console.log(`${result.stat}\nPatch: ${result.ref}    git am ${formatShellWord(result.ref)}`);
      return;
    }
    case 'close': {
      const pull = await findPull(i.forge, numbered());
      const open = new Set((await Effect.runPromise((await forgeOf()).issues({ state: 'open' }))).map(t => t.number));
      const closed = [...new Set([n, await findIssueOf(i, n), pull?.number ?? n])].filter(k => open.has(k));
      for (const k of closed) await writeClosed(i.forge, i.owner, k);
      console.log(closed.length ? `closed #${closed.join(' and #')}` : `nothing open on #${n}`);
      return;
    }
    case 'show':
      if (rest[0] === 'hub') {
        const hub = await synced();
        console.log(
          `hub ${hub}${hub === defaultHub ? ' (default; copy it to .agentgraph/ in your repo to change it)' : ''}`
        );
        for (const file of readdirSync(hub, { recursive: true, encoding: 'utf8' }).toSorted()) console.log(`  ${file}`);
        return;
      }
      return rest[0] ? showIssue(await forgeOf(), numbered(), i) : showAll(i, await forgeOf());
    case 'check':
    case 'dispatch': {
      if (verb === 'check' && !values.runs) return checkHub(await synced(), i);
      const hub = await synced();
      const { provider } = await prepare(i, hub, 'Nothing was run.');
      const choice = makeHarnessChoice(provider);
      return printRuns(
        await start({ hub, issue: 'all', data: i.data, base: i.base, instruction: instructed(), choice })
      );
    }
    case 'loop':
      return loop(i);
    case 'prune-logs':
      return prune(i.data);
    default:
      fail(usage);
  }
}

function watchRuns(i: Instance, issue: number) {
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
}

async function findIssueOf(i: Instance, n: number) {
  const branch = (await findPull(i.forge, n))?.pull.branch ?? '';
  return Number(/^agentgraph\/(\d+)$/.exec(branch)?.[1] ?? n);
}

async function drive(i: Instance, issue: number, hub: string, provider: string) {
  trapInterrupt();
  if (await isLoopHeld(i.data)) {
    console.log(
      `a loop drives this repo and takes #${issue} on its next pass; npx agentgraph show ${issue}${selected}`
    );
    return;
  }
  const stop = watchRuns(i, issue);
  const runs = await start(
    { hub, issue, data: i.data, marked: true, base: i.base, choice: makeHarnessChoice(provider) },
    undefined,
    {},
    stopping.signal
  ).catch((e: unknown) => {
    if (!stopping.signal.aborted) throw e;
    return undefined;
  });
  await stop();
  if (!runs) {
    console.log(`stopped; npx agentgraph say ${issue} "go on"${selected} resumes it`);
    process.exit(130);
  }
  if (runs.length === 0) console.log(`nothing to do on #${issue}`);
  return report(i, issue);
}

async function report(i: Instance, issue: number, merged = false) {
  const result = await writePullToRepo(i, issue, values.as ? { as: values.as } : {}).catch((e: Error) => ({
    why: e.message,
  }));
  if (result && 'why' in result)
    console.log(`not written to your repo: ${result.why}\n  npx agentgraph export ${issue} --as <branch>${selected}`);
  else if (result) {
    const { ref, base, stat } = result;
    if (stat) console.log(`\n${stat}`);
    console.log(`In your repo: ${ref}    git diff ${formatShellWord(`${base}...${ref}`)}`);
    console.log(
      `Worktree:     git worktree add ${formatShellWord(`../${basename(i.repo)}-${issue}`)} ${formatShellWord(ref)}`
    );
  }
  const waiting = findRunsWaitingOnPeople(await listRuns(i.data, { issue })).flatMap(run =>
    formatNextSteps(run, undefined, selected)
  );
  const merge = result && !('why' in result) ? [`  git merge ${formatShellWord(result.ref)}`] : [];
  const steps = merged ? merge : waiting.filter(l => l.startsWith('  '));
  if (steps.length) console.log(`Next:\n${steps.join('\n')}`);
}

async function loop(i: Instance) {
  const moved = await ensureBase(i);
  if (moved) fail(moved, 1);
  const first = await ensureHub(i, values.hub).catch((e: Error) => fail(e.message, 1));
  const connection = await connect(i, first, 'Nothing was driven.');
  const release = await createLoopLock(i.data).catch(() => fail(`another loop drives ${i.repo}`, 1));
  trapInterrupt();
  try {
    while (!stopping.signal.aborted) {
      let hub = '';
      const why =
        (await ensureBase(i)) ||
        (await ensureHub(i, values.hub)
          .then(dir => loadServedHub(connection, (hub = dir)))
          .then(
            () => '',
            (e: Error) => e.message
          ));
      if (why) console.error(why);
      else {
        const runs = await start(
          { hub, issue: 'all', data: i.data, base: i.base, choice: makeHarnessChoice(connection.provider.name) },
          undefined,
          {},
          stopping.signal
        ).catch((e: unknown) => (stopping.signal.aborted ? [] : (console.error(e), [])));
        printRuns(runs);
        for (const issue of new Set(runs.map(r => r.issue))) {
          const result = await writePullToRepo(i, issue).catch((e: Error) => ({ why: e.message }));
          if (result)
            console.log(
              'why' in result
                ? `#${issue} not written: ${result.why}; npx agentgraph export ${issue} --as <branch>${selected}`
                : `#${issue} in your repo as ${result.ref}`
            );
        }
      }
      if (values.once || stopping.signal.aborted) break;
      const woken = new AbortController();
      const signal = AbortSignal.any([stopping.signal, woken.signal]);
      await Promise.race([sleep(host.every * 60_000, undefined, { signal }), watch(i.forge, { signal }).next()]).catch(
        () => {}
      );
      woken.abort();
    }
  } finally {
    await release();
  }
}

async function showAll(i: Instance, forge: Forge['Type']) {
  const lines = findRunsWaitingOnPeople(await listRuns(i.data)).flatMap(run =>
    formatNextSteps(run, undefined, selected)
  );
  console.log(lines.length ? `Needs you\n${lines.join('\n')}\n` : 'Nothing needs you\n');
  console.log(formatIssueList(await Effect.runPromise(forge.issues())));
}

async function showIssue(forge: Forge['Type'], issue: number, i: Instance) {
  const pull = await findPull(i.forge, issue);
  for (const k of new Set([issue, pull?.number ?? issue])) {
    const t = await Effect.runPromise(forge.issue(k)).catch((e: Error) => fail(e.message, 1));
    const diff = join(i.forge, String(k), 'diff.patch');
    console.log(formatIssueTimeline(t, existsSync(diff) ? readFileSync(diff, 'utf8') : ''));
  }
}

async function showInstances(root: string) {
  const all = findInstances(root);
  if (all.length === 0) console.log(`no instances under ${root}`);
  for (const i of all) {
    const waiting = findRunsWaitingOnPeople(await listRuns(i.data)).flatMap(run =>
      formatNextSteps(run, undefined, formatInstanceFlags(i.repo, root))
    );
    console.log(`${i.repo}${existsSync(i.repo) ? '' : ' (gone)'}  ${i.dir}`);
    for (const line of waiting) console.log(`  ${line}`);
  }
}
