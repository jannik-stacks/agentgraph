import type { Config, Defined } from './config.ts';
import type { Issues } from './issues.ts';
import { matchGlob } from './outputs.ts';
import type { Association, Workflow } from './schema.ts';
import type { BotEvent } from './types.ts';

/**
 * A job an event starts, with the command's arguments and, when the command's first word asks for it, how much runs
 * again: `all` reruns the jobs before it and checks the whole branch, `fresh` also starts the branch over.
 */
export type PlannedJob = { workflow: string; job: string; bot?: string; args?: string; rerun?: Rerun };

export type Rerun = 'all' | 'fresh';

const rerunWord = /^(all|fresh)(?:\s+|$)/;

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
  const { branch } = event;
  if (filter.branches && !(branch && filter.branches.some(glob => matchGlob(glob, branch)))) return [];
  if (filter.labels && !(event.label && filter.labels.includes(event.label))) return [];
  const allowed = filter.guard?.associations ?? (humanText.has(event.trigger) ? trusted : undefined);
  if (allowed && !allowed.includes(event.actor.association)) return [];

  let args: string | undefined;
  let rerun: Rerun | undefined;
  if (filter.command) {
    args = parseCommand(event.body ?? '', filter.command);
    if (args === undefined) return [];
    const word = rerunWord.exec(args);
    if (word) {
      rerun = word[1] as Rerun;
      args = args.slice(word[0].length);
    }
  }

  return Object.entries(workflow.jobs)
    .filter(([, job]) => !job.on || event.trigger in job.on)
    .map(([id, job]) => ({
      workflow: workflow.name,
      job: id,
      ...(job.type === 'bot' && { bot: job.bot }),
      ...(args !== undefined && { args }),
      ...(rerun && { rerun }),
    }));
};

/**
 * The text after `command` (such as `/bothub`) or its mention form (`@bothub`) in the body, or `undefined` when neither
 * appears as a word. Quoted lines and fenced code do not count.
 */
export const parseCommand = (body: string, command: string): string | undefined => {
  const name = command.replace(/^\//, '');
  const word = new RegExp(`(^|\\s)[/@]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,:])`);
  let fenced = false;
  let offset = 0;
  for (const line of body.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*>/.test(line)) continue;
    const found = word.exec(line);
    if (!found) continue;
    const after = start + found.index + found[0].length;
    return body.slice(after).replace(/^[,:]/, '').trim();
  }
};

/**
 * Why work started by `event` is no longer wanted, checked while it runs: its issue was closed, or the label that
 * started it was removed. Only issue and comment events are checked, and an event that closed the issue never is.
 */
export const abandoned = async (event: BotEvent, issues: Pick<Issues, 'get'>) => {
  if (event.number === undefined || !['issues', 'issue_comment'].includes(event.trigger)) return;
  const issue = await issues.get(event.number);
  if (!issue) return;
  if (issue.state === 'closed' && event.action !== 'closed') return `#${event.number} was closed`;
  if (event.action === 'labeled' && event.label !== undefined && !issue.labels.includes(event.label))
    return `its label "${event.label}" was removed`;
};

/** Whether the label that started an event was removed before its jobs ran, which withdraws them. */
export const withdrawn = async (event: BotEvent, issues: Pick<Issues, 'get'>) =>
  event.action === 'labeled' &&
  event.label !== undefined &&
  event.number !== undefined &&
  !(await issues.get(event.number))?.labels.includes(event.label);
