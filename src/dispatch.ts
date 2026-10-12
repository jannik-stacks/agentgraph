import type { Config, Workflow } from './config.ts';
import type { Association } from './schema.ts';
import type { BotEvent } from './types.ts';

export type PlannedJob = { workflow: string; job: string; persona?: string; args?: string };

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

const planWorkflow = (event: BotEvent, workflow: Workflow): PlannedJob[] => {
  const filter = workflow.on[event.trigger];
  if (!filter) return [];
  if (filter.types && !(event.action && filter.types.includes(event.action))) return [];
  if (filter.branches && !(event.ref && filter.branches.includes(event.ref))) return [];
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
      ...(job.persona && { persona: job.persona }),
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
