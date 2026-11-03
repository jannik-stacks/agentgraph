import { getSha } from './hash.ts';
import { readOrUndefined } from './read.ts';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Config, Data, Effect, Either, ParseResult, Schema } from 'effect';
import { parse } from 'yaml';
import { issueStatuses, type IssueStatus } from './event.ts';
import { Kind } from './proposal.ts';
import { readPlugins } from './plugin.ts';
import { formatRetiredAdvice, retiredWords } from './retired.ts';
import { CheckMode, defaultPass, defaultReturns, ResultType, whyPassUndecided } from './result.ts';
import { exact, compileWorkflow, splitFrontmatter, type Doc, type Problem, type Workflow } from './workflow.ts';

/** An agent file's frontmatter. */
export const Agent = Schema.Struct({
  harness: Schema.optionalWith(Schema.String, { default: () => '' }),
  model: Schema.optionalWith(Schema.String, { exact: true }),
  tools: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { default: () => [] }),
  returns: Schema.optionalWith(Schema.mutable(Schema.Array(Kind)), { default: () => ['comment'] }),
  reads: Schema.optionalWith(Schema.Literal('traces'), { exact: true }),
});
export type Agent = typeof Agent.Type;

/** The limits block of settings.yaml. */
const Limits = Schema.Struct({
  minutes: Schema.optionalWith(Schema.Number, { default: () => 30 }),
  usdPerRun: Schema.optionalWith(Schema.Number, { default: () => 10 }).pipe(Schema.fromKey('usd-per-run')),
  parallel: Schema.optionalWith(Schema.Int, { default: () => 2 }),
  sessions: Schema.optionalWith(Schema.Int, { default: () => 4 }),
});
type Limits = typeof Limits.Type;

/** One repo's graph after `uses:` and the repo override are merged. */
export type Graph = {
  dir: string;
  repo: string;
  plugins?: Record<string, unknown>;
  tools?: string[];
  sha: string;
  agents: Record<string, Doc<Agent>>;
  skills: Record<string, Doc<SkillFile>>;
  checks: Record<string, Doc<Check> & { version: string }>;
  workflows: Record<string, Workflow>;
  limits: Limits;
  /** A shell script each checkout runs once, with network, before the first step. */
  setup?: string;
  /** A shell script the toolchain step runs after the installs it detects, on the base commit's files, with network. */
  toolchain?: string;
  /** The local image every command of a run starts in, instead of the default sandbox image. */
  image?: string;
  /** What the network of sessions and setup reaches: the egress allowlist and the model proxy, or the model proxy only. */
  network?: 'egress' | 'models';
  /** Whether an issue that says "Stacks on #n" opens its pull request on the branch of #n. */
  stacks?: boolean;
  /** The milestone whose issues new runs start on; every open issue when unset. */
  milestone?: string;
  /** The logins whose text reaches agents and whose marks start runs; the repo's collaborators when unset. */
  trust?: string[];
  status?: false | Partial<Record<IssueStatus, string>>;
};

export class GraphError extends Data.TaggedError('GraphError')<{ problems: Problem[] }> {
  override get message() {
    return this.problems.map(p => `${p.path}: ${p.message}`).join('\n');
  }
}

const SettingsFile = Schema.Struct({
  plugins: exact(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  repo: exact(Schema.String),
  setup: exact(Schema.String),
  toolchain: exact(Schema.String),
  image: exact(Schema.String.pipe(Schema.pattern(/^[a-z0-9][\w./:@-]*$/))),
  network: exact(Schema.Literal('egress', 'models')),
  stacks: exact(Schema.Boolean),
  milestone: exact(Schema.String),
  trust: exact(Schema.mutable(Schema.Array(Schema.String))),
  status: exact(
    Schema.Union(
      Schema.Literal(false),
      Schema.partialWith(Schema.Record({ key: Schema.Literal(...issueStatuses), value: Schema.String }), {
        exact: true,
      })
    )
  ),
  limits: Schema.optionalWith(Limits, { default: () => Schema.decodeSync(Limits)({}) }),
});

export const parseGraphSettings = (text: string | undefined, say: (message: string) => void) => {
  let data: unknown = {};
  try {
    data = (text && parse(text)) ?? {};
  } catch (e) {
    say(`yaml: ${(e as Error).message}`);
  }
  return decode(SettingsFile, data, say);
};

/**
 * A check is items, a command and an agent that judges. Each gives a result `returns` describes, which passes when it
 * matches `pass`. `info` only records it, `warn` records a failure, `block` fails the try and `stop` the run.
 */
export const Check = Schema.Struct({
  mode: CheckMode,
  returns: exact(ResultType),
  pass: exact(ResultType),
  reads: exact(Schema.Literal('traces')),
  each: exact(Schema.String),
  run: exact(Schema.String),
  agent: exact(Schema.String),
  max: exact(Schema.Int.pipe(Schema.positive())),
});
export type Check = typeof Check.Type;

/** A skill file's frontmatter; `uses` names the skills whose bodies follow its own in the prompt. */
const SkillFile = Schema.Struct({
  description: exact(Schema.String),
  uses: exact(Schema.mutable(Schema.Array(Schema.String))),
});
type SkillFile = typeof SkillFile.Type;

/** The folders a graph holds besides those a graph file reads through `$AGENTGRAPH_DIR`: the four it loads, scripts and fixtures. */
const folders = new Set(['agents', 'skills', 'checks', 'workflows', 'scripts', 'fixtures', 'plugins', 'node_modules']);

/** Whether a graph file reads the graph folder `name` through `$AGENTGRAPH_DIR`. */
const reads = (texts: string[], name: string) =>
  texts.some(text => new RegExp(`AGENTGRAPH_DIR[^\\n]*['"\`/]${name.replace(/\W/g, '\\$&')}['"\`/]`).test(text));

/** Reports each `"kind"` value a body names that the engine does not know. */
const unknownKinds = (body: string, say: (message: string) => void) => {
  const seen = new Set<string>();
  for (const [, name] of body.matchAll(/"kind":\s*"([\w-]+)"/g)) {
    if (seen.has(name!) || Schema.is(Kind)(name)) continue;
    seen.add(name!);
    say(`names the proposal kind ${name}, which the engine does not have`);
  }
};

/**
 * Reports each retired word a graph or notes file still uses.
 * @internal
 */
export const retiredIn = (text: string, say: (message: string) => void) => {
  for (const retired of retiredWords) {
    const found = retired.text?.exec(text);
    if (found) say(`says ${JSON.stringify(found[0].trim())}, which is retired; ${formatRetiredAdvice(retired)}`);
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const decode = <A, I>(schema: Schema.Schema<A, I>, data: unknown, say: (message: string) => void): A | undefined => {
  const decoded = Schema.decodeUnknownEither(schema, { onExcessProperty: 'error', errors: 'all' })(data);
  if (Either.isRight(decoded)) return decoded.right;
  const seen = new Set<string>();
  for (const issue of ParseResult.ArrayFormatter.formatErrorSync(decoded.left)) {
    const key = issue.path.join('.') || 'frontmatter';
    if (!seen.has(key)) say(`${key}: ${issue.message}`);
    seen.add(key);
  }
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

/** Validates the files of one graph and builds it; every problem is collected before anything fails. */
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
    for (const step of w.steps) if ('agent' in step.does && step.does.skill) used.add(step.does.skill);
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
            readPlugins(dir, settings.plugins, name =>
              harnesses.some(
                harness =>
                  typeof harness.classify === 'function' && ['read', 'write'].includes(harness.classify(name) ?? '')
              )
            ),
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
    const remote =
      registry &&
      Object.values(parts.agents).some(agent => agent.tools.some(name => Object.hasOwn(registry.tools, name)))
        ? yield* Effect.orDie(Config.string('AGENTGRAPH_SANDBOX_URL').pipe(Config.withDefault('')))
        : '';
    for (const agent of Object.values(parts.agents)) {
      const harness = harnesses.find(harness => harness.name === agent.harness);
      if (!harness) continue;
      const builtins = agent.tools.filter(name => !registry || !Object.hasOwn(registry.tools, name));
      const checked: Agent['tools'] = [];
      for (const name of builtins) {
        const kind = typeof harness.classify === 'function' ? harness.classify(name) : undefined;
        if (kind === 'read' || kind === 'write') checked.push(name);
        else if (registry) problems.push({ path: agent.path, message: `tools: unknown tool ${name}` });
      }
      for (const message of harness.check?.({ ...agent, tools: checked }) ?? [])
        problems.push({ path: agent.path, message: `harness: ${harness.name} ${message}` });
      if (remote && builtins.length !== agent.tools.length)
        problems.push({ path: agent.path, message: 'tools: remote sandboxes do not support host tools' });
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
      repo: settings.repo ?? '',
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
      ...(settings.trust !== undefined && { trust: settings.trust }),
      ...(settings.status !== undefined && { status: settings.status }),
      ...parts,
      checks,
    };
  });
