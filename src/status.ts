import type { Event, Issue } from './event.ts';
import type { Run } from './workflow.ts';

export const findRunsWaitingOnPeople = (runs: Run[]) =>
  runs
    .filter(run => run.status === 'waiting' && !runs.some(c => c.by === run.id && run.reason === `waiting on ${c.id}`))
    .toSorted((a, b) => b.started.localeCompare(a.started));

export const formatShellWord = (word: string) =>
  /^[\w./@:+=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export const formatInstanceFlags = (repo?: string, data?: string) =>
  `${repo ? ` --repo ${formatShellWord(repo)}` : ''}${data ? ` --data ${formatShellWord(data)}` : ''}`;

export const formatNextSteps = (run: Run, github?: string, flags = '') => {
  const issue = github && `https://github.com/${github}/issues/${run.issue}`;
  const n = run.issue;
  return [
    `${run.id} ${run.workflow} #${n} is ${run.status}${run.reason ? `: ${run.reason}` : ''}`,
    ...(issue
      ? [run.reason ? `  Answer at ${issue}` : `  Review the PR linked from ${issue}`]
      : run.reason
        ? [`  npx agentgraph say ${n} "<answer>"${flags}`]
        : [`  npx agentgraph merge ${n}${flags}`, `  npx agentgraph review ${n} changes "<why>"${flags}`]),
  ];
};

export const formatIssueList = (issues: Issue[]) =>
  issues
    .map(
      t =>
        `#${t.number} ${t.state} ${t.title}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}${t.pull ? ` (${t.pull.branch} into ${t.pull.base})` : ''}`
    )
    .join('\n');

export const formatIssueTimeline = (t: Issue & { events: Event[] }, diff: string) =>
  [
    `#${t.number} ${t.state} ${t.title} by ${t.author}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}\n\n${t.body}\n`,
    ...t.events.map(m => {
      const on = m.comment?.path ? ` on ${m.comment.path}${m.comment.line ? `:${m.comment.line}` : ''}` : '';
      const body = m.comment?.body ? `\n${m.comment.body}\n` : '';
      return `${m.at} ${m.actor} ${m.kind}${m.label ? ` ${m.label}` : ''}${on}${body}`;
    }),
    ...(t.pull ? [`\n${t.pull.branch} into ${t.pull.base} at ${t.pull.head}\n\n${diff}`] : []),
  ].join('\n');
