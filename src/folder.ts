import { getSha } from './hash.ts';
import { readOrUndefined } from './read.ts';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Data, Effect, Result, Schema } from 'effect';
import { parse } from 'yaml';
import { Count, issueStatuses, labelPrefix, limitLabels, type Event, type Issue, type IssueStatus } from './event.ts';
import { Kind } from './proposal.ts';
import { readPlugins } from './plugin.ts';
import { formatRetiredAdvice, retiredWords } from './retired.ts';
import { defaultPass, defaultReturns, whyPassUndecided } from './result.ts';
import {
  CommandSettings,
  commandVerbs,
  compileWorkflow,
  findTrustedLabel,
  formatIssues,
  splitFrontmatter,
  type Doc,
  type Problem,
  type Workflow,
} from './workflow.ts';
import { Agent, Check, CommandLimits, type Run } from './types.ts';

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));

const Limits = Schema.Struct({
  ...CommandLimits.fields,
  minutes: Positive.pipe(Schema.withDecodingDefaultType(Effect.succeed(30))),
  usdPerRun: Positive.pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
  parallel: Count.pipe(Schema.withDecodingDefaultType(Effect.succeed(2))),
  sessions: Count.pipe(Schema.withDecodingDefaultType(Effect.succeed(4))),
  max: Schema.optionalKey(
    Schema.Struct({ minutes: Schema.optionalKey(Positive), usdPerRun: Schema.optionalKey(Positive) }).pipe(
      Schema.encodeKeys({ usdPerRun: 'usd-per-run' })
    )
  ),
})
  .pipe(Schema.encodeKeys({ usdPerRun: 'usd-per-run' }))
  .check(
    Schema.makeFilter(l => {
      const low = Object.entries(limitLabels).find(([, field]) => (l.max?.[field] ?? l[field]) < l[field]);
      return !low || `max ${low[0]} is below ${low[0]} ${l[low[1]]}`;
    })
  );
type Limits = typeof Limits.Type;
type RunLimits = NonNullable<Run['limits']>;

export type Graph = {
  dir: string;
  repo: string;
  plugins?: Record<string, unknown>;
  tools?: string[];
  sha: string;
  agents: Record<string, Doc<Agent> & { readonly?: true; package?: string }>;
  skills: Record<string, Doc<SkillFile>>;
  checks: Record<string, Doc<Check> & { version: string }>;
  workflows: Record<string, Workflow>;
  limits: Limits;
  setup?: string;
  toolchain?: string;
  image?: string;
  network?: 'egress' | 'models';
  stacks?: boolean;
  milestone?: string;
  trust?: string[];
  commands?: typeof CommandSettings.Type;
  status?: false | Partial<Record<IssueStatus, string>>;
};

export class GraphError extends Data.TaggedError('GraphError')<{ problems: Problem[] }> {
  override get message() {
    return this.problems.map(p => `${p.path}: ${p.message}`).join('\n');
  }
}

export const GraphSettings = Schema.Struct({
  plugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  auth: Schema.optionalKey(Schema.String),
  setup: Schema.optionalKey(Schema.String),
  toolchain: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9][\w./:@-]*$/))),
  network: Schema.optionalKey(Schema.Literals(['egress', 'models'])),
  stacks: Schema.optionalKey(Schema.Boolean),
  milestone: Schema.optionalKey(Schema.String),
  commands: Schema.optionalKey(CommandSettings),
  status: Schema.optionalKey(
    Schema.Union([
      Schema.Literal(false),
      Schema.Record(Schema.Literals(issueStatuses), Schema.optionalKey(Schema.String)),
    ])
  ),
  limits: Limits.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});

export const parseGraphSettings = (text: string | undefined, say: (message: string) => void) => {
  let data: unknown = {};
  try {
    data = (text && parse(text)) ?? {};
  } catch (e) {
    say(`yaml: ${(e as Error).message}`);
  }
  return decode(GraphSettings, data, say);
};

const SkillFile = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});
type SkillFile = typeof SkillFile.Type;

const folders = new Set(['agents', 'skills', 'checks', 'workflows', 'scripts', 'fixtures', 'plugins', 'node_modules']);

const reads = (texts: string[], name: string) =>
  texts.some(text => new RegExp(`AGENTGRAPH_DIR[^\\n]*['"\`/]${name.replace(/\W/g, '\\$&')}['"\`/]`).test(text));

const unknownKinds = (body: string, say: (message: string) => void) => {
  const seen = new Set<string>();
  for (const [, name] of body.matchAll(/"kind":\s*"([\w-]+)"/g)) {
    if (seen.has(name!) || Schema.is(Kind)(name)) continue;
    seen.add(name!);
    say(`names the proposal kind ${name}, which the engine does not have`);
  }
};

/** @internal */
export const retiredIn = (text: string, say: (message: string) => void) => {
  for (const retired of retiredWords) {
    const found = retired.text?.exec(text);
    if (found) say(`says ${JSON.stringify(found[0].trim())}, which is retired; ${formatRetiredAdvice(retired)}`);
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  data: unknown,
  say: (message: string) => void
): S['Type'] | undefined => {
  const decoded = Schema.decodeUnknownResult(schema, { onExcessProperty: 'error', errors: 'all' })(data);
  if (Result.isSuccess(decoded)) return decoded.success;
  for (const { key, message } of formatIssues(decoded.failure.issue)) say(`${key}: ${message}`);
  return undefined;
};

type File = { path: string; text: string };

const markdown = async (dir: string, sub: string): Promise<File[]> => {
  const entries = (await readdir(join(dir, sub), { withFileTypes: true }).catch(readOrUndefined)) ?? [];
  const paths = entries
    .map(e => (e.isDirectory() ? `${sub}/${e.name}/SKILL.md` : e.name.endsWith('.md') ? `${sub}/${e.name}` : ''))
    .filter(path => path && (sub === 'skills' || !path.endsWith('/SKILL.md')))
    .sort();
  const files = await Promise.all(
    paths.map(path =>
      readFile(join(dir, path), 'utf8')
        .catch(readOrUndefined)
        .then(text => (text === undefined ? undefined : { path, text }))
    )
  );
  return files.filter(f => f !== undefined);
};

const getDocName = (path: string) => (path.endsWith('/SKILL.md') ? basename(path.slice(0, -9)) : basename(path, '.md'));

const compile = (
  settingsText: string | undefined,
  groups: Record<'agents' | 'skills' | 'checks' | 'workflows', File[]>,
  harnesses: readonly HarnessCheck[],
  forced = ''
) => {
  const problems: Problem[] = [];
  const sayer = (path: string) => (message: string) => problems.push({ path, message });
  const front = (file: File) => {
    try {
      return splitFrontmatter(file.text);
    } catch (e) {
      sayer(file.path)(`frontmatter: ${(e as Error).message}`);
      return undefined;
    }
  };

  const settings = parseGraphSettings(settingsText, sayer('settings.yaml'));

  const docs = <T>(files: File[], read: (data: unknown, say: (m: string) => void) => T | undefined) => {
    const out: Record<string, Doc<T>> = {};
    for (const file of files) {
      const parsed = front(file);
      const value = parsed && read(parsed.data, sayer(file.path));
      const name = getDocName(file.path);
      if (name in out) sayer(file.path)(`${name} is defined twice`);
      if (value !== undefined) out[name] = { ...value, name, path: file.path, body: parsed!.body };
    }
    return out;
  };

  const agents = docs(groups.agents, (data, say) => {
    const decoded = decode(Agent, data, say);
    const agent = decoded && { ...decoded, harness: forced || decoded.harness || (harnesses[0]?.name ?? '') };
    const harness = agent && harnesses.find(h => h.name === agent.harness);
    if (agent && !harness)
      say(`harness: ${agent.harness} is not in the config, which has ${harnesses.map(h => h.name).join(', ')}`);
    return agent;
  });
  const skills = docs(groups.skills, (data, say) => {
    const { description, uses } = isRecord(data) ? data : {};
    return decode(
      SkillFile,
      isRecord(data)
        ? { ...(description !== undefined && { description }), ...(uses !== undefined && { uses }) }
        : data,
      say
    );
  });
  const used = new Set(Object.values(skills).flatMap(s => s.uses ?? []));
  for (const skill of Object.values(skills))
    for (const name of skill.uses ?? []) if (!(name in skills)) sayer(skill.path)(`uses: unknown skill ${name}`);
  const checks = docs(groups.checks, (data, say): Check | undefined => {
    const check = decode(Check, data, say);
    if (!check) return;
    if (check.run === undefined && check.agent === undefined) say('name run, agent or both');
    if (check.agent !== undefined && !(check.agent in agents)) say(`agent: unknown agent ${check.agent}`);
    if (check.mode === 'info' && check.pass) say('pass: an info check never fails, so it takes no pass');
    const undecided = whyPassUndecided(check.returns ?? defaultReturns, check.pass ?? defaultPass);
    if (check.mode !== 'info' && undecided)
      say(`pass: ${undecided}; give the check a pass that reads it, or make it info`);
    return check;
  });

  for (const doc of [...Object.values(agents), ...Object.values(skills), ...Object.values(checks)])
    unknownKinds(doc.body, sayer(doc.path));
  for (const file of Object.values(groups).flat()) retiredIn(file.text, sayer(file.path));

  const names = {
    agents: Object.keys(agents),
    skills: Object.keys(skills),
    checks: Object.keys(checks),
    judged: Object.values(checks).flatMap(c => (c.agent === undefined ? [] : [c.name])),
    warned: Object.values(checks).flatMap(c => (c.mode === 'warn' || c.mode === 'info' ? [c.name] : [])),
  };
  const workflows: Record<string, Workflow> = {};
  for (const file of groups.workflows) {
    const loaded = compileWorkflow(file.path, file.text, names);
    problems.push(...loaded.problems);
    if (loaded.workflow) workflows[loaded.workflow.name] = loaded.workflow;
  }
  for (const w of Object.values(workflows))
    for (const step of w.steps) {
      if ('agent' in step.does && step.does.skill) used.add(step.does.skill);
      if (step.conflict && !['back', 'ask'].includes(step.conflict) && !workflows[step.conflict]?.on.conflict)
        sayer(w.path)(`steps.${step.name}.conflict: back, ask or a workflow on conflict, not ${step.conflict}`);
    }
  for (const name of Object.keys(settings?.commands ?? {}))
    if (!commandVerbs.includes(name) && !workflows[name]?.on.issue_comment)
      sayer('settings.yaml')(`commands.${name}: no command or comment workflow is named ${name}`);
  if (Object.keys(workflows).length === groups.workflows.length) {
    const steps = Object.values(workflows).flatMap(w => w.steps);
    const usedChecks = new Set([...steps, ...Object.values(workflows)].flatMap(s => s.checks));
    const usedAgents = new Set([
      ...steps.flatMap(step => ('agent' in step.does ? [step.does.agent] : [])),
      ...Object.values(checks).flatMap(check => (check.agent === undefined ? [] : [check.agent])),
    ]);
    for (const skill of Object.values(skills))
      if (!used.has(skill.name))
        sayer(skill.path)(
          `no step names ${skill.name} and no skill uses it; name it as a step's skill or in a skill's uses, or remove it`
        );
    for (const check of Object.values(checks))
      if (!usedChecks.has(check.name))
        sayer(check.path)(`no step or workflow names ${check.name} in its checks; name it in one or remove it`);
    for (const agent of Object.values(agents))
      if (!usedAgents.has(agent.name))
        sayer(agent.path)(`no step or check names ${agent.name} as its agent; name it in a step or remove it`);
  }
  return { settings, agents, skills, checks, workflows, problems };
};

export type HarnessCheck = {
  name: string;
  package: string;
  classify: (tool: string) => 'read' | 'write' | undefined;
  check?: (agent: Agent) => string[];
};

const readDocText = (files: File[], name?: string) => files.find(f => getDocName(f.path) === name)?.text ?? '';

export const loadGraph = (
  dir: string,
  harnesses: readonly HarnessCheck[],
  harness?: string
): Effect.Effect<Graph, GraphError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(dir, { withFileTypes: true }),
      catch: e =>
        new GraphError({
          problems: [
            {
              path: dir,
              message:
                e instanceof Error && 'code' in e && e.code === 'ENOENT'
                  ? 'no graph found; copy an example into this folder or choose an existing graph folder'
                  : `unreadable: ${String(e)}`,
            },
          ],
        }),
    });
    const read = yield* Effect.tryPromise({
      try: async () => {
        const settingsText = await readFile(join(dir, 'settings.yaml'), 'utf8').catch(readOrUndefined);
        const [agents, skills, checks, workflows] = await Promise.all(
          (['agents', 'skills', 'checks', 'workflows'] as const).map(sub => markdown(dir, sub))
        );
        const groups = { agents: agents!, skills: skills!, checks: checks!, workflows: workflows! };
        const scripts = await Promise.all(
          (
            await Promise.all(
              ['scripts', 'plugins'].map(sub =>
                readdir(join(dir, sub), { recursive: true, withFileTypes: true })
                  .catch(readOrUndefined)
                  .then(entries => entries ?? [])
              )
            )
          )
            .flat()
            .filter(e => e.isFile())
            .map(e => join(e.parentPath, e.name))
            .sort()
            .map(async p => ({ path: relative(dir, p), text: await readFile(p, 'utf8') }))
        );
        const texts = [settingsText ?? '', ...scripts.map(f => f.text)];
        texts.push(...Object.values(groups).flatMap(files => files.map(f => f.text)));
        const unread = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && !folders.has(e.name))
          .map(e => e.name)
          .filter(name => !reads(texts, name));
        return { settingsText, groups, scripts, unread };
      },
      catch: e => new GraphError({ problems: [{ path: dir, message: `unreadable: ${String(e)}` }] }),
    });
    const { settings, problems, ...parts } = compile(read.settingsText, read.groups, harnesses, harness);
    for (const name of read.unread)
      problems.push({
        path: name,
        message: `nothing reads ${name}/; the engine loads agents, skills, checks and workflows, and a graph script reads a folder through $AGENTGRAPH_DIR`,
      });
    const registry = settings
      ? yield* Effect.tryPromise({
          try: () =>
            readPlugins(dir, settings.plugins, {
              isReserved: name =>
                harnesses.some(
                  harness =>
                    typeof harness.classify === 'function' && ['read', 'write'].includes(harness.classify(name) ?? '')
                ),
            }),
          catch: error => ({ path: 'plugins', message: (error as Error).message }),
        }).pipe(
          Effect.match({
            onFailure: problem => {
              problems.push(problem);
              return undefined;
            },
            onSuccess: registry => registry,
          })
        )
      : undefined;
    const agents: Graph['agents'] = { ...parts.agents };
    for (const agent of Object.values(parts.agents)) {
      const harness = harnesses.find(harness => harness.name === agent.harness);
      if (!harness) continue;
      const builtins = agent.tools.filter(name => !registry || !Object.hasOwn(registry.tools, name));
      const checked: Agent['tools'] = [];
      let reads = true;
      for (const name of builtins) {
        const kind = typeof harness.classify === 'function' ? harness.classify(name) : undefined;
        reads &&= kind === 'read';
        if (kind === 'read' || kind === 'write') checked.push(name);
        else if (registry) problems.push({ path: agent.path, message: `tools: unknown tool ${name}` });
      }
      agents[agent.name] = { ...agent, package: harness.package, ...(reads && { readonly: true as const }) };
      for (const message of harness.check?.({ ...agent, tools: checked }) ?? [])
        problems.push({ path: agent.path, message: `harness: ${harness.name} ${message}` });
    }
    if (problems.length > 0 || !settings || !registry) return yield* new GraphError({ problems });
    const tools = Object.keys(registry.tools);
    const scripts = read.scripts.map(f => `${f.path}\0${f.text}`).join('\0');
    const checks = Object.fromEntries(
      Object.entries(parts.checks).map(([name, check]) => [
        name,
        {
          ...check,
          version: getSha(
            [
              readDocText(read.groups.checks, name),
              readDocText(read.groups.agents, check.agent),
              scripts,
              check.agent && parts.agents[check.agent]?.harness,
              check.agent && parts.agents[check.agent]?.model,
            ].join('\0'),
            12
          ),
        },
      ])
    );
    return {
      dir: resolve(dir),
      repo: '',
      sha: getSha(
        [
          { path: 'settings.yaml', text: read.settingsText ?? '' },
          ...Object.values(read.groups).flat(),
          ...read.scripts,
        ]
          .map(file => `${file.path}\0${file.text}\0`)
          .join('')
      ),
      limits: settings.limits,
      ...(tools.length && { tools }),
      ...(settings.plugins !== undefined && { plugins: settings.plugins }),
      ...(settings.setup !== undefined && { setup: settings.setup }),
      ...(settings.toolchain !== undefined && { toolchain: settings.toolchain }),
      ...(settings.image !== undefined && { image: settings.image }),
      ...(settings.network !== undefined && { network: settings.network }),
      ...(settings.stacks !== undefined && { stacks: settings.stacks }),
      ...(settings.milestone !== undefined && { milestone: settings.milestone }),
      ...(settings.commands !== undefined && { commands: settings.commands }),
      ...(settings.status !== undefined && { status: settings.status }),
      ...parts,
      agents,
      checks,
    };
  });

export const parseIssueLimits = (
  limits: Limits,
  issue: Pick<Issue, 'labels'> & { events: readonly Event[] }
): RunLimits | { why: string } => {
  const read = (key: keyof typeof limitLabels): RunLimits['minutes'] | { why: string } => {
    const field = limitLabels[key];
    const prefix = `${labelPrefix}${key}:`;
    const set = issue.labels.flatMap(name => {
      const event = name.startsWith(prefix) ? findTrustedLabel(issue.events, name) : undefined;
      return event ? [{ name, actor: event.actor, at: event.at }] : [];
    });
    const label = set[0];
    if (set.length > 1) return { why: `${set.map(l => l.name).join(' and ')} both set ${key}. Remove all but one.` };
    if (!label) return { value: limits[field] };
    const text = label.name.slice(prefix.length);
    const value = /^\d+(\.\d+)?$/.test(text) ? Number(text) : 0;
    const max = limits.max?.[field] ?? limits[field];
    if (value <= 0) return { why: `${label.name} is not a number above 0.` };
    if (value > max)
      return {
        why: `${label.name} is over the max ${key} of ${max}. Use ${max} or less, or raise limits.max in settings.yaml and reply /agent.`,
      };
    return { value, label };
  };
  const usdPerRun = read('usd-per-run');
  if ('why' in usdPerRun) return usdPerRun;
  const minutes = read('minutes');
  return 'why' in minutes ? minutes : { usdPerRun, minutes };
};

export const makeRunGraph = (graph: Graph, run: Pick<Run, 'limits'>): Graph =>
  run.limits
    ? {
        ...graph,
        limits: { ...graph.limits, usdPerRun: run.limits.usdPerRun.value, minutes: run.limits.minutes.value },
      }
    : graph;

export const formatLimitRaise = (limits: Limits, run: RunLimits, key: keyof typeof limitLabels) => {
  const field = limitLabels[key];
  const { value, label } = run[field];
  const max = limits.max?.[field] ?? limits[field];
  const from = label ? `from ${label.name}` : 'from settings.yaml';
  if (value >= max)
    return `${from}, the max. Raise limits.max ${key} in settings.yaml, then add a higher ${labelPrefix}${key} label to continue.`;
  const next = `${labelPrefix}${key}:${Math.min(max, Math.ceil(value * 1.5))}`;
  return `${from}. ${label ? `Replace ${label.name} with ${next}` : `Add ${next}`}, up to the max of ${max}, to continue.`;
};
