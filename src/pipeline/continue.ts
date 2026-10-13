import type { PlannedJob } from '../dispatch.ts';
import type { Comment } from '../issues.ts';
import type { Pull } from '../pulls.ts';
import type { Resume } from '../schema.ts';
import type { Run, Store } from '../store.ts';
import { readSummaries, summarizeEvents } from '../summaries.ts';
import type { BotEvent, RunSpec } from '../types.ts';
import { type Pipeline, issuesOf, pullsOf } from './context.ts';
import { fenced } from './prompt.ts';

const commented = new Set<BotEvent['trigger']>(['issue_comment', 'pull_request_review', 'pull_request_review_comment']);

/** Whether an event is about a merge request itself rather than an issue, which may share its number. */
export const onRequest = ({ number, pull }: Pick<BotEvent, 'number' | 'pull'>) =>
  number !== undefined && number === pull;

/** The run of the job that opened `pull`, from the job and event in its `origin`. */
export const openerOf = async (pull: Pick<Pull, 'origin'>, store: Store): Promise<Run | undefined> => {
  if (!pull.origin) return;
  const [workflow = '', job = ''] = pull.origin.job.split('/');
  return (await store.runs({ event: pull.origin.event, workflow, job, check: false }))[0];
};

/**
 * A comment on a merge request bothub opened, as the comment on the issue it continues: the same comment, now on the
 * issue the opening run was for, with the request as `pull`, planned only for that run's workflow. Resolves to
 * nothing for any other event, and to a reason when the request is closed or merged, which continues nothing.
 */
export const continuation = async (
  p: Pipeline
): Promise<{ event: BotEvent; workflow: string } | { reason: string } | undefined> => {
  const { event } = p;
  if (event.pull === undefined || !commented.has(event.trigger)) return;
  const pull = await pullsOf(p)
    ?.get(event.pull)
    .catch(() => undefined);
  const opener = pull && (await openerOf(pull, p.store));
  if (!pull || opener?.event.number === undefined) return;
  if (pull.state !== 'open') return { reason: `merge request #${pull.number} is ${pull.state}` };
  const { ref: _ref, branch: _branch, parent: _parent, ...rest } = event;
  return {
    workflow: opener.workflow,
    event: { ...rest, trigger: 'issue_comment', action: 'created', number: opener.event.number, pull: pull.number },
  };
};

const earlierLines = 40;

/**
 * What a run did and how it ended, for a later run or attempt of a bot that resumes: its stored summaries, or, when
 * it has none, the extractive summary of its events. The last lines win.
 */
export const attemptSummary = async (run: Run, p: Pipeline) => {
  const stored = p.data ? await readSummaries(p.data, run.id) : [];
  const records = stored.length ? stored : summarizeEvents(run.id, await p.store.events(run.id));
  return (
    records
      .slice(-earlierLines)
      .map(r => `- ${r.line}`)
      .join('\n') || undefined
  );
};

/** The harness session `run` recorded, with the home that holds it. */
export const sessionOf = async (run: Run, p: Pipeline): Promise<RunSpec['session']> => {
  for (const { event } of await p.store.events(run.id))
    if (event.type === 'start' && event.session) return { id: event.session, home: p.store.home(run.id) };
};

/**
 * What a run or attempt after `run` starts with: with `resume: session` the harness session `run` left, and with
 * `resume: summary`, or a session that cannot be continued, what `run` did.
 */
export const carried = async (resume: Resume | undefined, run: Run, p: Pipeline) => {
  if (!resume || resume === 'none') return {};
  const session = resume === 'session' ? await sessionOf(run, p) : undefined;
  return session ? { session } : { summary: await attemptSummary(run, p) };
};

const human = (comment: Comment, since: string) => !comment.author.endsWith('[bot]') && comment.ts > since;

/**
 * What humans wrote after `since`, besides the event's own text: on the event's issue, and on merge request `pull`,
 * a comment on a line with its file and line.
 */
export const saidSince = async (since: string, pull: number | undefined, p: Pipeline) => {
  const { number, body } = p.event;
  const own = (comment: Comment) => comment.body.trim() === body?.trim();
  const issue = number === undefined ? undefined : await issuesOf(p)?.get(number);
  const onIssue = (issue?.comments ?? [])
    .filter(comment => human(comment, since) && !own(comment))
    .map(comment => `On #${number}: ${comment.body.trim()}`);
  const comments =
    pull === undefined
      ? []
      : ((await pullsOf(p)
          ?.comments(pull)
          .catch(() => [])) ?? []);
  const onPull = comments
    .filter(comment => human(comment, since) && (comment.path || !own(comment)))
    .map(({ path, line, side, body }) =>
      path
        ? `On ${path}${line === undefined ? '' : `:${line}`}${side === 'old' ? ' (removed line)' : ''}: ${body.trim()}`
        : `On merge request #${pull}: ${body.trim()}`
    );
  return [...onIssue, ...onPull];
};

/**
 * The prompt section for a job that continues its own earlier work on the issue: the runs before, the branch and open
 * merge request the work is on, what the last run did when the bot resumes from a summary, and what the human asks
 * now; with `resume: session`, the session to continue. Nothing when the job has not run on the issue before, or its
 * last run blocked, which resumes instead.
 */
export const continuing = async (
  planned: PlannedJob,
  created: Run,
  branch: string,
  resume: Resume | undefined,
  p: Pipeline
) => {
  const { repo, number } = p.event;
  if (number === undefined) return;
  const { workflow, job } = planned;
  const runs = (await p.store.runs({ repo, number, workflow, job, check: false })).filter(
    r => r.id !== created.id && r.closure !== undefined && r.status !== 'skipped'
  );
  const [last] = runs;
  if (!last || last.closure === 'blocked') return;
  const [open] =
    (await pullsOf(p)
      ?.list({ branch })
      .catch(() => [])) ?? [];
  const pull = p.event.pull ?? open?.number;
  const asked = (planned.args ?? p.event.body)?.trim();
  const said = [...(asked ? [asked] : []), ...(await saidSince(last.endedAt ?? '', pull, p))];
  const { summary, session } = await carried(resume, last, p);
  const before = runs
    .slice(0, 5)
    .map(r => `run ${r.id} (${r.closure})`)
    .join(', ');
  const section = [
    '## Continuing',
    `You worked on this before: ${before}. Your work is on \`${branch}\` and already in this worktree${open ? `, with merge request #${open.number} open` : ''}: build on it, do not start over.`,
    summary && `What your last run did:\n\n${summary}`,
    said.length
      ? `The human asks:\n\n${said.map(fenced).join('\n\n')}`
      : 'No new instruction was given; read the issue and the merge request.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { section, ...(session && { session }) };
};
