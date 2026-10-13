import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { defineCommand, runCommand, showUsage, type CommandDef } from 'citty';
import { Effect } from 'effect';
import { z } from 'zod';
import { compile, type Config } from './config.ts';
import { plan } from './dispatch.ts';
import { harnesses } from './harnesses/index.ts';
import { githubApp } from './github-app.ts';
import { toEvent } from './github.ts';
import { localIssues } from './issues-local.ts';
import { readHub } from './load.ts';
import { McpTool, serveMcp } from './mcp.ts';
import { buildSpec, type JobResult } from './pipeline.ts';
import { limiter } from './runner.ts';
import { sandboxConfig, sandboxNetwork } from './sandbox.ts';
import { handleEvent, localOrigin, serveHub } from './serve.ts';
import { serveGitHub } from './serve-github.ts';
import { simulate } from './sim.ts';
import { compareSpend } from './spend.ts';
import { openStore, runId, type Run } from './store.ts';
import type { AgentEvent, BotEvent } from './types.ts';
import { workspaces, worktreePath } from './workspace.ts';

const json = { type: 'boolean', description: 'Print JSON (default when stdout is not a terminal)' } as const;
const dir = { type: 'string', description: 'Hub directory', default: '.' } as const;
const data = { type: 'string', description: 'Data directory (default: $BOTHUB_DATA or ~/.bothub)' } as const;
const followInterval = 500;

const asJson = (flag: boolean | undefined) => flag ?? !process.stdout.isTTY;
const print = (text: string) => process.stdout.write(text.endsWith('\n') ? text : text + '\n');
const fail = (text: string) => process.stderr.write(`bothub: ${text}\n`);

/** A positive whole number from a flag, or undefined after reporting why it is not one. */
const positive = (flag: string, value: string) => {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  fail(`--${flag} must be a positive whole number, not "${value}"`);
};

/** The sandbox settings, or undefined after reporting why they are rejected. */
const sandbox = () => {
  try {
    return sandboxConfig();
  } catch (error) {
    fail((error as Error).message);
    return undefined;
  }
};

const loadConfig = async (path: string) => {
  const files = await readHub(path);
  if (!files.length)
    return { ok: false as const, errors: [{ path, message: 'no bots, skills, checks, workflows or notes found' }] };
  return compile(files);
};

/** The hub's config, or undefined after reporting each error. */
const compiled = async (path: string): Promise<Config | undefined> => {
  const result = await loadConfig(path);
  if (result.ok) return result.config;
  for (const e of result.errors) fail(`${e.path}: ${e.message}`);
};

/** The hub's local issue tracker, when `hub.yaml` selects one; GitHub issues come from the app client instead. */
const hubIssues = (config: Config, dir: string, repo: string) =>
  config.hub.issues === 'local' ? localIssues(join(dir, 'issues'), { repo }) : undefined;

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
      return [
        ['usage', e.source, e.model, `${e.inputTokens} in`].filter(Boolean).join(' '),
        `${e.outputTokens} out`,
        e.ms !== undefined && `${e.ms} ms`,
        e.direct && 'direct',
        e.error && 'failed',
      ]
        .filter(Boolean)
        .join(', ');
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
    case 'recall':
      return `recall ${e.on} ${e.items.filter(i => i.fate === 'surfaced' || i.fate === 'returned').length}/${e.items.length}, ${e.tokens} tokens`;
    case 'decision':
      return `decision ${e.on}${e.tool ? ` ${e.tool}` : ''} ${e.p === undefined ? `unanswered: ${oneLine(e.error ?? '')}` : `p ${e.p.toFixed(2)}`}${e.acted ? ', acted' : ''}`;
  }
};

const shellQuote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

const summary = (r: JobResult) => {
  const name = `${r.workflow}/${r.job}`;
  const parts = [r.run.status, `run ${r.run.id}`];
  const why = r.run.error ?? (r.run.status === 'skipped' ? r.run.reason : undefined);
  if (why) parts.push(oneLine(why));
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

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const check = defineCommand({
  meta: { name: 'check', description: 'Validate a hub: bots, skills, checks, workflows and notes (fails closed)' },
  args: { dir, json },
  async run({ args }) {
    const result = await loadConfig(args.dir);
    if (asJson(args.json) && !result.ok) print(JSON.stringify(result));
    if (!result.ok) {
      if (!asJson(args.json)) for (const e of result.errors) fail(`${e.path}: ${e.message}`);
      return 2;
    }
    const issues = await hubIssues(result.config, args.dir, 'hub/issues')
      ?.list({ state: 'all' })
      .catch((e: Error) => e);
    if (issues instanceof Error) {
      if (asJson(args.json))
        print(JSON.stringify({ ok: false, errors: [{ path: 'issues', message: issues.message }] }));
      else fail(issues.message);
      return 2;
    }
    const { bots, skills, checks, workflows, notes } = result.config;
    const jobs = Object.values(workflows).reduce((n, w) => n + Object.keys(w.jobs).length, 0);
    if (asJson(args.json)) print(JSON.stringify({ ok: true, warnings: result.warnings }));
    else {
      for (const w of result.warnings) process.stderr.write(`warning: ${w.path}: ${w.message}\n`);
      print(
        `ok: ${[
          count(Object.keys(bots).length, 'bot'),
          count(Object.keys(skills).length, 'skill'),
          count(Object.keys(checks).length, 'check'),
          `${count(Object.keys(workflows).length, 'workflow')} (${count(jobs, 'job')})`,
          count(notes.length, 'note'),
          ...(issues ? [count(issues.length, 'local issue')] : []),
          ...(result.warnings.length ? [count(result.warnings.length, 'warning')] : []),
        ].join(', ')}`
      );
    }
    return 0;
  },
});

/** Each planned job as a dry run shows it: a script's command, or a bot's session and harness command. */
const sessions = (config: Config, event: BotEvent, hub: string, root: string) =>
  plan(event, config).map(job => {
    const workflow = config.workflows[job.workflow];
    const step = workflow?.jobs[job.job];
    if (!workflow || step?.type !== 'bot') return { ...job, script: step?.type === 'script' ? step.run : '' };
    const built = buildSpec({ ...job, config, workflow, event, cwd: worktreePath(root, runId()), hub, data: root });
    const { spec, bot, timeoutMinutes, branch } = built;
    const { cmd, args } = harnesses[bot.harness].command(spec);
    return {
      ...job,
      harness: bot.harness,
      timeoutMinutes,
      ...(branch && { branch }),
      ...(built.job.until && { until: built.job.until }),
      spec,
      command: [cmd, ...args],
    };
  });

const printSession = (s: ReturnType<typeof sessions>[number]) => {
  if ('script' in s) return print(`${s.workflow}/${s.job} (run)\n$ sh -c ${shellQuote(s.script)}\n\n`);
  const shown = (arg: string) =>
    arg === s.spec.system ? '<system>' : arg === s.spec.prompt ? '<prompt>' : shellQuote(arg);
  print(`${s.workflow}/${s.job} (${s.bot}, ${s.harness}, ${s.timeoutMinutes} min)`);
  if (s.until) print(`until: ${s.until.checks.join(', ')} pass, at most ${s.until.max} more attempts`);
  print(`cwd: ${s.spec.cwd}`);
  const split = s.command.indexOf('--');
  const command =
    split >= 0 && s.command.length - split > 2 && s.command.slice(split + 1).join(' ') === s.spec.prompt
      ? [...s.command.slice(0, split + 1), s.spec.prompt]
      : s.command;
  print(`$ ${command.map(shown).join(' ')}\n\n`);
  print(`--- system\n${s.spec.system}\n\n`);
  print(`--- prompt\n${s.spec.prompt}\n\n`);
};

const run = defineCommand({
  meta: { name: 'run', description: 'Run the jobs a GitHub webhook payload starts, on this machine' },
  args: {
    event: { type: 'string', description: 'GitHub event name, e.g. issue_comment', required: true },
    payload: { type: 'positional', description: 'Webhook payload JSON file', required: true },
    dir,
    data,
    'dry-run': { type: 'boolean', description: 'Print the jobs and each agent session instead of starting them' },
    json,
  },
  async run({ args }) {
    const config = await compiled(args.dir);
    if (!config) return 2;
    const event = toEvent(args.event, `cli-${randomUUID()}`, JSON.parse(await readFile(args.payload, 'utf8')));
    const root = resolve(dataDir(args.data));
    const hub = resolve(args.dir);
    if (!event || !plan(event, config).length) {
      print(asJson(args.json) ? JSON.stringify({ event, jobs: [] }) : 'no jobs');
      return 0;
    }
    if (args['dry-run']) {
      const jobs = sessions(config, event, hub, root);
      if (asJson(args.json)) print(JSON.stringify({ event, jobs }));
      else jobs.forEach(printSession);
      return 0;
    }

    if (!sandbox()) return 2;
    const env = await loadEnv(root);
    const app = await appFrom(env);
    if (!app)
      fail(
        'no GitHub App credentials (BOTHUB_APP_ID, BOTHUB_APP_KEY_FILE, BOTHUB_INSTALLATION_ID): nothing is applied'
      );
    const issues = hubIssues(config, args.dir, event.repo);
    const results = await handleEvent(event, {
      dir: hub,
      data: root,
      store: openStore(root),
      workspaces: workspaces({ dataDir: root, ...(app && { token: app.token }) }),
      limit: await Effect.runPromise(limiter()),
      env,
      config: async () => config,
      backend: () => ({ ...(app && { gh: app.gh }), ...(issues && { issues }) }),
      log: line => process.stderr.write(`${line}\n`),
      onEvent: (r, record) => process.stderr.write(`${r.workflow}/${r.job} ${describe(record.event)}\n`),
    });
    if (asJson(args.json)) print(JSON.stringify(results));
    else for (const r of results) print(summary(r));
    return results.some(r => r.run.status !== 'succeeded' && r.run.status !== 'skipped') ? 1 : 0;
  },
});

const runTable = (list: Run[]) => {
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
};

const totals = ({ calls, in: input, out, usd }: { calls: number; in: number; out: number; usd: number }) =>
  `${calls} calls, ${input} in, ${out} out, $${usd.toFixed(2)}`;

const printSpend = (spend: Awaited<ReturnType<typeof compareSpend>>) => {
  print(
    `model calls from ${spend.since} to ${spend.until}, as bothub recorded them and as the model proxy logged them`
  );
  for (const k of spend.keys)
    print(`${k.key}: bothub ${totals(k.bothub)}; proxy ${totals(k.proxy)}; missing ${totals(k.missing)}`);
  print(`keys no bot holds: proxy ${totals(spend.other)}`);
  for (const [bot, t] of Object.entries(spend.direct))
    print(`${bot}: straight to Ollama, outside the proxy, ${totals(t)}`);
};

const logs = defineCommand({
  meta: {
    name: 'logs',
    description:
      "List runs, newest first, or print one run's events; with --spend, compare recorded model calls with the model proxy's logs",
  },
  args: {
    id: { type: 'positional', description: 'Run id', required: false },
    data,
    follow: { type: 'boolean', description: 'Keep printing until the run finishes' },
    spend: {
      type: 'boolean',
      description: "Compare the model calls recorded per bot key with the model proxy's spend logs",
    },
    hours: { type: 'string', description: 'With --spend: how many hours back to compare', default: '24' },
    json,
  },
  async run({ args }) {
    const root = dataDir(args.data);
    const store = openStore(root);
    if (args.spend) {
      const hours = positive('hours', args.hours);
      if (!hours) return 2;
      try {
        const spend = await compareSpend({ store, env: await loadEnv(root), since: Date.now() - hours * 3_600_000 });
        if (asJson(args.json)) print(JSON.stringify(spend));
        else printSpend(spend);
        return 0;
      } catch (e) {
        fail((e as Error).message);
        return 1;
      }
    }
    if (!args.id) {
      const list = await store.list();
      if (asJson(args.json)) print(JSON.stringify(list));
      else if (!list.length) print('no runs');
      else runTable(list);
      return 0;
    }
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

const mcp = defineCommand({
  meta: { name: 'mcp', description: "Serve a hub's tools over MCP on stdio" },
  args: {
    dir,
    data,
    repo: { type: 'string', description: 'Repository the issues belong to', default: 'hub/issues' },
    tools: { type: 'string', description: 'Comma-separated tools to serve', default: McpTool.options.join(',') },
  },
  async run({ args }) {
    const config = await compiled(args.dir);
    if (!config) return 2;
    const tools = z.array(McpTool).safeParse(args.tools.split(',').filter(Boolean));
    if (!tools.success) {
      fail(`unknown tool in "${args.tools}", expected ${McpTool.options.join(', ')}`);
      return 2;
    }
    const issues = hubIssues(config, args.dir, args.repo);
    await serveMcp(tools.data, {
      config,
      ...(issues && { issues }),
      ...(args.data && { store: openStore(args.data) }),
      ...(process.env.HOME && { home: process.env.HOME }),
    });
    return 0;
  },
});

const sim = defineCommand({
  meta: { name: 'sim', description: 'Simulate a scenario end to end on a temporary copy of its hub' },
  args: { scenario: { type: 'positional', description: 'Scenario YAML file', required: true } },
  async run({ args }) {
    await simulate(args.scenario, print);
    return 0;
  },
});

const serveCmd = defineCommand({
  meta: {
    name: 'serve',
    description:
      "Run the jobs a hub's events start and serve the studio API: local issues for a hub with `issues: local`, GitHub App webhooks otherwise",
  },
  args: {
    hub: { ...dir, required: true },
    data,
    repo: { type: 'string', description: 'Local issues: the local bare repository used as origin' },
    name: { type: 'string', description: 'Local issues: the repository name events carry (default: local/<repo>)' },
    prewarm: { type: 'boolean', description: "Local issues: install the hub's deps at start, not on the first run" },
    repos: { type: 'string', description: 'GitHub: comma-separated owner/repo allowlist (default: every one)' },
    'webhook-port': { type: 'string', description: 'GitHub: webhook port, the only one to expose', default: '5183' },
    port: { type: 'string', description: 'Studio API port', default: '5181' },
    concurrency: {
      type: 'string',
      description: 'Events and agent sessions that run at once; one event at a time per issue',
      default: '4',
    },
  },
  async run({ args }) {
    const settings = sandbox();
    if (!settings) return 2;
    const at = positive('concurrency', args.concurrency);
    if (!at) return 2;
    const root = dataDir(args.data);
    const config = await compiled(args.hub);
    if (!config) return 2;
    const env = await loadEnv(root);
    const common = { hub: args.hub, data: root, env, port: Number(args.port), concurrency: at };
    let stop: () => Promise<void>;
    if (config.hub.issues === 'local') {
      if (!args.repo) {
        fail('a hub with `issues: local` needs --repo, a local bare repository');
        return 2;
      }
      ({ stop } = await serveHub({
        ...common,
        origin: await localOrigin(args.repo),
        ...(args.name && { repo: args.name }),
        ...(args.prewarm && { prewarm: true }),
      }));
    } else {
      const { BOTHUB_APP_ID: appId, BOTHUB_APP_KEY_FILE: keyFile, BOTHUB_WEBHOOK_SECRET: secret } = env;
      if (!appId || !keyFile || !secret) {
        fail('serving GitHub needs BOTHUB_APP_ID, BOTHUB_APP_KEY_FILE and BOTHUB_WEBHOOK_SECRET');
        return 2;
      }
      ({ stop } = await serveGitHub({
        ...common,
        app: githubApp({ appId, privateKey: await readFile(keyFile, 'utf8') }),
        secret,
        ...(args.repos && { repos: args.repos.split(',').map(r => r.trim()) }),
        webhookPort: Number(args['webhook-port']),
      }));
    }
    process.stderr.write(`sandbox ${settings.image} on ${sandboxNetwork}, data ${root}\n`);
    await new Promise<void>(done => {
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    await stop();
    return 0;
  },
});

const shown = { check, run, serve: serveCmd, logs, sim };
const commands: Record<string, CommandDef<any>> = { ...shown, mcp };

export const cli = defineCommand({
  meta: { name: 'bothub', description: 'GitHub-driven agent runner' },
  subCommands: shown,
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
