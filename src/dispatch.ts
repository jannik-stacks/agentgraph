import type { Config, Defined } from './config.ts';
import type { Issues } from './issues.ts';
import type { Association, Workflow } from './schema.ts';
import type { BotEvent } from './types.ts';

export type PlannedJob = { workflow: string; job: string; bot?: string; args?: string };

const trusted: Association[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const humanText = new Set([
  'issue_comment',
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
]);

/**
 * Decides which jobs an event starts. Events carrying human-written text are accepted only from
 * trusted associations unless the trigger's `guard` says otherwise.
 */
export const plan = (event: BotEvent, config: Config): PlannedJob[] =>
  Object.values(config.workflows).flatMap(workflow => planWorkflow(event, workflow));

/**
 * Plans an event once: a delivery id already in the ledger plans nothing, so a redelivered webhook or a repeated
 * local change never starts the same jobs twice.
 */
export const dispatch = async (
  event: BotEvent,
  config: Config,
  ledger: { deliver: (id: string) => Promise<boolean> }
): Promise<PlannedJob[]> => ((await ledger.deliver(event.id)) ? plan(event, config) : []);

/** Whether an association may start jobs from text it wrote, unless a trigger's `guard` says otherwise. */
export const isTrusted = (association: Association) => trusted.includes(association);

const planWorkflow = (event: BotEvent, workflow: Defined<Workflow>): PlannedJob[] => {
  const filter = workflow.on[event.trigger];
  if (!filter) return [];
  if (filter.types && !(event.action && filter.types.includes(event.action))) return [];
  if (filter.branches && !(event.branch && filter.branches.includes(event.branch))) return [];
  if (filter.labels && !(event.label && filter.labels.includes(event.label))) return [];
  const allowed = filter.guard?.associations ?? (humanText.has(event.trigger) ? trusted : undefined);
  if (allowed && !allowed.includes(event.actor.association)) return [];

  let args: string | undefined;
  if (filter.command) {
    args = parseCommand(event.body ?? '', filter.command);
    if (args === undefined) return [];
  }

  return Object.entries(workflow.jobs)
    .filter(([, job]) => !job.on || event.trigger in job.on)
    .map(([id, job]) => ({
      workflow: workflow.name,
      job: id,
      ...(job.type === 'bot' && { bot: job.bot }),
      ...(args !== undefined && { args }),
    }));
};

/** Returns the text after `command` when the body starts with it, otherwise `undefined`. */
export const parseCommand = (body: string, command: string): string | undefined => {
  const text = body.trim();
  if (!text.startsWith(command)) return;
  const rest = text.slice(command.length);
  if (rest && !/^\s/.test(rest)) return;
  return rest.trim();
};

/** Whether the label that started an event was removed before its jobs ran, which withdraws them. */
export const withdrawn = async (event: BotEvent, issues: Pick<Issues, 'get'>) =>
  event.action === 'labeled' &&
  event.label !== undefined &&
  event.number !== undefined &&
  !(await issues.get(event.number))?.labels.includes(event.label);
