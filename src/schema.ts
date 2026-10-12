import { z } from 'zod';
import { Decide } from './decide.ts';

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

export const ForEach = z.enum(['file', 'chunk']);

const list = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item)]).transform(v => (Array.isArray(v) ? v : [v]));

const name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be lowercase kebab-case');

export const TriggerFilter = z
  .strictObject({
    types: z.array(z.string()).optional(),
    command: z.string().startsWith('/').optional(),
    tools: z.array(z.string()).optional(),
    branches: z.array(z.string()).optional(),
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
  'max-turns': z.int().positive(),
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

/**
 * `checks/<name>.md`: a script, a bot, or a `decide` question to the local decision model, returning a verdict. The body is optional extra prompt text. A check whose
 * `paths` match no changed file is skipped, which fails a gate unless `allow-skip` is set.
 */
export const Check = z.strictObject({
  run: z.string().min(1).optional(),
  bot: name.optional(),
  skill: name.optional(),
  'for-each': ForEach.optional(),
  paths: z.array(z.string()).optional(),
  'allow-skip': z.boolean().optional(),
  decide: Decide.optional(),
  mode: Mode.default('shadow'),
  description: z.string().optional(),
});
export type Check = z.infer<typeof Check>;

export const Job = z.strictObject({
  on: On.optional(),
  needs: list(z.string()).default([]),
  bot: name.optional(),
  skill: name.optional(),
  run: z.string().min(1).optional(),
  'for-each': ForEach.optional(),
  branch: z.string().optional(),
  until: z.strictObject({ checks: z.array(name).min(1), max: z.int().positive().default(2) }).optional(),
  can: z.array(ProposalKind).optional(),
  preload: z.array(Preload).optional(),
  tools: z.array(HubTool).optional(),
  paths: z.array(z.string()).optional(),
  mode: Mode.default('shadow'),
  environment: z.string().optional(),
  'timeout-minutes': z.number().positive().optional(),
});
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

/** `hub.yaml`: hub-wide settings. `issues` picks where issues, plans, specs and open questions live. */
export const Hub = z.strictObject({ issues: IssuesBackend.default('github') });
export type Hub = z.infer<typeof Hub>;
