import type { Config } from './config.ts';
import { roles, type Issue, type Issues } from './issues.ts';
import type { Preload } from './schema.ts';
import type { BotEvent } from './types.ts';

type Note = Config['notes'][number];

/** Whether a note is in force: accepted, or without a status. Proposed notes wait for a human. */
export const accepted = (note: Note) => (note.status ?? 'accepted') === 'accepted';

const facts = (issue: Issue) =>
  [
    `State: ${issue.state}`,
    issue.labels.length && `Labels: ${issue.labels.join(', ')}`,
    issue.parent !== undefined && `Parent: #${issue.parent}`,
    issue.links?.length && `Links: ${issue.links.map(n => `#${n}`).join(', ')}`,
  ]
    .filter(Boolean)
    .join('. ');

const renderIssue = (issue: Issue, level: number, label = '') =>
  [
    `${'#'.repeat(level)} ${label}#${issue.number}: ${issue.title}`,
    facts(issue),
    issue.body,
    ...issue.comments.map(c => `${'#'.repeat(level + 1)} @${c.author} at ${c.ts}\n\n${c.body}`),
  ]
    .filter(Boolean)
    .join('\n\n');

const briefMarker = (workflow: string, needs: string[]) =>
  new RegExp(`<!-- bothub:\\S*/${workflow}/(?:${needs.join('|')})/\\S*reply-\\d+ -->`);

/**
 * What recall searches with for a job of `workflow`, read from the issue `context` `issueContext` rendered: the latest
 * reply a job it `needs` posted on the issue, its brief, without the marker bothub wrote; otherwise the issue's title
 * and body.
 */
export const recallQuery = (context: string | undefined, workflow: string, needs: string[]) => {
  if (!context?.startsWith('## Issue ')) return;
  const [issue, ...comments] = context.split(/\n\n#{3,} @\S+ at \S+\n\n/);
  const marker = briefMarker(workflow, needs);
  const brief = needs.length ? comments.findLast(comment => marker.test(comment)) : undefined;
  return brief ? brief.slice(0, brief.search(marker)).trim() : issue;
};

const questionsOn = async (issues: Issues, number: number) => {
  const asked = await issues.list({ parent: number, label: roles.unsure, state: 'all' });
  return (await Promise.all(asked.map(q => issues.get(q.number)))).filter(q => q !== undefined);
};

/**
 * What humans wrote on the event's issue and on the questions asked on it after the latest brief a job of `workflow`
 * it `needs` posted there, each without a leading command.
 */
export const answersAfterBrief = async (
  issues: Issues | undefined,
  event: BotEvent,
  workflow: string,
  needs: string[]
): Promise<string[]> => {
  if (!issues || event.number === undefined || !needs.length) return [];
  const issue = await issues.get(event.number);
  const marker = briefMarker(workflow, needs);
  const brief = issue?.comments.findLast(comment => marker.test(comment.body));
  if (!issue || !brief) return [];
  return [issue, ...(await questionsOn(issues, issue.number))]
    .flatMap(({ comments }) => comments)
    .filter(comment => !comment.author.endsWith('[bot]') && comment.ts > brief.ts)
    .map(comment => comment.body.replace(/^\/\S+/, '').trim())
    .filter(Boolean);
};

/**
 * The issue context rendered into a run's prompt: the triggering issue with its comments (`issue`), and its parent,
 * linked issues and sub-issues (`links`). Empty without an issue tracker or an issue number.
 */
export const issueContext = async (issues: Issues | undefined, event: BotEvent, preload: Preload[]) => {
  if (!issues || event.number === undefined) return;
  const wantsIssue = preload.includes('issue');
  const wantsLinks = preload.includes('links');
  if (!wantsIssue && !wantsLinks) return;
  const issue = await issues.get(event.number);
  if (!issue) return;
  const sections = wantsIssue ? [renderIssue(issue, 2, 'Issue ')] : [];
  if (wantsIssue) {
    const questions = await questionsOn(issues, issue.number);
    if (questions.length)
      sections.push(['## Questions asked on this issue', ...questions.map(q => renderIssue(q, 3))].join('\n\n'));
  }
  if (wantsLinks) {
    const numbers = [...new Set([issue.parent, ...(issue.links ?? [])].filter(n => n !== undefined))];
    const [linked, steps] = await Promise.all([
      Promise.all(numbers.map(n => issues.get(n))),
      issues.list({ parent: issue.number, state: 'all' }),
    ]);
    const found = linked.filter(i => i !== undefined).map(i => renderIssue({ ...i, comments: [] }, 3));
    const checklist = steps.map(s => `- [${s.state === 'closed' ? 'x' : ' '}] #${s.number}: ${s.title}`);
    if (found.length || checklist.length)
      sections.push(
        ['## Linked issues', ...found, checklist.length && `### Sub-issues\n\n${checklist.join('\n')}`]
          .filter(Boolean)
          .join('\n\n')
      );
  }
  return sections.join('\n\n') || undefined;
};
