import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Exit } from 'effect';
import { parse } from 'yaml';
import { z } from 'zod';
import { compile, returnKinds, type Config } from './config.ts';
import { botEnv, git } from './git.ts';
import { plan, type PlannedJob } from './dispatch.ts';
import type { Issues } from './issues.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { runPlan, type JobResult } from './pipeline.ts';
import { localPulls, type Pulls } from './pulls.ts';
import { pipelineFor, type Hub } from './serve.ts';
import { limiter, unsandboxed } from './runner.ts';
import { Harness, HubTool } from './schema.ts';
import { openStore, reconcile, type Owner, type Run, type Store } from './store.ts';
import type { AgentEvent, BotEvent, HarnessAdapter, RunSpec } from './types.ts';
import { workspaces, type Workspaces } from './workspace.ts';

const list = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item)]).transform(v => (Array.isArray(v) ? v : [v]));

const Step = z.union([
  z.strictObject({ say: z.string() }),
  z.strictObject({ call: HubTool, with: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ write: z.record(z.string(), z.string()) }),
  z.strictObject({ propose: z.array(z.unknown()) }),
  z.strictObject({ fail: z.string() }),
  z.strictObject({ limit: z.string() }),
]);
export type SimStep = z.infer<typeof Step>;

/**
 * Faults to seed. `crash` stops the process once `after` effects of the job have landed (0: before any), then the sim
 * restarts, reconciles and retries the event. `redeliver` runs the first event a second time at the end.
 * `apply-fails` makes the first push, merge request or reply fail to apply.
 */
const Faults = z.strictObject({
  crash: z.strictObject({ job: z.string(), after: z.int().nonnegative().default(0) }).optional(),
  redeliver: z.boolean().optional(),
  'apply-fails': z.array(z.enum(['push', 'merge-request', 'reply'])).optional(),
});

const Start = z.strictObject({
  comment: z.strictObject({ issue: z.int().positive(), as: z.string(), body: z.string() }),
});

/**
 * A simulation: human actions on local issues, taken one after another, or with `parallel` all before any event they
 * cause runs, as if their jobs ran at once; the files the repository starts with, the
 * verdict of each check, the scripted steps of each job's bot and the faults to seed. Steps are keyed
 * `<workflow>/<job>`, or `<workflow>/<job>#<issue>` for one issue, with `/conflict` added for the run that resolves
 * merge conflicts. A job without steps ends at once with no proposals; a `write` step writes files into the
 * worktree; a `limit` step ends the job the way a provider usage limit does. `expect` lists merge requests the sim
 * must end with.
 */
export const Scenario = z.strictObject({
  title: z.string(),
  hub: z.string().default('..'),
  repo: z.string().default('acme/app'),
  files: z.record(z.string(), z.string()).default({}),
  start: list(Start),
  parallel: z.boolean().default(false),
  checks: z.record(z.string(), z.enum(['pass', 'fail'])).default({}),
  jobs: z.record(z.string(), z.array(Step)).default({}),
  faults: Faults.default({}),
  expect: z
    .strictObject({
      requests: z.array(
        z.strictObject({ branch: z.string(), into: z.string(), state: z.enum(['open', 'closed', 'merged']) })
      ),
    })
    .optional(),
});
export type Scenario = z.infer<typeof Scenario>;

const harness = fileURLToPath(new URL('./sim-harness.ts', import.meta.url));

/** Where the scripted steps of the run in worktree `cwd` are kept: next to the worktree, so they are not a change. */
const stepsFile = (cwd: string) => `${cwd}.sim.json`;

/** Runs every harness as the scripted sim harness; the run's MCP server is handed over in the environment. */
export const simAdapter = (name: Harness, seen: (spec: RunSpec) => void): HarnessAdapter => ({
  name,
  command: spec => {
    seen(spec);
    return {
      cmd: process.execPath,
      args: [harness],
      env: {
        BOTHUB_SIM_STEPS: stepsFile(spec.cwd),
        ...(spec.mcp && { BOTHUB_SIM_MCP: JSON.stringify(spec.mcp) }),
      },
    };
  },
  parseLine: line => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
});

/**
 * Checks become scripts with the scenario's verdict, script jobs become stubs unless they merge, jobs run once over
 * the event and nothing is installed, so nothing outside the sim runs.
 */
const stubbed = (config: Config, verdicts: Scenario['checks']): Config => ({
  ...config,
  hub: { ...config.hub, deps: undefined },
  checks: Object.fromEntries(
    Object.entries(config.checks).map(([name, { name: _, path, body, mode, description }]) => [
      name,
      {
        type: 'script' as const,
        run: verdicts[name] === 'fail' ? `echo "${name}: failing in this scenario"; exit 1` : 'true',
        over: 'diff' as const,
        mode,
        ...(description && { description }),
        name,
        path,
        body,
      },
    ])
  ),
  workflows: Object.fromEntries(
    Object.entries(config.workflows).map(([name, workflow]) => [
      name,
      {
        ...workflow,
        jobs: Object.fromEntries(
          Object.entries(workflow.jobs).map(([id, job]) => [
            id,
            job.type === 'script' && !returnKinds(job.returns ?? []).includes('merge')
              ? { ...job, over: 'event' as const, run: `echo "script ${id} is stubbed in the sim"` }
              : { ...job, over: 'event' as const },
          ])
        ),
      },
    ])
  ),
});

/** A bare repository with a README and `files` committed on `main`. */
const seed = async (root: string, files: Record<string, string>) => {
  const origin = join(root, 'origin.git');
  const work = join(root, 'seed');
  await mkdir(work, { recursive: true });
  await git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  await git(work, ['init', '-q', '-b', 'main']);
  for (const [path, content] of Object.entries({ 'README.md': '# sim\n', ...files })) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(work, ['add', '-A']);
  await git(work, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'start'], botEnv);
  await git(work, ['push', '-q', origin, 'main']);
  await rm(work, { recursive: true, force: true });
  return origin;
};

const snapshot = async (dir: string) =>
  new Map(
    await Promise.all(
      (await readdir(dir).catch(() => []))
        .filter(name => name.endsWith('.md'))
        .sort()
        .map(async name => [name, await readFile(join(dir, name), 'utf8')] as const)
    )
  );

const indent = (text: string, by = '      ') =>
  text
    .trimEnd()
    .split('\n')
    .map(line => by + line)
    .join('\n');

const oneLine = (text: string, max = 110) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const kb = (text: string) => `${(text.length / 1024).toFixed(1)} kB`;

/** The preloaded sections of a session (notes, the issue, linked issues) and their sizes. */
const preloaded = ({ system, prompt }: RunSpec) =>
  `${system}\n${prompt}`
    .split(/^(?=## )/m)
    .filter(section => /^## (Issue #|Linked issues)/.test(section))
    .map(section => `${section.slice(3, section.indexOf('\n')).split(':')[0]} ${kb(section)}`)
    .join(', ') || 'nothing';

const describe = (e: AgentEvent) => {
  if (e.type === 'tool_call') return `tool  ${e.tool} ${JSON.stringify(e.input)}`;
  if (e.type === 'tool_result') return `  ->  ${e.ok ? '' : 'error: '}${oneLine(e.output ?? '')}`;
  if (e.type === 'end' && !e.ok) return `end   failed: ${e.result ?? ''}`;
};

/** The steps scripted for `run`: for its issue's conflict run, its issue, or its job, whichever is given first. */
const stepsFor = (jobs: Scenario['jobs'], run: Run | undefined, merging: boolean) => {
  if (!run) return [];
  const job = `${run.workflow}/${run.job}`;
  const issue = `${job}#${run.event.number}`;
  const keys = merging ? [`${issue}/conflict`, issue, job] : [issue, job];
  return keys.map(key => jobs[key]).find(Boolean) ?? [];
};

/**
 * Runs a scenario end to end in a temporary copy of its hub, against a local bare origin and local merge requests:
 * each human action goes through the local issues backend, the watched change is dispatched, every job runs with the
 * sim harness and the bothub MCP server, accepted proposals land in the copy's `issues/`, the origin and
 * `pulls.jsonl`, and the `pull_request` events that follow run until none are left. Prints a readable trace and
 * resolves to the job results; throws when `expect` does not hold.
 */
export const simulate = async (file: string, out: (line: string) => void): Promise<JobResult[]> => {
  const scenario = Scenario.parse(parse(await readFile(file, 'utf8')));
  const source = resolve(dirname(file), scenario.hub);
  const root = await mkdtemp(join(tmpdir(), 'bothub-sim-'));
  const print = (line: string) => out(line.replaceAll(`${root}/`, 'sim://'));
  const hub = join(root, 'hub');
  const data = join(root, 'data');
  try {
    await cp(source, hub, { recursive: true, filter: path => basename(path) !== 'sims' });
    const compiled = compile(await readHub(hub));
    if (!compiled.ok) throw new Error(compiled.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
    if (compiled.config.hub.issues !== 'local') throw new Error('the sim needs a hub with `issues: local` in hub.yaml');
    const config = stubbed(compiled.config, scenario.checks);
    const { repo } = scenario;
    const dir = join(hub, 'issues');
    const issues = localIssues(dir, { repo });
    const before = await snapshot(dir);
    const origin = await seed(root, scenario.files);
    print(`sim: ${scenario.title}`);

    const { faults } = scenario;
    const crashed = new Error('the sim stopped the process');
    let crash = faults.crash;
    const failing = new Set(faults['apply-fails'] ?? []);
    const failOnce = (kind: 'push' | 'merge-request' | 'reply') => {
      if (!failing.delete(kind)) return;
      print(`      fault  ${kind} fails to apply`);
      throw new Error(`${kind} failed in this scenario`);
    };

    /** The store as one process sees it. A seeded crash throws once the job's journal holds `after` landed effects. */
    const storeFor = (owner?: Owner): Store => {
      const opened = openStore(data, owner);
      return {
        ...opened,
        saveOutcome: async (id, outcome) => {
          const saved = await opened.saveOutcome(id, outcome);
          const run = await opened.read(id);
          const landed = outcome.results.filter(result => result.status === 'applied').length;
          if (
            crash &&
            outcome.results.length &&
            `${run?.workflow}/${run?.job}` === crash.job &&
            landed >= crash.after
          ) {
            crash = undefined;
            throw crashed;
          }
          return saved;
        },
      };
    };
    let store = storeFor();

    let spec: RunSpec | undefined;
    const adapters = Object.fromEntries(
      Harness.options.map(name => [name, simAdapter(name, s => (spec = s))])
    ) as Record<Harness, HarnessAdapter>;
    const real = workspaces({ dataDir: data, cloneUrl: () => origin });
    const spaces: Workspaces = {
      ...real,
      create: async (start, runId) => {
        const created = await real.create(start, runId);
        const run = await store.read(runId);
        await writeFile(
          stepsFile(created.path),
          JSON.stringify(stepsFor(scenario.jobs, run, start.merge !== undefined))
        );
        if (run && created.conflicts.length)
          print(`      merge ${start.merge} into ${start.branch} conflicts in ${created.conflicts.join(', ')}`);
        return created;
      },
      publish: async (target, runId, push) => {
        failOnce('push');
        const url = await real.publish(target, runId, push);
        print(`      git push ${push.branch}`);
        return url;
      },
    };
    const local = localPulls({ origin, file: join(data, 'pulls.jsonl'), repo });
    const pulls: Pulls = {
      ...local,
      open: async request => {
        failOnce('merge-request');
        const pull = await local.open(request);
        print(`      request #${pull.number} opened: ${pull.branch} into ${pull.into}`);
        return pull;
      },
      merge: async (number, expected) => {
        try {
          const merged = await local.merge(number, expected);
          print(`      request #${number} merged`);
          return merged;
        } catch (e) {
          print(`      request #${number} not merged: ${(e as Error).message}`);
          throw e;
        }
      },
    };
    const tracker: Issues = {
      ...issues,
      comment: async (number, body) => {
        if (body.includes('/reply-')) failOnce('reply');
        return issues.comment(number, body);
      },
    };

    let current = '';
    const runOnce = async (jobs: PlannedJob[], event: BotEvent) => {
      const served: Hub = {
        dir: hub,
        data,
        store,
        workspaces: spaces,
        limit: await Effect.runPromise(limiter(1)),
        env: {},
        config: async () => config,
        backend: () => ({ pulls, issues: tracker }),
        log: () => {},
        adapters,
        launch: unsandboxed,
        onCheck: () => {},
        onEvent: (run, { event: e }) => {
          if (e.type === 'start' && spec) {
            const name = `${run.workflow}/${run.job}${run.attempt ? ` attempt ${run.attempt}` : ''}`;
            if (name !== current) {
              current = name;
              const tools = spec.mcp ? (spec.mcp.args[spec.mcp.args.indexOf('--tools') + 1] ?? '') : 'none';
              print(`\njob    ${name} (${run.bot})`);
              print(`       preload ${preloaded(spec)} (session ${kb(spec.system + spec.prompt)})`);
              print(`       tools   ${tools}`);
            }
          }
          const line = describe(e);
          if (line) print(`       ${line}`);
        },
      };
      const exit = await Effect.runPromiseExit(runPlan(jobs, pipelineFor(served, config, event)));
      if (Exit.isSuccess(exit)) return exit.value;
      const error = Cause.squash(exit.cause);
      if (error !== crashed) throw error;
    };

    const results: JobResult[] = [];
    const handle = async (event: BotEvent) => {
      const by = `#${event.number} by @${event.actor.login}`;
      print(`\nevent  ${event.trigger} (${event.action}) on ${by}: ${oneLine(event.body ?? '')}`);
      const jobs = plan(event, config);
      print(`plan   ${jobs.map(j => `${j.workflow}/${j.job}`).join(', ') || 'no jobs'}`);
      current = '';
      const done = await runOnce(jobs, event);
      if (done) return void results.push(...done);
      print(`\ncrash  the process stopped during ${faults.crash?.job}`);
      const restarted = { pid: process.pid, token: 'restarted' };
      store = storeFor(restarted);
      for (const run of await reconcile(store, spaces, restarted))
        print(`reconcile ${run.workflow}/${run.job}: ${run.status}, ${run.error}`);
      print(`retry  ${event.id}`);
      current = '';
      results.push(...((await runOnce(plan(event, config), event)) ?? []));
    };
    const handled = new Set<string>();
    const drain = async () => {
      for (;;) {
        const fresh = (await local.events()).filter(event => !handled.has(event.id));
        if (!fresh.length) return;
        for (const event of fresh) {
          handled.add(event.id);
          await handle(event);
        }
      }
    };

    const started: BotEvent[] = [];
    for (const { comment } of scenario.start) {
      await localIssues(dir, { repo, as: comment.as }).comment(comment.issue, comment.body);
      const said = (await issues.get(comment.issue))?.comments.length ?? 0;
      const event: BotEvent = {
        id: `local-${comment.issue}-comment-${said}`,
        ts: new Date().toISOString(),
        source: 'local',
        trigger: 'issue_comment',
        action: 'created',
        repo,
        number: comment.issue,
        actor: { login: comment.as, association: comment.as.endsWith('[bot]') ? 'NONE' : 'OWNER' },
        body: comment.body,
      };
      started.push(event);
      await handle(event);
      if (!scenario.parallel) await drain();
    }
    await drain();
    const [first] = started;
    if (faults.redeliver && first) {
      const ran = new Set(results.map(r => r.run.id));
      const again = (await runOnce(plan(first, config), first)) ?? [];
      const fresh = again.filter(r => !ran.has(r.run.id));
      print(`\nredeliver ${first.id}: ${fresh.length ? `${fresh.length} jobs ran again` : 'every job reused'}`);
      results.push(...fresh);
    }

    print('\nresults');
    for (const r of results) {
      const name = `${r.workflow}/${r.job}`;
      const why = r.run.error ?? r.run.reason;
      print(`  ${name}: ${r.run.status}, ${r.run.closure}${why ? ` (${oneLine(why, 80)})` : ''}`);
      const checks = r.outcome?.checks ?? [];
      if (checks.length)
        print(
          `    checks   ${checks.map(v => `${v.check} ${v.skipped ? 'skipped' : v.pass ? 'pass' : 'fail'}`).join(', ')}`
        );
      for (const p of r.outcome?.accepted ?? []) print(`    proposal ${p.kind}: ${oneLine(JSON.stringify(p))}`);
      for (const { proposal, reason } of r.outcome?.rejected ?? []) print(`    rejected ${proposal.kind}: ${reason}`);
      for (const result of r.outcome?.results ?? [])
        print(
          `    applied  ${result.kind}: ${result.status}${result.url ? ` ${result.url}` : ''}${result.reason ? ` (${result.reason})` : ''}`
        );
    }

    const requests = await local.list({ state: 'all' });
    if (requests.length) print('\nrequests');
    for (const r of requests) print(`  #${r.number} ${r.branch} into ${r.into}: ${r.state}`);

    print('\nissues/');
    const after = await snapshot(dir);
    for (const [name, text] of after) {
      const old = before.get(name);
      if (old === text) continue;
      if (old === undefined) print(`  + ${name} (new)\n${indent(text, '    | ')}`);
      else print(`  ~ ${name}\n${lineDiff(old, text)}`);
    }

    const missing = (scenario.expect?.requests ?? []).filter(
      want => !requests.some(r => r.branch === want.branch && r.into === want.into && r.state === want.state)
    );
    if (missing.length)
      throw new Error(
        `expected requests missing: ${missing.map(r => `${r.branch} into ${r.into} ${r.state}`).join(', ')}`
      );
    return results;
  } finally {
    await rm(join(root, 'origin.git'), { recursive: true, force: true });
  }
};

/** Lines removed and added between two versions of a file; enough for frontmatter edits and appended comments. */
const lineDiff = (before: string, after: string) => {
  const old = before.split('\n');
  const now = after.split('\n');
  return [
    ...old.filter(line => line && !now.includes(line)).map(line => `    - ${line}`),
    ...now.filter(line => line && !old.includes(line)).map(line => `    + ${line}`),
  ].join('\n');
};
