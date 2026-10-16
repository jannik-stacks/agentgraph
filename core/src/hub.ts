import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Data, Effect, Either, ParseResult, Schema } from 'effect';
import { parse } from 'yaml';
import type { Check } from './check.ts';
import type { Proposal } from './forge.ts';
import { load, split, type Doc, type Problem, type Workflow } from './workflow.ts';

export type Harness = 'claude' | 'opencode' | 'pi';

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

/** A bot file's frontmatter. */
export const Bot = Schema.Struct({
  harness: Schema.Literal('claude', 'opencode', 'pi'),
  model: Schema.optionalWith(Schema.String, { exact: true }),
  tools: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.String)), { default: () => [] }),
  returns: Schema.optionalWith(Schema.mutable(Schema.Array(Schema.Literal(...kinds))), { default: () => ['comment'] }),
});
export type Bot = typeof Bot.Type;

/** The hub-wide limits block. */
export const Limits = Schema.Struct({
  minutes: Schema.optionalWith(Schema.Number, { default: () => 30 }),
  usdPerRun: Schema.optionalWith(Schema.Number, { default: () => 10 }).pipe(Schema.fromKey('usd-per-run')),
  parallel: Schema.optionalWith(Schema.Int, { default: () => 2 }),
});
export type Limits = typeof Limits.Type;

/** One repo's hub after `uses:` and the repo override are merged. */
export type Hub = {
  repo: string;
  sha: string;
  bots: Record<string, Doc<Bot>>;
  skills: Record<string, Doc<{ description?: string }>>;
  checks: Record<string, Doc<Check>>;
  workflows: Record<string, Workflow>;
  limits: Limits;
  /** A shell script each checkout runs once, with network, before the first step. */
  setup?: string;
};

export class HubError extends Data.TaggedError('HubError')<{ problems: Problem[] }> {}

const exact = <S extends Schema.Schema.All>(schema: S) => Schema.optionalWith(schema, { exact: true });

const HubFile = Schema.Struct({
  repo: exact(Schema.String),
  setup: exact(Schema.String),
  limits: Schema.optionalWith(Limits, { default: () => Schema.decodeSync(Limits)({}) }),
});

const CheckFile = Schema.Struct({
  mode: Schema.Literal('warn', 'block', 'stop'),
  each: exact(Schema.String),
  run: exact(Schema.String),
  judge: exact(Schema.String),
  max: exact(Schema.Int.pipe(Schema.positive())),
});

const SkillFile = Schema.Struct({ description: exact(Schema.String) });

const rest = 'a step starts a fresh session and a retry resumes it';

/** Keys of the previous hub format, each with what replaces it. */
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
  bot: {
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
    type: 'run makes a script check and judge a bot check',
    bot: 'name the bot as judge',
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
    description: 'write it as the body',
    human: '',
  },
  trigger: {
    types: '',
    guard: 'only owners, members and collaborators reach bots',
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

/** The data without the old keys in `table`, each one reported. */
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
const compile = (hubText: string | undefined, groups: Record<'bots' | 'skills' | 'checks' | 'workflows', File[]>) => {
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

  const bots = docs(groups.bots, (data, say) => {
    const kept = strip(data, gone.bot, say);
    if (isRecord(kept) && Array.isArray(kept.returns)) {
      for (const kind of kept.returns) if (typeof kind === 'string' && kind in returns) say(returns[kind]!);
      kept.returns = kept.returns.filter(kind => !(kind in returns));
    }
    return decode(Bot, kept, say);
  });
  const skills = docs(groups.skills, (data, say) =>
    decode(
      SkillFile,
      isRecord(data) ? (data.description === undefined ? {} : { description: data.description }) : data,
      say
    )
  );
  const checks = docs(groups.checks, (data, say): Check | undefined => {
    const check = decode(CheckFile, strip(data, gone.check, say), say);
    if (!check) return;
    if (check.run === undefined && check.judge === undefined) say('name run, judge or both');
    if (check.judge !== undefined && !(check.judge in bots)) say(`judge: unknown bot ${check.judge}`);
    return check;
  });

  const names = { bots: Object.keys(bots), skills: Object.keys(skills), checks: Object.keys(checks) };
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
  return { hub, bots, skills, checks, workflows, problems };
};

/** Reads a hub directory, validates every file and fails with all problems at once. */
export const loadHub = (dir: string): Effect.Effect<Hub, HubError> =>
  Effect.gen(function* () {
    const read = yield* Effect.tryPromise({
      try: async () => {
        const hubText = await readFile(join(dir, 'hub.yaml'), 'utf8').catch(() => undefined);
        const [bots, skills, checks, workflows] = await Promise.all(
          (['bots', 'skills', 'checks', 'workflows'] as const).map(sub => markdown(dir, sub))
        );
        return { hubText, groups: { bots: bots!, skills: skills!, checks: checks!, workflows: workflows! } };
      },
      catch: e => new HubError({ problems: [{ path: dir, message: `unreadable: ${String(e)}` }] }),
    });
    const { hub, problems, ...parts } = compile(read.hubText, read.groups);
    if (problems.length > 0 || !hub) return yield* new HubError({ problems });
    const sha = createHash('sha256');
    for (const file of [{ path: 'hub.yaml', text: read.hubText ?? '' }, ...Object.values(read.groups).flat()]) {
      sha.update(`${file.path}\0${file.text}\0`);
    }
    return {
      repo: hub.repo ?? '',
      sha: sha.digest('hex'),
      limits: hub.limits,
      ...(hub.setup !== undefined && { setup: hub.setup }),
      ...parts,
    };
  });
