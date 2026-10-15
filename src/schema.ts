import { z } from 'zod';

/** What a span's time went to: the agent's own work, build and test commands, a human, a stall, or anything else. */
export const timeKinds = ['build', 'test', 'model', 'edit', 'read', 'wait', 'stall', 'other'] as const;

const regex = (source: string) => {
  try {
    return Boolean(new RegExp(source));
  } catch {
    return false;
  }
};

/**
 * `human`: notes for humans on any hub item, as plain text or a map of strings. Never shown to a model and never
 * changing the flow.
 */
export const Human = z.union([z.string(), z.record(z.string(), z.string())]);
export type Human = z.infer<typeof Human>;

const human = Human.optional();

const Settings = z.strictObject({
  mode: z.enum(['off', 'extractive', 'model']).default('extractive'),
  model: z.string().min(1).optional(),
  'max-bytes': z.number().int().min(64).max(4096).default(512),
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

/** What a new run or attempt starts with besides its task: nothing, a summary of the last run, or its harness session. */
export const Resume = z.enum(['none', 'summary', 'resume'], {
  error: issue => (issue.input === 'session' ? 'session is now named resume' : undefined),
});
export type Resume = z.infer<typeof Resume>;

/**
 * Whose earlier runs a bot's `history` and recall may read: none, the same step's runs for the same event, every run on
 * the same issue, the bot's own runs, or every run in the hub.
 */
export const History = z.enum(['none', 'run', 'issue', 'bot', 'hub']);
export type History = z.infer<typeof History>;

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

export const Mode = z.enum(['log', 'warn', 'block']);
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

/** What a bot or step may return: the proposals it ends with. */
export const Returns = z.preprocess(rejoin, z.array(Return));

export const NoteKind = z.enum(['decision', 'style', 'caveat']);
export type NoteKind = z.infer<typeof NoteKind>;

/**
 * Context rendered into a run before it starts: the triggering issue, its linked issues, and `recall`, which surfaces
 * the accepted notes and past-run summaries most relevant to the step's brief or issue before the first turn. A recall
 * `judge` model drops the search hits it scores under `cutoff`; `budget` caps the tokens the surfaced text adds.
 */
export const Preload = z.union([
  z.enum(['issue', 'links', 'recall']),
  z.strictObject({
    recall: z.strictObject({
      judge: z.string().min(1).optional(),
      cutoff: z.number().min(0).max(1).optional(),
      budget: z.int().positive().optional(),
    }),
  }),
]);
export type Preload = z.infer<typeof Preload>;

/**
 * A yes-or-no question the decider asks the decision model during an opencode run: before a tool call (`tool_call`),
 * after one (`tool_result`) or on the bot's final message (`stop`), for the listed `tools` only when given. Yes means
 * all is well. In `log` mode it only records the answer; in `act` mode an answer below `threshold` denies the tool
 * call, or adds `say` to the tool result or message.
 */
export const DeciderQuestion = z
  .strictObject({
    on: z.enum(agentTriggers).extract(['tool_call', 'tool_result', 'stop']),
    ask: z.string().min(1),
    tools: z.array(z.string()).optional(),
    mode: z.enum(['log', 'act']).default('log'),
    threshold: z.number().min(0).max(1).optional(),
    say: z.string().min(1).optional(),
  })
  .refine(q => q.mode === 'log' || (q.threshold !== undefined && q.say), {
    message: 'mode act needs a "threshold" and a "say"; tune the threshold in log mode first',
  });
export type DeciderQuestion = z.infer<typeof DeciderQuestion>;

/** Read-only tools a bot may be given: the bothub MCP server's, and `history` over earlier runs. */
export const HubTool = z.enum(['issues_list', 'issues_get', 'notes_search', 'notes_get', 'runs_read', 'history']);
export type HubTool = z.infer<typeof HubTool>;

export const IssuesBackend = z.enum(['github', 'local']);
export type IssuesBackend = z.infer<typeof IssuesBackend>;

export const Harness = z.enum(['opencode', 'pi', 'claude']);
export type Harness = z.infer<typeof Harness>;

/**
 * What happened to a step's work: `done`, `handed-off` to the step after it, `blocked` on a human, `deferred` until
 * something outside the run changes, or `no-op` when it changed nothing. Only `done` and `handed-off` let the next step
 * start.
 */
export const Closure = z.enum(['done', 'handed-off', 'blocked', 'deferred', 'no-op']);
export type Closure = z.infer<typeof Closure>;

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

/** What to write instead of a key that moved or went away, read from its old value and the object holding it. */
type Moved = Record<string, (value: unknown, input: Record<string, unknown>) => string>;

/** A strict object error that says what to write instead of each moved key, then names any other unknown keys. */
const moved = (table: Moved) => ({
  error: (issue: { code?: string; keys?: string[]; input?: unknown }) => {
    if (issue.code !== 'unrecognized_keys' || !issue.keys) return;
    const input = (issue.input ?? {}) as Record<string, unknown>;
    const known = issue.keys.filter(key => key in table);
    if (!known.length) return;
    const others = issue.keys.filter(key => !(key in table));
    const unknown = others.length ? `Unrecognized keys: ${others.map(key => `"${key}"`).join(', ')}` : '';
    return [...known.map(key => table[key]!(input[key], input)), unknown].filter(Boolean).join('; ');
  },
});

const record = (value: unknown) => (typeof value === 'object' && value ? value : {}) as Record<string, unknown>;

const flow = (value: Record<string, unknown>) =>
  `{ ${Object.entries(value)
    .map(([key, v]) => `${key}: ${String(v)}`)
    .join(', ')} }`;

const turns = () => 'drop "max-turns"; "minutes" and hub "limits.usd-per-run" cap a session';

const botMoved: Moved = {
  session: value => {
    const { resume, share } = record(value);
    const fields = [
      ...(resume === 'attempts' ? ['context: summary'] : []),
      ...(typeof share === 'string' ? [`history: ${share}`] : []),
    ];
    return `session is replaced by context and history; ${fields.length ? `write ${fields.join(' and ')}` : 'remove it'}`;
  },
  resume: () => 'resume is replaced by context',
  'max-turns': turns,
  concurrency: value =>
    `concurrency moved to hub.yaml: write "limits: { bots: { <bot>: { sessions: ${String(value)} } } }"`,
  budget: value => {
    const { minutes, ...rest } = record(value);
    return [
      Object.keys(rest).length && `budget moved to hub.yaml: write "limits: { bots: { <bot>: ${flow(rest)} } }"`,
      minutes !== undefined &&
        `budget minutes moved: write "minutes: ${String(minutes)}" on the steps and checks it runs`,
    ]
      .filter(Boolean)
      .join('; ');
  },
};

/**
 * What a harness can load from the target repo's own setup: its instructions (AGENTS.md or CLAUDE.md), skills, custom
 * tools and MCP servers. An entry is a kind, or `skills/<name>`, `tools/<name>` or `mcp/<name>` for one item of it.
 */
export const Load = z.enum(['instructions', 'skills', 'tools', 'mcp']);
export type Load = z.infer<typeof Load>;

export const LoadEntry = z.union([
  Load,
  z.templateLiteral([z.enum(['skills', 'tools', 'mcp']), '/', z.string().min(1)]),
]);
export type LoadEntry = z.infer<typeof LoadEntry>;
/**
 * `bots/<name>.md`: who acts. The body is the bot's role. `tools` lists harness tools plus any hub tools (see
 * `HubTool`) the bot may call during a run; `returns` is the most it may return, which a step can only narrow.
 * `loads` is what its harness takes from the repo, instructions and skills by default; `context` is what a new run or
 * attempt starts with besides its task; `history` how far back `history` and recall reach, `issue` by default. The hub
 * sets all three for bots that do not. `decider` lists the questions the decision model answers during the bot's
 * opencode runs (see `DeciderQuestion`). How much a bot may run is set in the hub's `limits`.
 */
export const Bot = z.strictObject(
  {
    harness: Harness,
    model: z.string().optional(),
    tools: z.array(z.string()),
    returns: Returns,
    skills: z.array(name).optional(),
    preload: z.array(Preload).optional(),
    loads: z.array(LoadEntry).optional(),
    context: Resume.optional(),
    history: History.optional(),
    summarizer: Summarizer.optional(),
    decider: z.array(DeciderQuestion).optional(),
    human,
  },
  moved(botMoved)
);
export type Bot = z.infer<typeof Bot>;

/** `skills/<name>.md`: what to do. The body is the prompt. */
export const Skill = z.strictObject({ description: z.string().min(1), human });
export type Skill = z.infer<typeof Skill>;

const script = z.string().min(1);

/**
 * What a check or step looks at: once over the whole `diff`, the lines it `added`, the triggering `event`'s text or
 * the output of a `run` script; or once per changed file (`each-file`), per diff hunk (`each-hunk`) or per line an
 * `each` script prints. `items` beside it caps how many items a fan-out takes.
 */
const maxMoved = moved({ max: value => `"max" moved: write "items: ${String(value)}" beside "over"` });

export const Over = z.union(
  [
    z.enum(['diff', 'added', 'event', 'each-file', 'each-hunk']),
    z.strictObject({ run: script }, maxMoved),
    z.strictObject({ each: script }, maxMoved),
  ],
  {
    error: issue => {
      const { max } = record(record(issue.input)['each-hunk']);
      if ('each-hunk' in record(issue.input))
        return `write "over: each-hunk"${max === undefined ? '' : ` and "items: ${String(max)}" beside it`}`;
    },
  }
);

export type Over = z.infer<typeof Over>;

/** How many items a fan-out takes at most: its `items`, or 30 hunks or 50 script lines when unset. */
export const itemCap = (over: Over, items: number | undefined) =>
  items ?? (over === 'each-hunk' ? 30 : typeof over === 'object' && 'each' in over ? 50 : undefined);

/** A missing or unknown check `type`, with a guess from the first field in `hints` the value has. */
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

const checkMoved = moved({
  'max-turns': turns,
  concurrency: () => '"concurrency" on a check is gone; drop it',
});

/** One `type` of a check, naming the fields it does not take. */
const variant = <S extends z.ZodRawShape>(what: string, shape: S) =>
  z.strictObject(shape, {
    error: issue => {
      if (issue.code !== 'unrecognized_keys') return;
      const known = checkMoved.error(issue);
      if (known) return known;
      const keys = issue.keys.map(key => `"${key}"`).join(', ');
      const hint = issue.keys.includes('run') ? '; to judge what a command prints, use "over: { run: <command> }"' : '';
      return `${what} does not take ${keys}${hint}`;
    },
  });

const minutes = z.number().positive().optional();

const checkFields = {
  over: Over.default('diff'),
  items: z.int().positive().optional(),
  paths: z.array(z.string()).optional(),
  mode: Mode.default('log'),
  description: z.string().optional(),
  human,
};

/**
 * `checks/<name>.md`: what a check looks at (`over`) and who judges it. A `script` passes when it exits 0; a `bot`
 * replies PASS or FAIL to the body, added after the skill when there is one; `decide` asks the local decision model
 * the body as a yes-or-no question and passes on yes. A check whose `paths` match no changed file does not apply.
 * `minutes` caps one script run or one bot session of it.
 */
export const Check = z.discriminatedUnion(
  'type',
  [
    variant('a script check', { type: z.literal('script'), run: script, minutes, ...checkFields }),
    variant('a bot check', { type: z.literal('bot'), bot: name, skill: name.optional(), minutes, ...checkFields }),
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

const stepMoved = moved({
  type: () => 'a step with "bot" runs a bot, with "run" a script; drop "type"',
  until: value => {
    const { checks, max = 2 } = record(value);
    const listed = Array.isArray(checks) ? `[${checks.join(', ')}]` : '[...]';
    return `write "checks: ${listed}" and "tries: ${Number(max) + 1}" in place of "until"`;
  },
  needs: () => 'steps run in the order written; drop "needs", or set "next" on the step before',
  on: () => 'one workflow per entry point; move this step to a workflow file of its own',
  mode: () => 'steps always apply their proposals; drop "mode"',
  environment: () => 'put a "wait: human" step before this one in place of "environment"',
  preload: () => 'set "preload" on the bot',
  tools: () => 'set "tools" on the bot',
  decider: () => 'set "decider" on the bot',
  'timeout-minutes': value => `write "minutes: ${String(value)}" in place of "timeout-minutes"`,
});

const stepKinds = ['bot', 'run', 'wait'] as const;

/** The fields each kind of step takes besides `next` and `human`. */
const takes: Record<(typeof stepKinds)[number], string[]> = {
  bot: [
    'bot',
    'skill',
    'checks',
    'tries',
    'over',
    'items',
    'branch',
    'into',
    'requires',
    'returns',
    'minutes',
    'paths',
  ],
  run: ['run', 'over', 'items', 'branch', 'into', 'requires', 'returns', 'minutes', 'paths'],
  wait: ['wait', 'back'],
};

/**
 * A workflow step, run in the order written: a `bot` running a skill (the step's name unless `skill` says otherwise),
 * a `run` script, or a `wait` for a human. A bot step is judged by its `checks` after every attempt and gets `tries`
 * attempts in all, 3 by default. A step that fans out with `over` runs once per item, at most `items`. `branch` is the
 * branch it works on, `into` where its merge requests and merges go (the default branch when unset), and `requires`
 * the checks a merge must pass on the merged tree before it lands. A script returns proposals by ending its output
 * with a `bothub` block, like a bot. `minutes` caps one session or script. `next` names the step after it, or `end`;
 * a wait step goes `back` to the step before it, or the one it names, when a human answers.
 */
export const Step = z
  .strictObject(
    {
      bot: name.optional(),
      run: script.optional(),
      wait: z.literal('human').optional(),
      skill: name.optional(),
      checks: z.array(name).min(1).optional(),
      tries: z.int().positive().optional(),
      over: Over.optional(),
      items: z.int().positive().optional(),
      branch: z.string().optional(),
      into: z.string().optional(),
      requires: z.array(name).optional(),
      returns: Returns.optional(),
      minutes,
      next: name.optional(),
      back: name.optional(),
      paths: z.array(z.string()).optional(),
      human,
    },
    stepMoved
  )
  .superRefine((step, ctx) => {
    const kinds = stepKinds.filter(kind => step[kind] !== undefined);
    if (kinds.length !== 1)
      return ctx.addIssue({ code: 'custom', message: 'a step takes exactly one of "bot", "run" or "wait"' });
    const kind = kinds[0]!;
    const extra = Object.keys(step).filter(
      key => step[key as keyof typeof step] !== undefined && ![...takes[kind], 'next', 'human'].includes(key)
    );
    if (extra.length)
      ctx.addIssue({
        code: 'custom',
        message: `a "${kind}" step does not take ${extra.map(key => `"${key}"`).join(', ')}`,
      });
  })
  .transform(step => ({ ...step, over: step.over ?? ('event' as const) }));
export type Step = z.output<typeof Step>;

/** `workflows/<name>.md`: a trigger and the steps it starts. The body describes the workflow for humans. */
export const Workflow = z.strictObject(
  {
    on: On,
    steps: z.record(name, Step).refine(steps => Object.keys(steps).length > 0, 'needs at least one step'),
    human,
  },
  moved({
    jobs: () => 'jobs are now steps: write "steps:" in the order they run, each with "bot", "run" or "wait: human"',
    name: () => `the file name is the workflow's name; drop "name"`,
    description: () => 'the body describes the workflow; drop "description"',
  })
);
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

const mergeSections = ['closes', 'criteria', 'checks', 'gaps'] as const;
export const MergeSection = z.enum(mergeSections);
export type MergeSection = z.infer<typeof MergeSection>;

const perBot = {
  'runs-per-day': z.int().positive().optional(),
  'usd-per-run': z.number().positive().optional(),
};

/**
 * How much may run: `minutes` for one session or script unless its step or check sets its own, `runs-per-day` for
 * each bot, counting checks and attempts, and `usd-per-run` for one step's attempts and their checks. `bots` sets
 * these per bot, plus `sessions`, how many of its sessions run at once.
 */
export const Limits = z.strictObject({
  minutes: z.number().positive().default(30),
  ...perBot,
  bots: z.record(name, z.strictObject({ sessions: z.int().positive().optional(), ...perBot })).default({}),
});
export type Limits = z.infer<typeof Limits>;

/**
 * `hub.yaml`: hub-wide settings. `issues` picks where issues, plans, specs and open questions live;
 * `merge.default-branch` says who merges into the default branch: only a `human`, or `bots` too. `deps` installs the
 * repository's dependencies once per content of its `lockfiles`, in the sandbox, and links the `dirs` it leaves into
 * every run's worktree, read-only. `sandbox` sets up the run containers: `setup` is a script in the hub that runs as
 * root on top of the base image, `env` is set in every container, `network` is the `allowlist` egress proxy or `open`,
 * and `memory` and `cpus` replace the default limits. `merge-request.sections` names what the engine adds after a merge
 * request's body, in order: the `closes` line, the `criteria` table, the `checks` line and the `gaps`; all but
 * `criteria` by default, `[]` adds nothing. `time-kinds` adds shell command patterns by the kind of time they take,
 * tried before the defaults (see `timeKind`). `limits` caps how much runs (see `Limits`).
 */
export const Hub = z.strictObject({
  issues: IssuesBackend.default('github'),
  limits: Limits.default({ minutes: 30, bots: {} }),
  merge: z
    .strictObject({ 'default-branch': z.enum(['human', 'bots']).default('human') })
    .default({ 'default-branch': 'human' }),
  'merge-request': z
    .strictObject({ sections: z.array(MergeSection).default(['closes', 'checks', 'gaps']) })
    .default({ sections: ['closes', 'checks', 'gaps'] }),
  deps: z
    .strictObject({
      install: z.string().min(1),
      lockfiles: z.array(inRepo).min(1),
      dirs: z.array(inRepo).min(1),
      'timeout-minutes': z.int().positive().default(15),
    })
    .optional(),
  sandbox: z
    .strictObject({
      setup: inRepo.exactOptional(),
      env: z
        .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name'), z.string())
        .default({}),
      network: z.enum(['allowlist', 'open']).default('allowlist'),
      memory: z
        .string()
        .regex(/^[1-9][0-9]*[kmg]?$/i, 'must be a positive size such as 8g')
        .exactOptional(),
      cpus: z.number().positive().exactOptional(),
    })
    .optional(),
  loads: z.array(LoadEntry).optional(),
  context: Resume.optional(),
  history: History.optional(),
  'time-kinds': z
    .partialRecord(z.enum(timeKinds), z.array(z.string().refine(regex, 'must be a regular expression')))
    .default({}),
  human,
});
export type Hub = z.infer<typeof Hub>;

/** How a bot picks the work up after a comment: not at all, only what changed, everything again, or from scratch. */
export const Continue = z.enum(['none', 'changed', 'all', 'fresh']);
export type Continue = z.infer<typeof Continue>;

const said = z.string().trim();

/** A comment on one line of a merge request's diff, on its old or new side. */
export const LineComment = z.strictObject({
  path: said.min(1),
  side: z.enum(['old', 'new']).default('new'),
  line: z.number().int().positive(),
  body: said.min(1),
});

/**
 * What a human writes on a local merge request (`pull`) or issue (`issue`): a comment, line comments on a merge
 * request, and how the bot continues, sent once as the workflow's command with them.
 */
export const Review = z
  .strictObject({
    pull: z.number().int().positive().optional(),
    issue: z.number().int().positive().optional(),
    body: said.default(''),
    lines: z.array(LineComment).default([]),
    continue: Continue.default('changed'),
  })
  .refine(r => (r.pull === undefined) !== (r.issue === undefined), 'name either a merge request or an issue')
  .refine(r => r.pull !== undefined || !r.lines.length, 'line comments need a merge request')
  .refine(r => r.body || r.lines.length || r.continue !== 'none', 'write a comment');
export type Review = z.input<typeof Review>;
