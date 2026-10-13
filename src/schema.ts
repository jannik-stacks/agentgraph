import { z } from 'zod';

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

export const ProposalKind = z.enum(['reply', 'label', 'push', 'open-pr', 'note', 'ask']);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const NoteKind = z.enum(['decision', 'convention', 'pattern', 'caveat']);
export type NoteKind = z.infer<typeof NoteKind>;

/** Rules load whenever their `paths` match; knowledge loads only when relevant. */
export const ruleKinds: readonly NoteKind[] = ['decision', 'convention'];

/** Context rendered into a run before it starts: the triggering issue, its linked issues, the matching notes. */
export const Preload = z.enum(['issue', 'links', 'notes']);
export type Preload = z.infer<typeof Preload>;

/** Read-only tools the bothub MCP server offers a run. */
export const HubTool = z.enum(['issues_list', 'issues_get', 'notes_search', 'notes_get', 'runs_read']);
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
 * `bots/<name>.md`: who acts. The body is the bot's role. `tools` lists harness tools plus any bothub read tools
 * (see `HubTool`) the bot may call during a run.
 */
export const Bot = z.strictObject({
  harness: Harness,
  model: z.string().optional(),
  tools: z.array(z.string()),
  can: z.array(ProposalKind),
  skills: z.array(name).optional(),
  notes: z.array(NoteKind).optional(),
  preload: z.array(Preload).optional(),
  'max-turns': z.int().positive().optional(),
  budget: z
    .strictObject({
      'runs-per-day': z.int().positive().optional(),
      minutes: z.number().positive().optional(),
      'usd-per-run': z.number().positive().optional(),
    })
    .optional(),
});
export type Bot = z.infer<typeof Bot>;

/** `skills/<name>.md`: what to do. The body is the prompt. */
export const Skill = z.strictObject({
  description: z.string().min(1),
  notes: z.array(NoteKind).optional(),
});
export type Skill = z.infer<typeof Skill>;

const script = z.string().min(1);

/**
 * What a check or job looks at: once over the whole `diff`, the lines it `added`, the triggering `event`'s text or
 * the output of a `run` script; or once per changed file (`each-file`), per diff hunk (`each-hunk`) or per line an
 * `each` script prints, at most `max` of them.
 */
export const Over = z.union([
  z.enum(['diff', 'added', 'event', 'each-file', 'each-hunk']),
  z.strictObject({ run: script }),
  z.strictObject({ each: script, max: z.int().positive().default(50) }),
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

const checkFields = {
  over: Over.default('diff'),
  paths: z.array(z.string()).optional(),
  mode: Mode.default('shadow'),
  description: z.string().optional(),
};

/**
 * `checks/<name>.md`: what a check looks at (`over`) and who judges it. A `script` passes when it exits 0; a `bot`
 * replies PASS or FAIL to the body, added after the skill when there is one; `decide` asks the local decision model
 * the body as a yes-or-no question and passes on yes. A check whose `paths` match no changed file does not apply.
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
const jobEnd = {
  over: Over.default('event'),
  paths: z.array(z.string()).optional(),
  mode: Mode.default('shadow'),
  environment: z.string().optional(),
  'timeout-minutes': z.number().positive().optional(),
};

/** A workflow step: a `bot` running a skill, or a `script`. A job that fans out with `over` runs once per item. */
export const Job = z.discriminatedUnion(
  'type',
  [
    variant('a bot job', {
      type: z.literal('bot'),
      ...jobStart,
      bot: name,
      skill: name,
      branch: z.string().optional(),
      until: z.strictObject({ checks: z.array(name).min(1), max: z.int().positive().default(2) }).optional(),
      can: z.array(ProposalKind).optional(),
      preload: z.array(Preload).optional(),
      tools: z.array(HubTool).optional(),
      ...jobEnd,
    }),
    variant('a script job', { type: z.literal('script'), ...jobStart, run: script, ...jobEnd }),
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
});
export type Workflow = z.infer<typeof Workflow>;

/** `notes/<kind>/<slug>.md`: what the hub knows. The body is the note. */
export const Note = z.strictObject({
  title: z.string().min(1),
  status: z.enum(['proposed', 'accepted', 'superseded', 'retired']).optional(),
  source: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  check: name.optional(),
  paths: z.array(z.string()).optional(),
});
export type Note = z.infer<typeof Note>;

/** `issues/<n>-<slug>.md` in a hub with local issues. The body is the issue, followed by its comments. */
export const IssueFile = z.strictObject({
  title: z.string().min(1),
  state: z.enum(['open', 'closed']).default('open'),
  labels: z.array(z.string()).default([]),
  author: z.string().exactOptional(),
  parent: z.int().positive().exactOptional(),
  links: z.array(z.int().positive()).exactOptional(),
});

/** `hub.yaml`: hub-wide settings. `issues` picks where issues, plans, specs and open questions live. */
export const Hub = z.strictObject({ issues: IssuesBackend.default('github') });
export type Hub = z.infer<typeof Hub>;
