import { readFile } from 'node:fs/promises';
import { defineCommand, runCommand, showUsage, type CommandDef } from 'citty';
import { z } from 'zod';
import { compile, type Compiled } from './config.ts';
import { plan } from './dispatch.ts';
import { toEvent } from './github.ts';
import { readHub } from './load.ts';
import { PersonaFrontmatter, WorkflowFrontmatter } from './schema.ts';

const json = { type: 'boolean', description: 'Print JSON (default when stdout is not a terminal)' } as const;
const dir = { type: 'string', description: 'Hub directory', default: '.' } as const;

const asJson = (flag: boolean | undefined) => flag ?? !process.stdout.isTTY;
const print = (text: string) => process.stdout.write(text.endsWith('\n') ? text : text + '\n');
const fail = (text: string) => process.stderr.write(`bothub: ${text}\n`);

const loadConfig = async (path: string): Promise<Compiled> => {
  const files = await readHub(path);
  if (!files.length) return { ok: false, errors: [{ path, message: 'no personas/*.md or workflows/*.md found' }] };
  return compile(files);
};

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
  args: {
    event: { type: 'string', description: 'GitHub event name, e.g. issue_comment', required: true },
    payload: { type: 'positional', description: 'Webhook payload JSON file', required: true },
    dir,
    json,
  },
  async run({ args }) {
    const result = await loadConfig(args.dir);
    if (!result.ok) {
      for (const e of result.errors) fail(`${e.path}: ${e.message}`);
      return 2;
    }
    const event = toEvent(args.event, 'cli', JSON.parse(await readFile(args.payload, 'utf8')));
    const jobs = event ? plan(event, result.config) : [];
    if (asJson(args.json)) print(JSON.stringify({ event, jobs }));
    else if (!jobs.length) print('no jobs');
    else
      for (const j of jobs)
        print(`${j.workflow}/${j.job}${j.persona ? ` (${j.persona})` : ''}${j.args ? `: ${j.args}` : ''}`);
    return 0;
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

const commands: Record<string, CommandDef<any>> = { check, plan: planCmd, schema };

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
