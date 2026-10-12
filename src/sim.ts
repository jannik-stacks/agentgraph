import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Exit } from 'effect';
import { parse } from 'yaml';
import { z } from 'zod';
import { compile, type Config } from './config.ts';
import { dispatch, plan, type PlannedJob } from './dispatch.ts';
import type { GitHub } from './github-app.ts';
import type { Issues } from './issues.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { bothubServer } from './mcp-config.ts';
import { runPlan, type JobResult } from './pipeline.ts';
import { limiter, unsandboxed } from './runner.ts';
import { Harness, HubTool } from './schema.ts';
import { openStore, reconcile, type Owner, type Store } from './store.ts';
import type { AgentEvent, BotEvent, HarnessAdapter, RunSpec } from './types.ts';
import type { Workspaces } from './workspace.ts';

const Step = z.union([
  z.strictObject({ say: z.string() }),
  z.strictObject({ call: HubTool, with: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ propose: z.array(z.unknown()) }),
  z.strictObject({ fail: z.string() }),
  z.strictObject({ limit: z.string() }),
]);
export type SimStep = z.infer<typeof Step>;

/**
 * Faults to seed. `crash` stops the process once `after` effects of the job have landed (0: before any), then the sim
 * restarts, reconciles and retries the event. `redeliver` delivers the event a second time at the end.
 * `apply-fails` makes the first push, pull request or reply fail to apply.
 */
const Faults = z.strictObject({
  crash: z.strictObject({ job: z.string(), after: z.int().nonnegative().default(0) }).optional(),
  redeliver: z.boolean().optional(),
  'apply-fails': z.array(z.enum(['push', 'open-pr', 'reply'])).optional(),
});

/**
 * A simulation: a human action on a local issue, the verdict of each check, the scripted steps of each job's bot,
 * keyed `<workflow>/<job>`, and the faults to seed. A job without steps ends at once with no proposals; a `limit`
 * step ends it the way a provider usage limit does.
 */
export const Scenario = z.strictObject({
  title: z.string(),
  hub: z.string().default('..'),
  repo: z.string().default('acme/app'),
  start: z.strictObject({
    comment: z.strictObject({ issue: z.int().positive(), as: z.string(), body: z.string() }),
  }),
  checks: z.record(z.string(), z.enum(['pass', 'fail'])).default({}),
  jobs: z.record(z.string(), z.array(Step)).default({}),
  faults: Faults.default({}),
});
export type Scenario = z.infer<typeof Scenario>;

const harness = fileURLToPath(new URL('./sim-harness.ts', import.meta.url));
const stepsFile = '.bothub-sim.json';

/** Runs every harness as the scripted sim harness; the run's MCP server is handed over in the environment. */
export const simAdapter = (name: Harness, seen: (spec: RunSpec) => void): HarnessAdapter => ({
  name,
  command: spec => {
    seen(spec);
    return {
      cmd: process.execPath,
      args: [harness],
      env: {
        BOTHUB_SIM_STEPS: join(spec.cwd, stepsFile),
        ...(spec.mcp && { BOTHUB_SIM_MCP: JSON.stringify(spec.mcp) }),
      },
    };
  },
  parseLine: line => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
});

/** Checks become scripts with the scenario's verdict, and script jobs become stubs, so nothing outside the sim runs. */
const stubbed = (config: Config, verdicts: Scenario['checks']): Config => ({
  ...config,
  checks: Object.fromEntries(
    Object.entries(config.checks).map(([name, { bot: _, skill: __, 'for-each': ___, paths: ____, ...check }]) => [
      name,
      { ...check, run: verdicts[name] === 'fail' ? `echo "${name}: failing in this scenario"; exit 1` : 'true' },
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
            job.run ? { ...job, run: `echo "script ${id} is stubbed in the sim"` } : job,
          ])
        ),
      },
    ])
  ),
});

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
    .filter(section => /^## (Notes|Issue #|Linked issues)/.test(section))
    .map(section => `${section.slice(3, section.indexOf('\n')).split(':')[0]} ${kb(section)}`)
    .join(', ') || 'nothing';

const describe = (e: AgentEvent) => {
  if (e.type === 'tool_call') return `tool  ${e.tool} ${JSON.stringify(e.input)}`;
  if (e.type === 'tool_result') return `  ->  ${e.ok ? '' : 'error: '}${oneLine(e.output ?? '')}`;
  if (e.type === 'end' && !e.ok) return `end   failed: ${e.result ?? ''}`;
};

/**
 * Runs a scenario end to end in a temporary copy of its hub: the human action goes through the local issues
 * backend, the watched change is dispatched, every job runs with the sim harness and the bothub MCP server, and the
 * accepted proposals are applied to the copy's `issues/`. Prints a readable trace and resolves to the job results.
 */
export const simulate = async (file: string, print: (line: string) => void): Promise<JobResult[]> => {
  const scenario = Scenario.parse(parse(await readFile(file, 'utf8')));
  const source = resolve(dirname(file), scenario.hub);
  const root = await mkdtemp(join(tmpdir(), 'bothub-sim-'));
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
    print(`sim: ${scenario.title}`);

    const { comment } = scenario.start;
    const events: BotEvent[] = [];
    const watching = issues.watch(event => events.push(event), { interval: 20 });
    await watching.ready;
    await localIssues(dir, { repo, as: comment.as }).comment(comment.issue, comment.body);
    while (!events.length) await new Promise(done => setTimeout(done, 10));
    watching.stop();
    const [event] = events as [BotEvent];
    print(`\nevent  ${event.trigger} (${event.action}) on #${event.number} by @${event.actor.login}: ${event.body}`);

    const { faults } = scenario;
    const crashed = new Error('the sim stopped the process');
    let crash = faults.crash;
    const failing = new Set(faults['apply-fails'] ?? []);
    const failOnce = (kind: 'push' | 'open-pr' | 'reply') => {
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
    const workspaces: Workspaces = {
      create: async (_, runId) => {
        const cwd = join(data, 'work', runId);
        const run = await store.read(runId);
        await mkdir(cwd, { recursive: true });
        await writeFile(join(cwd, stepsFile), JSON.stringify(scenario.jobs[`${run?.workflow}/${run?.job}`] ?? []));
        return { path: cwd, base: 'sim' };
      },
      publish: async (target, _, { branch, committed }) => {
        failOnce('push');
        await committed?.('sim');
        print(`      git push ${branch} (simulated)`);
        return `sim://${target}/tree/${branch}`;
      },
      changes: async () => ({ files: [], diff: '' }),
      remove: async (_, runId) => rm(join(data, 'work', runId), { recursive: true, force: true }),
    };
    const opened: string[] = [];
    const gh: GitHub = async <T>(method: string, path: string) => {
      print(`      github ${method} ${path} (simulated)`);
      if (path === `/repos/${repo}`) return { default_branch: 'main' } as T;
      if (method === 'GET' && path.includes('/pulls?')) return opened.map(html_url => ({ html_url })) as T;
      if (method === 'POST' && path.endsWith('/pulls')) failOnce('open-pr');
      const url = `sim://github${path}/${opened.length + 1}`;
      if (method === 'POST' && path.endsWith('/pulls')) opened.push(url);
      return { html_url: url } as T;
    };
    const tracker: Issues = {
      ...issues,
      comment: async (number, body) => {
        if (body.includes('/reply-')) failOnce('reply');
        return issues.comment(number, body);
      },
    };

    let current = '';
    const runOnce = async (jobs: PlannedJob[]) => {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(limiter(1), limit =>
          runPlan(jobs, {
            config,
            event,
            store,
            workspaces,
            limit,
            env: {},
            gh,
            issues: tracker,
            adapters,
            launch: unsandboxed,
            mcp: tools => bothubServer({ dir: hub, tools, repo, data }),
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
          })
        )
      );
      if (Exit.isSuccess(exit)) return exit.value;
      const error = Cause.squash(exit.cause);
      if (error !== crashed) throw error;
    };

    const jobs = await dispatch(event, config, store);
    print(`plan   ${jobs.map(j => `${j.workflow}/${j.job}`).join(', ') || 'no jobs'}`);
    let results = await runOnce(jobs);
    if (!results) {
      print(`\ncrash  the process stopped during ${faults.crash?.job}`);
      const restarted = { pid: process.pid, token: 'restarted' };
      store = storeFor(restarted);
      for (const run of await reconcile(store, workspaces, restarted))
        print(`reconcile ${run.workflow}/${run.job}: ${run.status}, ${run.error}`);
      print(`retry  ${event.id}`);
      current = '';
      results = (await runOnce(plan(event, config))) ?? [];
    }
    if (faults.redeliver) {
      const again = await dispatch(event, config, store);
      print(`\nredeliver ${event.id}: ${again.length ? 'planned again' : 'dropped, already delivered'}`);
      if (again.length) results.push(...((await runOnce(again)) ?? []));
    }

    print('\nresults');
    for (const r of results) {
      const name = `${r.workflow}/${r.job}`;
      if ('skipped' in r) {
        print(`  ${name}: skipped, ${r.closure} (${r.skipped})`);
        continue;
      }
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

    print('\nissues/');
    const after = await snapshot(dir);
    for (const [name, text] of after) {
      const old = before.get(name);
      if (old === text) continue;
      if (old === undefined) print(`  + ${name} (new)\n${indent(text, '    | ')}`);
      else print(`  ~ ${name}\n${lineDiff(old, text)}`);
    }
    return results;
  } finally {
    await rm(root, { recursive: true, force: true });
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
