import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { Data, Effect, Either, ParseResult, Schema } from 'effect';
import { parse } from 'yaml';
import { Kind } from './proposal.ts';
import { exact, compileWorkflow, splitFrontmatter, type Doc, type Problem, type Workflow } from './workflow.ts';

/** An agent file's frontmatter. */
export const Agent = Schema.Struct({
  harness: Schema.String,
  model: Schema.optionalWith(Schema.String, { exact: true }),
  tools: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { default: () => [] }),
  returns: Schema.optionalWith(Schema.mutable(Schema.Array(Kind)), { default: () => ['comment'] }),
  reads: Schema.optionalWith(Schema.Literal('traces'), { exact: true }),
});
export type Agent = typeof Agent.Type;

/** The hub-wide limits block. */
const Limits = Schema.Struct({
  minutes: Schema.optionalWith(Schema.Number, { default: () => 30 }),
  usdPerRun: Schema.optionalWith(Schema.Number, { default: () => 10 }).pipe(Schema.fromKey('usd-per-run')),
  parallel: Schema.optionalWith(Schema.Int, { default: () => 2 }),
  sessions: Schema.optionalWith(Schema.Int, { default: () => 4 }),
});
type Limits = typeof Limits.Type;

/** One repo's hub after `uses:` and the repo override are merged. */
export type Hub = {
  dir: string;
  repo: string;
  sha: string;
  agents: Record<string, Doc<Agent>>;
  skills: Record<string, Doc<SkillFile>>;
  checks: Record<string, Doc<Check>>;
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
};

export class HubError extends Data.TaggedError('HubError')<{ problems: Problem[] }> {
  override get message() {
    return this.problems.map(p => `${p.path}: ${p.message}`).join('\n');
  }
}

const HubFile = Schema.Struct({
  repo: exact(Schema.String),
  setup: exact(Schema.String),
  toolchain: exact(Schema.String),
  image: exact(Schema.String.pipe(Schema.pattern(/^[a-z0-9][\w./:@-]*$/))),
  network: exact(Schema.Literal('egress', 'models')),
  stacks: exact(Schema.Boolean),
  milestone: exact(Schema.String),
  trust: exact(Schema.mutable(Schema.Array(Schema.String))),
  limits: Schema.optionalWith(Limits, { default: () => Schema.decodeSync(Limits)({}) }),
});

/** A check is items, a command and an agent that judges. `stop` ends the run when it fails. */
export const Check = Schema.Struct({
  mode: Schema.Literal('warn', 'block', 'stop'),
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

/** The folders a hub holds besides those a hub file reads through `$AGENTGRAPH_HUB`: the four it loads, scripts and fixtures. */
const folders = new Set(['agents', 'skills', 'checks', 'workflows', 'scripts', 'fixtures']);

/** Whether a hub file reads the hub folder `name` through `$AGENTGRAPH_HUB`. */
const reads = (texts: string[], name: string) =>
  texts.some(text => new RegExp(`AGENTGRAPH_HUB[^\\n]*['"\`/]${name.replace(/\W/g, '\\$&')}['"\`/]`).test(text));

/** Reports each `"kind"` value a body names that the engine does not know. */
const unknownKinds = (body: string, say: (message: string) => void) => {
  const seen = new Set<string>();
  for (const [, name] of body.matchAll(/"kind":\s*"([\w-]+)"/g)) {
    if (seen.has(name!) || Schema.is(Kind)(name)) continue;
    seen.add(name!);
    say(`names the proposal kind ${name}, which the engine does not have`);
  }
};

/** Words and phrases that described agentgraph once and no longer do, each with what to say now. */
const retiredWords: [RegExp, string][] = [
  [/(?<![\w./-])\/agentgraph\b(?![/-])/i, '/agent followed by what you want'],
  [/\bmerge requests?\b/i, 'pull request'],
  [/\bopen-pr\b/, 'pull_request'],
  [/\b(?:souls?|personas?|executors?)\b/i, 'agent, or harness for the program that runs a session'],
  [/\bbots\//, 'agents/'],
  [/^\s*can:|\bfor-each\b|\bover:/m, 'returns: and each:'],
  [/\bruns-per-day\b|\bmax-turns\b/, 'limits in hub.yaml'],
  [/## Resuming|main-worktree|\/hub\/scripts|criteria table|adds the Closes/, 'nothing; the engine no longer has it'],
];

/**
 * Reports each retired word a hub or notes file still uses.
 * @internal
 */
export const retiredIn = (text: string, say: (message: string) => void) => {
  for (const [word, now] of retiredWords) {
    const found = word.exec(text);
    if (found) say(`says ${JSON.stringify(found[0].trim())}, which is retired; say ${now}`);
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
  const entries = await readdir(join(dir, sub), { withFileTypes: true }).catch(() => []);
  const paths = entries
    .map(e => (e.isDirectory() ? `${sub}/${e.name}/SKILL.md` : e.name.endsWith('.md') ? `${sub}/${e.name}` : ''))
    .filter(path => path && (sub === 'skills' || !path.endsWith('/SKILL.md')))
    .sort();
  const files = await Promise.all(
    paths.map(path =>
      readFile(join(dir, path), 'utf8').then(
        text => ({ path, text }),
        () => undefined
      )
    )
  );
  return files.filter(f => f !== undefined);
};

const nameOf = (path: string) => (path.endsWith('/SKILL.md') ? basename(path.slice(0, -9)) : basename(path, '.md'));

/** Validates the files of one hub and builds it; every problem is collected before anything fails. */
const compile = (
  hubText: string | undefined,
  groups: Record<'agents' | 'skills' | 'checks' | 'workflows', File[]>,
  harnesses: readonly HarnessCheck[]
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

  const say = sayer('hub.yaml');
  let hubData: unknown = {};
  try {
    hubData = (hubText && parse(hubText)) ?? {};
  } catch (e) {
    say(`yaml: ${(e as Error).message}`);
  }
  const hub = decode(HubFile, hubData, say);

  const docs = <T>(files: File[], read: (data: unknown, say: (m: string) => void) => T | undefined) => {
    const out: Record<string, Doc<T>> = {};
    for (const file of files) {
      const parsed = front(file);
      const value = parsed && read(parsed.data, sayer(file.path));
      const name = nameOf(file.path);
      if (name in out) sayer(file.path)(`${name} is defined twice`);
      if (value !== undefined) out[name] = { ...value, name, path: file.path, body: parsed!.body };
    }
    return out;
  };

  const agents = docs(groups.agents, (data, say) => {
    const agent = decode(Agent, data, say);
    if (agent?.reads && !agent.tools.includes('read')) say('reads: traces needs read in tools');
    const harness = agent && harnesses.find(h => h.name === agent.harness);
    if (agent && !harness)
      say(`harness: ${agent.harness} is not in the config, which has ${harnesses.map(h => h.name).join(', ')}`);
    if (agent && harness)
      for (const problem of harness.check?.(agent) ?? []) say(`harness: ${harness.name} ${problem}`);
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
    const usedChecks = new Set(steps.flatMap(step => step.checks));
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
        sayer(check.path)(`no step names ${check.name} in its checks; name it in a step or remove it`);
    for (const agent of Object.values(agents))
      if (!usedAgents.has(agent.name))
        sayer(agent.path)(`no step or check names ${agent.name} as its agent; name it in a step or remove it`);
  }
  return { hub, agents, skills, checks, workflows, problems };
};

export type HarnessCheck = { name: string; check?: (agent: Agent) => string[] };

/** Reads a hub directory, validates every file and fails with all problems at once. */
export const loadHub = (dir: string, harnesses: readonly HarnessCheck[]): Effect.Effect<Hub, HubError> =>
  Effect.gen(function* () {
    const read = yield* Effect.tryPromise({
      try: async () => {
        const hubText = await readFile(join(dir, 'hub.yaml'), 'utf8').catch(() => undefined);
        const [agents, skills, checks, workflows] = await Promise.all(
          (['agents', 'skills', 'checks', 'workflows'] as const).map(sub => markdown(dir, sub))
        );
        const groups = { agents: agents!, skills: skills!, checks: checks!, workflows: workflows! };
        const scripts = await Promise.all(
          (await readdir(join(dir, 'scripts'), { recursive: true, withFileTypes: true }).catch(() => []))
            .filter(e => e.isFile())
            .map(e => join(e.parentPath, e.name))
            .sort()
            .map(async p => ({ path: relative(dir, p), text: await readFile(p, 'utf8') }))
        );
        const texts = [hubText ?? '', ...scripts.map(f => f.text)];
        texts.push(...Object.values(groups).flatMap(files => files.map(f => f.text)));
        const unread = (await readdir(dir, { withFileTypes: true }).catch(() => []))
          .filter(e => e.isDirectory() && !e.name.startsWith('.') && !folders.has(e.name))
          .map(e => e.name)
          .filter(name => !reads(texts, name));
        return { hubText, groups, scripts, unread };
      },
      catch: e => new HubError({ problems: [{ path: dir, message: `unreadable: ${String(e)}` }] }),
    });
    const { hub, problems, ...parts } = compile(read.hubText, read.groups, harnesses);
    for (const name of read.unread)
      problems.push({
        path: name,
        message: `nothing reads ${name}/; the engine loads agents, skills, checks and workflows, and a hub script reads a folder through $AGENTGRAPH_HUB`,
      });
    if (problems.length > 0 || !hub) return yield* new HubError({ problems });
    const sha = createHash('sha256');
    for (const file of [
      { path: 'hub.yaml', text: read.hubText ?? '' },
      ...Object.values(read.groups).flat(),
      ...read.scripts,
    ]) {
      sha.update(`${file.path}\0${file.text}\0`);
    }
    return {
      dir: resolve(dir),
      repo: hub.repo ?? '',
      sha: sha.digest('hex'),
      limits: hub.limits,
      ...(hub.setup !== undefined && { setup: hub.setup }),
      ...(hub.toolchain !== undefined && { toolchain: hub.toolchain }),
      ...(hub.image !== undefined && { image: hub.image }),
      ...(hub.network !== undefined && { network: hub.network }),
      ...(hub.stacks !== undefined && { stacks: hub.stacks }),
      ...(hub.milestone !== undefined && { milestone: hub.milestone }),
      ...(hub.trust !== undefined && { trust: hub.trust }),
      ...parts,
    };
  });
