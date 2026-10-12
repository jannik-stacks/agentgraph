import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { defineCommand, runCommand, showUsage, type CommandDef } from 'citty';
import { Effect } from 'effect';
import { z } from 'zod';
import { compile, type Compiled } from './config.ts';
import { plan } from './dispatch.ts';
import { executors } from './executors/index.ts';
import { githubApp } from './github-app.ts';
import { toEvent } from './github.ts';
import { readHub } from './load.ts';
import { buildSpec, runPlan, type JobResult } from './pipeline.ts';
import { limiter } from './runner.ts';
import { PersonaFrontmatter, WorkflowFrontmatter } from './schema.ts';
import { openStore, runId, type Run } from './store.ts';
import type { AgentEvent } from './types.ts';
import { workspaces, worktreePath } from './workspace.ts';

const json = { type: 'boolean', description: 'Print JSON (default when stdout is not a terminal)' } as const;
const dir = { type: 'string', description: 'Hub directory', default: '.' } as const;
const data = { type: 'string', description: 'Data directory (default: $BOTHUB_DATA or ~/.bothub)' } as const;
const eventName = { type: 'string', description: 'GitHub event name, e.g. issue_comment', required: true } as const;
const payload = { type: 'positional', description: 'Webhook payload JSON file', required: true } as const;
const followInterval = 500;

const asJson = (flag: boolean | undefined) => flag ?? !process.stdout.isTTY;
const print = (text: string) => process.stdout.write(text.endsWith('\n') ? text : text + '\n');
const fail = (text: string) => process.stderr.write(`bothub: ${text}\n`);

const loadConfig = async (path: string): Promise<Compiled> => {
  const files = await readHub(path);
  if (!files.length) return { ok: false, errors: [{ path, message: 'no personas/*.md or workflows/*.md found' }] };
  return compile(files);
};

const loadPlan = async (args: { dir: string; event: string; payload: string }) => {
  const result = await loadConfig(args.dir);
  if (!result.ok) {
    for (const e of result.errors) fail(`${e.path}: ${e.message}`);
    return;
  }
  const event = toEvent(args.event, 'cli', JSON.parse(await readFile(args.payload, 'utf8')));
  return { config: result.config, event, jobs: event ? plan(event, result.config) : [] };
};

const dataDir = (flag: string | undefined) => flag ?? process.env.BOTHUB_DATA ?? join(homedir(), '.bothub');

/** The process env over the data directory's `.env`; runs only receive the secrets picked from it by name. */
const loadEnv = async (root: string) => ({
  ...parseEnv(await readFile(join(root, '.env'), 'utf8').catch(() => '')),
  ...process.env,
});

const appFrom = async (env: Record<string, string | undefined>) => {
  const { BOTHUB_APP_ID: appId, BOTHUB_APP_KEY_FILE: keyFile, BOTHUB_INSTALLATION_ID: installation } = env;
  if (!appId || !keyFile || !installation) return;
  const app = githubApp({ appId, privateKey: await readFile(keyFile, 'utf8') });
  const id = Number(installation);
  return { gh: app.client(id), token: () => app.installationToken(id) };
};

const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const describe = (e: AgentEvent): string => {
  switch (e.type) {
    case 'start':
      return ['start', e.model, e.session && `session ${e.session}`].filter(Boolean).join(' ');
    case 'text':
      return `text ${oneLine(e.text)}`;
    case 'tool_call':
      return `call ${e.tool} ${oneLine(JSON.stringify(e.input) ?? '')}`.trim();
    case 'tool_result':
      return `${e.ok ? 'ok' : 'fail'} ${oneLine(e.output ?? '')}`.trim();
    case 'usage':
      return `usage ${e.inputTokens} in, ${e.outputTokens} out`;
    case 'end':
      return [
        `end ${e.ok ? 'ok' : 'failed'}`,
        e.turns !== undefined && `${e.turns} turns`,
        e.costUsd !== undefined && `$${e.costUsd.toFixed(2)}`,
      ]
        .filter(Boolean)
        .join(', ');
    case 'error':
      return `error ${oneLine(e.message)}`;
  }
};

const shellQuote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

const summary = (r: JobResult) => {
  const name = `${r.workflow}/${r.job}`;
  if ('skipped' in r) return `${name}: skipped, ${r.skipped}`;
  const parts = [r.run.status, `run ${r.run.id}`];
  if (r.run.error) parts.push(oneLine(r.run.error));
  if (r.outcome) {
    const { accepted, rejected, errors, applied } = r.outcome;
    parts.push(`${accepted.length} accepted`, `${rejected.length + errors.length} rejected`);
    parts.push(applied ? 'applied' : 'not applied');
  }
  return `${name}: ${parts.join(', ')}`;
};

const ago = (ts: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const active = (run: Run | undefined) => run?.status === 'queued' || run?.status === 'running';

const check = defineCommand({
  meta: { name: 'check', description: 'Validate personas and workflows (fails closed)' },
  args: { dir, json },
  async run({ args }) {
    const result = await loadConfig(args.dir);
    if (asJson(args.json)) print(JSON.stringify(result.ok ? { ok: true } : result));
    if (!result.ok) {
      if (!asJson(args.json)) for (const e of result.errors) fail(`${e.path}: ${e.message}`);
      return 2;
    }
    const { personas, workflows } = result.config;
    if (!asJson(args.json))
      print(`ok: ${Object.keys(personas).length} personas, ${Object.keys(workflows).length} workflows`);
    return 0;
  },
});

const planCmd = defineCommand({
  meta: { name: 'plan', description: 'Show which jobs a GitHub webhook payload would start' },
  args: { event: eventName, payload, dir, json },
  async run({ args }) {
    const loaded = await loadPlan(args);
    if (!loaded) return 2;
    const { event, jobs } = loaded;
    if (asJson(args.json)) print(JSON.stringify({ event, jobs }));
    else if (!jobs.length) print('no jobs');
    else
      for (const j of jobs)
        print(`${j.workflow}/${j.job}${j.persona ? ` (${j.persona})` : ''}${j.args ? `: ${j.args}` : ''}`);
    return 0;
  },
});

const run = defineCommand({
  meta: { name: 'run', description: 'Run the jobs a GitHub webhook payload starts, on this machine' },
  args: {
    event: eventName,
    payload,
    dir,
    data,
    'dry-run': { type: 'boolean', description: 'Print each agent session instead of starting it' },
    json,
  },
  async run({ args }) {
    const loaded = await loadPlan(args);
    if (!loaded) return 2;
    const { config, event, jobs } = loaded;
    const root = dataDir(args.data);
    if (!event || !jobs.length) {
      print(asJson(args.json) ? JSON.stringify({ event, jobs: [] }) : 'no jobs');
      return 0;
    }

    if (args['dry-run']) {
      const sessions = jobs.map(job => {
        const workflow = config.workflows[job.workflow];
        const persona = job.persona ? config.personas[job.persona] : undefined;
        if (!workflow || !persona) return { ...job, skipped: 'the job has no persona' };
        const { spec, timeoutMinutes } = buildSpec({
          ...job,
          persona,
          workflow,
          event,
          cwd: worktreePath(root, runId()),
        });
        const { cmd, args: argv } = executors[persona.executor].command(spec);
        return { ...job, executor: persona.executor, timeoutMinutes, spec, command: [cmd, ...argv] };
      });
      if (asJson(args.json)) print(JSON.stringify({ event, jobs: sessions }));
      else
        for (const s of sessions) {
          if ('skipped' in s) {
            print(`${s.workflow}/${s.job}: skipped, ${s.skipped}\n\n`);
            continue;
          }
          const shown = (arg: string) =>
            arg === s.spec.system ? '<system>' : arg === s.spec.prompt ? '<prompt>' : shellQuote(arg);
          print(`${s.workflow}/${s.job} (${s.persona}, ${s.executor}, ${s.timeoutMinutes} min)`);
          print(`cwd: ${s.spec.cwd}`);
          print(`$ ${s.command.map(shown).join(' ')}\n\n`);
          print(`--- system\n${s.spec.system}\n\n`);
          print(`--- prompt\n${s.spec.prompt}\n\n`);
        }
      return 0;
    }

    const env = await loadEnv(root);
    const app = await appFrom(env);
    if (!app)
      fail(
        'no GitHub App credentials (BOTHUB_APP_ID, BOTHUB_APP_KEY_FILE, BOTHUB_INSTALLATION_ID): shadow mode, nothing is applied'
      );
    const results = await Effect.runPromise(
      Effect.flatMap(limiter(1), limit =>
        runPlan(jobs, {
          config,
          event,
          store: openStore(root),
          workspaces: workspaces({ dataDir: root, ...(app && { token: app.token }) }),
          limit,
          env,
          ...(app && { gh: app.gh }),
          onEvent: (r, record) => process.stderr.write(`${r.workflow}/${r.job} ${describe(record.event)}\n`),
        })
      )
    );
    if (asJson(args.json)) print(JSON.stringify(results));
    else for (const r of results) print(summary(r));
    return results.some(r => 'run' in r && r.run.status !== 'succeeded') ? 1 : 0;
  },
});

const runs = defineCommand({
  meta: { name: 'runs', description: 'List runs, newest first' },
  args: { data, json },
  async run({ args }) {
    const list = await openStore(dataDir(args.data)).list();
    if (asJson(args.json)) print(JSON.stringify(list));
    else if (!list.length) print('no runs');
    else {
      const rows = list.map(r => [
        r.id,
        r.status,
        `${r.workflow}/${r.job}`,
        r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : '-',
        ago(r.startedAt ?? r.event.ts),
      ]);
      const widths = rows[0]?.map((_, i) => Math.max(...rows.map(row => row[i]?.length ?? 0))) ?? [];
      for (const row of rows)
        print(
          row
            .map((cell, i) => cell.padEnd(widths[i] ?? 0))
            .join('  ')
            .trimEnd()
        );
    }
    return 0;
  },
});

const logs = defineCommand({
  meta: { name: 'logs', description: "Print a run's events" },
  args: {
    id: { type: 'positional', description: 'Run id', required: true },
    data,
    follow: { type: 'boolean', description: 'Keep printing until the run finishes' },
    json,
  },
  async run({ args }) {
    const store = openStore(dataDir(args.data));
    if (!(await store.read(args.id))) {
      fail(`unknown run "${args.id}"`);
      return 2;
    }
    for (let from = 0; ; await sleep(followInterval)) {
      const current = await store.read(args.id);
      const records = await store.events(args.id, from);
      for (const r of records)
        print(asJson(args.json) ? JSON.stringify(r) : `${r.ts.slice(11, 19)} ${describe(r.event)}`);
      from = (records.at(-1)?.seq ?? from - 1) + 1;
      if (!args.follow || !active(current)) return 0;
    }
  },
});

const schema = defineCommand({
  meta: { name: 'schema', description: 'Print JSON Schemas for persona and workflow frontmatter' },
  run() {
    const toSchema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });
    print(JSON.stringify({ persona: toSchema(PersonaFrontmatter), workflow: toSchema(WorkflowFrontmatter) }, null, 2));
    return 0;
  },
});

const commands: Record<string, CommandDef<any>> = { check, plan: planCmd, run, runs, logs, schema };

export const cli = defineCommand({
  meta: { name: 'bothub', description: 'GitHub-driven agent runner' },
  subCommands: commands,
});

/** Runs the CLI and resolves to a process exit code. */
export const main = async (argv: string[]): Promise<number> => {
  const [name, ...rest] = argv;
  const sub = name ? commands[name] : undefined;
  if (!sub || rest.includes('--help') || rest.includes('-h')) {
    await showUsage(sub ?? cli, sub ? cli : undefined);
    if (name && !sub && name !== '--help' && name !== '-h') fail(`unknown command "${name}"`);
    return sub || name === '--help' || name === '-h' ? 0 : 2;
  }
  try {
    const { result } = await runCommand(sub, { rawArgs: rest });
    return typeof result === 'number' ? result : 0;
  } catch (e) {
    fail((e as Error).message);
    return 2;
  }
};
