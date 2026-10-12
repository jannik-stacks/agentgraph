import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { parse } from 'yaml';
import { z } from 'zod';
import { compile, type Config } from './config.ts';
import { plan } from './dispatch.ts';
import type { GitHub } from './github-app.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { bothubServer } from './mcp-config.ts';
import { runPlan, type JobResult } from './pipeline.ts';
import { limiter } from './runner.ts';
import { HubTool, type Executor } from './schema.ts';
import { openStore } from './store.ts';
import type { AgentEvent, BotEvent, ExecutorAdapter, RunSpec } from './types.ts';
import type { Workspaces } from './workspace.ts';

const Step = z.union([
  z.strictObject({ say: z.string() }),
  z.strictObject({ call: HubTool, with: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ propose: z.array(z.unknown()) }),
  z.strictObject({ fail: z.string() }),
]);
export type SimStep = z.infer<typeof Step>;

/**
 * A simulation: a human action on a local issue, the verdict of each check, and the scripted steps of each job's
 * bot, keyed `<workflow>/<job>`. A job without steps ends at once with no proposals.
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
});
export type Scenario = z.infer<typeof Scenario>;

const harness = fileURLToPath(new URL('./sim-harness.ts', import.meta.url));
const stepsFile = '.bothub-sim.json';

/** Runs every harness as the scripted sim harness; the run's MCP server is handed over in the environment. */
export const simAdapter = (name: Executor, seen: (spec: RunSpec) => void): ExecutorAdapter => ({
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

    const jobs = plan(event, config);
    print(`plan   ${jobs.map(j => `${j.workflow}/${j.job}`).join(', ') || 'no jobs'}`);

    const store = openStore(data);
    let spec: RunSpec | undefined;
    const adapters = Object.fromEntries(
      (['claude-code', 'codex', 'opencode', 'pi'] as const).map(name => [name, simAdapter(name, s => (spec = s))])
    ) as Record<Executor, ExecutorAdapter>;
    const workspaces: Workspaces = {
      create: async (_, runId) => {
        const cwd = join(data, 'work', runId);
        const run = await store.read(runId);
        await mkdir(cwd, { recursive: true });
        await writeFile(join(cwd, stepsFile), JSON.stringify(scenario.jobs[`${run?.workflow}/${run?.job}`] ?? []));
        return cwd;
      },
      publish: async (target, _, { branch }) => `sim://${target}/tree/${branch}`,
      changes: async () => ({ files: [], diff: '' }),
      remove: async (_, runId) => rm(join(data, 'work', runId), { recursive: true, force: true }),
    };
    const gh: GitHub = async <T>(method: string, path: string) => {
      print(`      github ${method} ${path} (simulated)`);
      return (path === `/repos/${repo}` ? { default_branch: 'main' } : { html_url: `sim://github${path}/1` }) as T;
    };

    let current = '';
    const results = await Effect.runPromise(
      Effect.flatMap(limiter(1), limit =>
        runPlan(jobs, {
          config,
          event,
          store,
          workspaces,
          limit,
          env: {},
          gh,
          issues,
          adapters,
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

    print('\nresults');
    for (const r of results) {
      const name = `${r.workflow}/${r.job}`;
      if ('skipped' in r) {
        print(`  ${name}: skipped, ${r.skipped}`);
        continue;
      }
      print(`  ${name}: ${r.run.status}${r.run.error ? ` (${oneLine(r.run.error, 80)})` : ''}`);
      const checks = r.outcome?.checks ?? [];
      if (checks.length) print(`    checks   ${checks.map(v => `${v.check} ${v.pass ? 'pass' : 'fail'}`).join(', ')}`);
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
