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

export const SafeOutputKind = z.enum(['reply', 'label', 'push-branch', 'open-pr', 'propose-rule', 'ask-human']);
export type SafeOutputKind = z.infer<typeof SafeOutputKind>;

export const Executor = z.enum(['claude-code', 'codex', 'opencode', 'pi']);
export type Executor = z.infer<typeof Executor>;

const list = <T extends z.ZodType>(item: T) =>
  z.union([item, z.array(item)]).transform(v => (Array.isArray(v) ? v : [v]));

export const Budget = z.strictObject({
  'runs-per-day': z.int().positive().optional(),
  'usd-per-run': z.number().positive().optional(),
});

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

export const Step = z.union([
  z.strictObject({ name: z.string().optional(), run: z.string() }),
  z.strictObject({ name: z.string().optional(), uses: z.string(), with: z.record(z.string(), z.unknown()).optional() }),
]);

export const SafeOutput = z.strictObject({
  max: z.int().positive().default(1),
  paths: z.array(z.string()).optional(),
  environment: z.string().optional(),
});

export const Job = z.strictObject({
  on: On.optional(),
  needs: list(z.string()).default([]),
  mode: Mode.default('shadow'),
  'runs-on': z.enum(['local', 'github']).default('local'),
  persona: z.string().optional(),
  steps: z.array(Step).default([]),
  outputs: z.array(z.string()).default([]),
  strategy: z.strictObject({ matrix: z.record(z.string(), z.union([z.string(), z.array(z.unknown())])) }).optional(),
  'safe-outputs': z.partialRecord(SafeOutputKind, SafeOutput).default({}),
  environment: z.string().optional(),
  'timeout-minutes': z.number().positive().optional(),
  budget: Budget.optional(),
});
export type Job = z.infer<typeof Job>;

export const WorkflowFrontmatter = z.strictObject({
  name: z.string(),
  on: On,
  permissions: z.record(z.string(), z.enum(['read', 'write'])).default({}),
  budget: Budget.optional(),
  jobs: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), Job),
});
export type WorkflowFrontmatter = z.infer<typeof WorkflowFrontmatter>;

export const PersonaFrontmatter = z.strictObject({
  name: z.string().optional(),
  executor: Executor,
  model: z.string().optional(),
  tools: z.array(z.string()).default([]),
  'can-write': z.array(SafeOutputKind).default([]),
  'max-turns': z.int().positive().default(20),
  'timeout-minutes': z.number().positive().default(30),
  budget: Budget.optional(),
});
export type PersonaFrontmatter = z.infer<typeof PersonaFrontmatter>;
