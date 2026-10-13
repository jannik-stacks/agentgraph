import { z } from 'zod';

/**
 * `human`: notes for humans on any hub item, as plain text or a map of strings. Never shown to a model and never
 * changing the flow.
 */
export const Human = z.union([z.string(), z.record(z.string(), z.string())]);
export type Human = z.infer<typeof Human>;

const human = Human.optional();

export const Granularity = z.enum(['item', 'turn', 'run']);
export type Granularity = z.infer<typeof Granularity>;

const Settings = z.strictObject({
  mode: z.enum(['off', 'extractive', 'model']).default('extractive'),
  model: z.string().min(1).optional(),
  granularity: z.union([Granularity, z.array(Granularity).min(1)]).default('item'),
  'max-bytes': z.number().int().min(64).max(4096).default(512),
  prompt: z.string().min(1).optional(),
});

/**
 * How past run events become one-line summaries: `off`, `extractive` (no model, the default), or a model alias given
 * directly or as `{ mode: model, model }`.
 */
export const Summarizer = z.preprocess(
  value =>
    value === 'off' || value === 'extractive'
      ? { mode: value }
      : typeof value === 'string'
        ? { mode: 'model', model: value }
        : value,
  Settings.refine(s => s.mode !== 'model' || s.model, 'mode model needs a model')
);
export type Summarizer = z.output<typeof Settings>;

/** Who may see a run's transcript again: no bot, the bot that ran it, or any bot in the hub. */
export const Share = z.enum(['none', 'bot', 'hub']);
export type Share = z.infer<typeof Share>;

export const githubTriggers = [
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'schedule',
  'workflow_dispatch',
] as const;

export const agentTriggers = ['session_start', 'prompt', 'tool_call', 'tool_result', 'stop'] as const;

export const Trigger = z.enum([...githubTriggers, ...agentTriggers]);
export type Trigger = z.infer<typeof Trigger>;

export const Association = z.enum(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE']);
export type Association = z.infer<typeof Association>;

export const Mode = z.enum(['shadow', 'warn', 'block']);
export type Mode = z.infer<typeof Mode>;

export const ProposalKind = z.enum(['reply', 'label', 'push', 'merge-request', 'merge', 'note', 'hub', 'ask']);
export type ProposalKind = z.infer<typeof ProposalKind>;

/** Hub files that change only by a human: no `hub(...)` return reaches them. */
export const humanOnly = ['hub.yaml', 'bots/**', 'workflows/**'] as const;

const hubReturn = /^hub\((.+)\)$/;

/** The globs of a `hub(<globs>)` return, or nothing for any other kind. */
export const hubGlobs = (entry: string) =>
  hubReturn
    .exec(entry)?.[1]
    ?.split(',')
    .map(glob => glob.trim())
    .filter(Boolean);

/** An entry of `returns`: a proposal kind, or `hub(<globs>)` for changes to hub files matching the globs. */
export const Return = z.union(
  [
    ProposalKind.exclude(['hub']),
    z
      .string()
      .regex(hubReturn)
      .transform(entry => `hub(${hubGlobs(entry)!.join(', ')})`),
  ],
  {
    error: issue =>
      issue.input === 'open-pr'
        ? 'there is no "open-pr"; a request to merge a branch is "merge-request"'
        : `must be one of ${ProposalKind.exclude(['hub']).options.join(', ')}, or hub(<globs>)`,
  }
);
export type Return = z.output<typeof Return>;

/** Rejoins a `hub(a, b)` entry that a YAML flow list split at its commas. */
const rejoin = (value: unknown) => {
  if (!Array.isArray(value)) return value;
  const out: unknown[] = [];
  for (const item of value) {
    const last = out.at(-1);
    if (typeof last === 'string' && typeof item === 'string' && last.includes('(') && !last.includes(')'))
      out[out.length - 1] = `${last}, ${item}`;
    else out.push(item);
  }
  return out;
};

/** What a bot or job may return: the proposals it ends with. */
export const Returns = z.preprocess(rejoin, z.array(Return));

export const NoteKind = z.enum(['decision', 'style', 'caveat']);
export type NoteKind = z.infer<typeof NoteKind>;

/**
 * Context rendered into a run before it starts: the triggering issue, its linked issues, and `recall`, which surfaces
 * accepted notes and past-run summaries by relevance while the bot works.
 */
export const Preload = z.union([
  z.enum(['issue', 'links', 'recall']),
  z.strictObject({
    recall: z.strictObject({
      cutoff: z.number().min(0).max(1).optional(),
      budget: z.int().positive().optional(),
    }),
  }),
]);
export type Preload = z.infer<typeof Preload>;

/** Read-only tools a bot may be given: the bothub MCP server's, and `history` over earlier runs. */
export const HubTool = z.enum(['issues_list', 'issues_get', 'notes_search', 'notes_get', 'runs_read', 'history']);
export type HubTool = z.infer<typeof HubTool>;

export const IssuesBackend = z.enum(['github', 'local']);
export type IssuesBackend = z.infer<typeof IssuesBackend>;

export const Harness = z.enum(['opencode', 'pi']);
export type Harness = z.infer<typeof Harness>;

/**
 * What happened to a job's work: `done`, `handed-off` to the jobs that need it, `blocked` on a human, `deferred` until
 * something outside the run changes, or `no-op` when it changed nothing. Only `done` and `handed-off` let dependent
 * jobs start.
 */
export const Closure = z.enum(['done', 'handed-off', 'blocked', 'deferred', 'no-op']);
export type Closure = z.infer<typeof Closure>;

const list = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item)]).transform(v => (Array.isArray(v) ? v : [v]));

const name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be lowercase kebab-case');

export const TriggerFilter = z
  .strictObject({
    types: z.array(z.string()).optional(),
    command: z.string().startsWith('/').optional(),
    tools: z.array(z.string()).optional(),
    branches: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    cron: z.string().optional(),
    guard: z
      .strictObject({ associations: z.array(Association).default(['OWNER', 'MEMBER', 'COLLABORATOR']) })
      .optional(),
  })
  .nullable()
  .transform(v => v ?? {});

export const On = z.partialRecord(Trigger, TriggerFilter);

/**
 * `bots/<name>.md`: who acts. The body is the bot's role. `tools` lists harness tools plus any hub tools (see
 * `HubTool`) the bot may call during a run; `returns` is the most it may return, which a job can only narrow.
 * `session.share` says whose runs `history` and recall may show again; `session.resume: attempts` carries an
 * attempt's summary into the next one of the same `until` loop.
 */
export const Bot = z.strictObject({
  harness: Harness,
  model: z.string().optional(),
  tools: z.array(z.string()),
  returns: Returns,
  skills: z.array(name).optional(),
  preload: z.array(Preload).optional(),
  session: z
    .strictObject({ resume: z.enum(['none', 'attempts']).default('none'), share: Share.default('bot') })
    .optional(),
  summarizer: Summarizer.optional(),
  'max-turns': z.int().positive().optional(),
  budget: z
    .strictObject({
      'runs-per-day': z.int().positive().optional(),
      minutes: z.number().positive().optional(),
      'usd-per-run': z.number().positive().optional(),
    })
    .optional(),
  human,
});
export type Bot = z.infer<typeof Bot>;

/** `skills/<name>.md`: what to do. The body is the prompt. */
export const Skill = z.strictObject({ description: z.string().min(1), human });
export type Skill = z.infer<typeof Skill>;

const script = z.string().min(1);

/**
 * What a check or job looks at: once over the whole `diff`, the lines it `added`, the triggering `event`'s text or
 * the output of a `run` script; or once per changed file (`each-file`), per diff hunk (`each-hunk`) or per line an
 * `each` script prints, at most `max` of them. `{ each-hunk: { max, context } }` sets how many hunks it takes and
 * how much surrounding code each one shows: a number of lines, or `function` for the whole enclosing function.
 */
export const Over = z.union([
  z.enum(['diff', 'added', 'event', 'each-file', 'each-hunk']),
  z.strictObject({ run: script }),
  z.strictObject({ each: script, max: z.int().positive().default(50) }),
  z.strictObject({
    'each-hunk': z.strictObject({
      max: z.int().positive().default(30),
      context: z.union([z.literal('function'), z.int().min(0).max(200)]).optional(),
    }),
  }),
]);
export type Over = z.infer<typeof Over>;

/** A missing or unknown `type`, with a guess from the first field in `hints` the value has. */
const typeError = (types: string[], hints: [field: string, type: string][]) => ({
  error: (issue: { code?: string; input?: unknown }) => {
    if (issue.code !== 'invalid_union') return;
    const input = (typeof issue.input === 'object' && issue.input) || {};
    const type = 'type' in input ? input.type : undefined;
    const guess = hints.find(([field]) => field in input);
    const hint = guess ? `; it has "${guess[0]}", so probably "type: ${guess[1]}"` : '';
    const one = types.join(', ');
    return type === undefined
      ? `missing "type": use one of ${one}${hint}`
      : `type "${String(type)}" is not one of ${one}${hint}`;
  },
});

/** One `type` of a check or job, naming the fields it does not take. */
const variant = <S extends z.ZodRawShape>(what: string, shape: S) =>
  z.strictObject(shape, {
    error: issue => {
      if (issue.code !== 'unrecognized_keys') return;
      const keys = issue.keys.map(key => `"${key}"`).join(', ');
      const hint = issue.keys.includes('run') ? '; to judge what a command prints, use "over: { run: <command> }"' : '';
      return `${what} does not take ${keys}${hint}`;
    },
  });

/** What checks and jobs share: what they look at, which files they cover and whether they gate. */
const step = (over: 'diff' | 'event') => ({
  over: Over.default(over),
  paths: z.array(z.string()).optional(),
  mode: Mode.default('shadow'),
});

const checkFields = {
  ...step('diff'),
  description: z.string().optional(),
  concurrency: z.int().positive().optional(),
  human,
};

/**
 * `checks/<name>.md`: what a check looks at (`over`) and who judges it. A `script` passes when it exits 0; a `bot`
 * replies PASS or FAIL to the body, added after the skill when there is one; `decide` asks the local decision model
 * the body as a yes-or-no question and passes on yes. A check whose `paths` match no changed file does not apply.
 * `concurrency` is how many of its items are judged at once.
 */
export const Check = z.discriminatedUnion(
  'type',
  [
    variant('a script check', { type: z.literal('script'), run: script, ...checkFields }),
    variant('a bot check', { type: z.literal('bot'), bot: name, skill: name.optional(), ...checkFields }),
    variant('a decide check', {
      type: z.literal('decide'),
      threshold: z.number().min(0).max(1).optional(),
      ...checkFields,
    }),
  ],
  typeError(
    ['script', 'bot', 'decide'],
    [
      ['run', 'script'],
      ['bot', 'bot'],
      ['decide', 'decide'],
    ]
  )
);
export type Check = z.infer<typeof Check>;

const jobStart = { on: On.optional(), needs: list(z.string()).default([]) };
const jobWrites = {
  branch: z.string().optional(),
  into: z.string().optional(),
  requires: z.array(name).optional(),
  returns: Returns.optional(),
};
const jobEnd = {
  ...step('event'),
  environment: z.string().optional(),
  'timeout-minutes': z.number().positive().optional(),
  human,
};

/**
 * A workflow step: a `bot` running a skill, or a `script`. A job that fans out with `over` runs once per item.
 * `branch` is the branch it works on, `into` where its merge requests and merges go (the default branch when unset),
 * and `requires` the checks a merge must pass on the merged tree before it lands. A script returns proposals by
 * ending its output with a `bothub` block, like a bot.
 */
export const Job = z.discriminatedUnion(
  'type',
  [
    variant('a bot job', {
      type: z.literal('bot'),
      ...jobStart,
      bot: name,
      skill: name,
      ...jobWrites,
      until: z.strictObject({ checks: z.array(name).min(1), max: z.int().positive().default(2) }).optional(),
      preload: z.array(Preload).optional(),
      tools: z.array(HubTool).optional(),
      ...jobEnd,
    }),
    variant('a script job', { type: z.literal('script'), ...jobStart, run: script, ...jobWrites, ...jobEnd }),
  ],
  typeError(
    ['bot', 'script'],
    [
      ['run', 'script'],
      ['bot', 'bot'],
    ]
  )
);
export type Job = z.infer<typeof Job>;

/** `workflows/<name>.md`: triggers to jobs. The body is an optional human description. */
export const Workflow = z.strictObject({
  name: name.optional(),
  description: z.string().optional(),
  on: On,
  jobs: z.record(name, Job),
  human,
});
export type Workflow = z.infer<typeof Workflow>;

/** `notes/<kind>/<slug>.md`: what the hub knows, surfaced to runs when relevant. The body is the note. */
export const Note = z.strictObject({
  title: z.string().min(1),
  status: z.enum(['proposed', 'accepted', 'superseded', 'retired']).optional(),
  source: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  check: name.optional(),
  human,
});
export type Note = z.infer<typeof Note>;

/**
 * `issues/<n>-<slug>.md` in a hub with local issues. The body is the issue, followed by its comments. `changes` records
 * who labeled or closed it through bothub; a hand edit leaves no record.
 */
export const IssueFile = z.strictObject({
  title: z.string().min(1),
  state: z.enum(['open', 'closed']).default('open'),
  labels: z.array(z.string()).default([]),
  author: z.string().exactOptional(),
  parent: z.int().positive().exactOptional(),
  links: z.array(z.int().positive()).exactOptional(),
  changes: z
    .array(z.strictObject({ by: z.string(), action: z.enum(['labeled', 'closed']), label: z.string().exactOptional() }))
    .exactOptional(),
  human: Human.exactOptional(),
});
export type IssueFile = z.infer<typeof IssueFile>;

const inRepo = z
  .string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\n]+$/, 'must be a path inside the repository, without . or ..');

/**
 * `hub.yaml`: hub-wide settings. `issues` picks where issues, plans, specs and open questions live;
 * `merge.default-branch` says who merges into the default branch: only a `human`, or `bots` too. `deps` installs the
 * repository's dependencies once per content of its `lockfiles`, in the sandbox, and links the `dirs` it leaves into
 * every run's worktree, read-only.
 */
export const Hub = z.strictObject({
  issues: IssuesBackend.default('github'),
  merge: z
    .strictObject({ 'default-branch': z.enum(['human', 'bots']).default('human') })
    .default({ 'default-branch': 'human' }),
  deps: z
    .strictObject({
      install: z.string().min(1),
      lockfiles: z.array(inRepo).min(1),
      dirs: z.array(inRepo).min(1),
      'timeout-minutes': z.int().positive().default(15),
    })
    .optional(),
  human,
});
export type Hub = z.infer<typeof Hub>;
