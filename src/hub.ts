import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Data, Effect, Either, ParseResult, Schema } from 'effect';
import { parse } from 'yaml';
import type { Proposal } from './forge.ts';
import { load, split, type Doc, type Problem, type Workflow } from './workflow.ts';

const kinds = [
  'comment',
  'label',
  'push',
  'pull_request',
  'merge',
  'issue',
  'ask',
  'back',
] as const satisfies readonly Proposal['kind'][];

/** An agent file's frontmatter. */
export const Agent = Schema.Struct({
  harness: Schema.Literal('claude', 'opencode', 'pi'),
  model: Schema.optionalWith(Schema.String, { exact: true }),
  tools: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { default: () => [] }),
  returns: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.Literal(...kinds))), { default: () => ['comment'] }),
});
export type Agent = typeof Agent.Type;

/** The hub-wide limits block. */
const Limits = Schema.Struct({
  minutes: Schema.optionalWith(Schema.Number, { default: () => 30 }),
  usdPerRun: Schema.optionalWith(Schema.Number, { default: () => 10 }).pipe(Schema.fromKey('usd-per-run')),
  parallel: Schema.optionalWith(Schema.Int, { default: () => 2 }),
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

const exact = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });

const HubFile = Schema.Struct({
  repo: exact(Schema.String),
  setup: exact(Schema.String),
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

const rest = 'a step starts a fresh session and a retry resumes it';

/** Removed keys, each with its replacement. */
const gone = {
  hub: {
    issues: 'the forge lists them',
    merge: 'a workflow step merges or waits for a human',
    'merge-request': 'the pull_request proposal carries the body',
    deps: 'name the install command as setup',
    sandbox: '',
    loads: '',
    context: rest,
    history: rest,
    'time-kinds': '',
    human: '',
  },
  agent: {
    session: rest,
    resume: rest,
    context: rest,
    history: rest,
    summarizer: rest,
    skills: 'a step names its skill',
    budget: 'set limits in hub.yaml',
    concurrency: 'set limits.parallel in hub.yaml',
    'max-turns': 'limits.minutes in hub.yaml ends a session that hangs',
    preload: '',
    loads: '',
    decider: '',
    human: '',
  },
  check: {
    type: 'name run for a script check and agent for a judged one',
    bot: 'name it as agent',
    judge: 'name it as agent',
    over: 'use each: files, hunks or a command that prints one item per line',
    paths: 'filter files in the each command',
    description: 'write it as the body',
    threshold: '',
    'timeout-minutes': '',
    human: '',
  },
  workflow: {
    jobs: 'rewrite it as steps: each job becomes a step in needs order, until.checks becomes checks, over: each-hunk becomes each: hunks',
    name: 'the file name is the workflow name',
    into: 'name the branch as base',
    bot: 'name it as agent',
    description: 'write it as the body',
    human: '',
  },
  trigger: {
    types: '',
    guard: 'only owners, members and collaborators reach agents',
    labels: '',
    tools: '',
    cron: '',
  },
} satisfies Record<string, Record<string, string>>;

const returns: Record<string, string> = {
  'merge-request': 'returns: merge-request is now pull_request',
  reply: 'returns: reply is now comment',
  pull: 'returns: pull is now pull_request',
  note: 'returns: note is gone; memory is docs in the repo, written by a push',
  hub: 'returns: hub is gone; remove it',
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reports and strips the removed keys in `table`. */
const strip = (data: unknown, table: Record<string, string>, say: (message: string) => void, prefix = '') => {
  if (!isRecord(data)) return data;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!(key in table)) kept[key] = value;
    else say(`${prefix}${key} is gone; ${table[key] || 'remove it'}`);
  }
  return kept;
};

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
const compile = (hubText: string | undefined, groups: Record<'agents' | 'skills' | 'checks' | 'workflows', File[]>) => {
  const problems: Problem[] = [];
  const sayer = (path: string) => (message: string) => problems.push({ path, message });
  const front = (file: File) => {
    try {
      return split(file.text);
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
  const hub = decode(HubFile, strip(hubData, gone.hub, say), say);

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
    const kept = strip(data, gone.agent, say);
    if (isRecord(kept) && Array.isArray(kept.returns)) {
      for (const kind of kept.returns) if (typeof kind === 'string' && kind in returns) say(returns[kind]!);
      kept.returns = kept.returns.filter(kind => !(kind in returns));
    }
    return decode(Agent, kept, say);
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
  for (const skill of Object.values(skills))
    for (const name of skill.uses ?? []) if (!(name in skills)) sayer(skill.path)(`uses: unknown skill ${name}`);
  const checks = docs(groups.checks, (data, say): Check | undefined => {
    const check = decode(Check, strip(data, gone.check, say), say);
    if (!check) return;
    if (check.run === undefined && check.agent === undefined) say('name run, agent or both');
    if (check.agent !== undefined && !(check.agent in agents)) say(`agent: unknown agent ${check.agent}`);
    return check;
  });

  const names = { agents: Object.keys(agents), skills: Object.keys(skills), checks: Object.keys(checks) };
  const workflows: Record<string, Workflow> = {};
  for (const file of groups.workflows) {
    const parsed = front(file);
    if (!parsed) continue;
    const say = sayer(file.path);
    const before = problems.length;
    const kept = strip(parsed.data, gone.workflow, say);
    if (isRecord(kept) && isRecord(kept.on)) {
      for (const [event, trigger] of Object.entries(kept.on)) strip(trigger, gone.trigger, say, `on.${event}.`);
    }
    if (problems.length > before) continue;
    const loaded = load(file.path, file.text, names);
    problems.push(...loaded.problems);
    if (loaded.workflow) workflows[loaded.workflow.name] = loaded.workflow;
  }
  return { hub, agents, skills, checks, workflows, problems };
};

/** Reads a hub directory, validates every file and fails with all problems at once. */
export const loadHub = (dir: string): Effect.Effect<Hub, HubError> =>
  Effect.gen(function* () {
    const read = yield* Effect.tryPromise({
      try: async () => {
        const hubText = await readFile(join(dir, 'hub.yaml'), 'utf8').catch(() => undefined);
        const [agents, skills, checks, workflows, bots] = await Promise.all(
          (['agents', 'skills', 'checks', 'workflows', 'bots'] as const).map(sub => markdown(dir, sub))
        );
        const groups = { agents: [...agents!, ...bots!], skills: skills!, checks: checks!, workflows: workflows! };
        return { hubText, groups, renamed: bots!.length > 0 };
      },
      catch: e => new HubError({ problems: [{ path: dir, message: `unreadable: ${String(e)}` }] }),
    });
    const { hub, problems, ...parts } = compile(read.hubText, read.groups);
    if (read.renamed) problems.push({ path: 'bots', message: 'bots/ is now agents/; rename the folder' });
    if (problems.length > 0 || !hub) return yield* new HubError({ problems });
    const sha = createHash('sha256');
    for (const file of [{ path: 'hub.yaml', text: read.hubText ?? '' }, ...Object.values(read.groups).flat()]) {
      sha.update(`${file.path}\0${file.text}\0`);
    }
    return {
      dir: resolve(dir),
      repo: hub.repo ?? '',
      sha: sha.digest('hex'),
      limits: hub.limits,
      ...(hub.setup !== undefined && { setup: hub.setup }),
      ...(hub.image !== undefined && { image: hub.image }),
      ...(hub.network !== undefined && { network: hub.network }),
      ...(hub.stacks !== undefined && { stacks: hub.stacks }),
      ...(hub.milestone !== undefined && { milestone: hub.milestone }),
      ...(hub.trust !== undefined && { trust: hub.trust }),
      ...parts,
    };
  });
