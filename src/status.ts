import type { Event, Issue } from './event.ts';
import { type Run, type Trace } from './types.ts';

export const findLoginProvider = (trace: Trace[], step: Run['step']) => {
  const outcome = trace.findLast(line => 'outcome' in line);
  if (
    !outcome ||
    !('outcome' in outcome) ||
    outcome.outcome.kind !== 'stop' ||
    outcome.failure !== 'login' ||
    outcome.step !== step
  )
    return undefined;
  const before = trace.slice(0, trace.lastIndexOf(outcome));
  const last = before.findLast(line => 'session' in line);
  if (!last || !('session' in last) || last.step !== step || last.session.ended !== 'login' || !last.key)
    return undefined;
  return before
    .flatMap(line =>
      'event' in line &&
      line.key === last.key &&
      (line.event.type === 'start' || line.event.type === 'end') &&
      line.event.provider
        ? [line.event.provider]
        : []
    )
    .at(-1);
};

export const findRunsWaitingOnPeople = <R extends Pick<Run, 'id' | 'status' | 'reason' | 'by' | 'started'>>(
  runs: readonly R[]
) =>
  runs
    .filter(run => run.status === 'waiting' && !runs.some(c => c.by === run.id && run.reason === `waiting on ${c.id}`))
    .toSorted((a, b) => b.started.localeCompare(a.started));

export const formatShellWord = (word: string) =>
  /^[\w./@:+=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export const formatInstanceFlags = (repo?: string, data?: string, name?: string) =>
  `${repo ? ` --repo ${formatShellWord(repo)}` : ''}${data ? ` --data ${formatShellWord(data)}` : ''}${name ? ` --instance ${formatShellWord(name)}` : ''}`;

export const formatNextSteps = (
  run: Pick<Run, 'id' | 'workflow' | 'issue' | 'status' | 'reason'>,
  github?: string,
  flags = ''
) => {
  const issue = github && `https://github.com/${github}/issues/${run.issue}`;
  const n = run.issue;
  return [
    `${run.id} ${run.workflow} #${n} is ${run.status}${run.reason ? `: ${run.reason}` : ''}`,
    ...(issue
      ? [run.reason ? `  Answer at ${issue}` : `  Review the PR linked from ${issue}`]
      : run.reason
        ? [`  agi say ${n} "<answer>"${flags}`]
        : [`  agi merge ${n}${flags}`, `  agi review ${n} changes "<why>"${flags}`]),
  ];
};

export const formatIssueList = (issues: readonly Issue[]) =>
  issues
    .map(
      t =>
        `#${t.number} ${t.state} ${t.title}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}${t.pull ? ` (${t.pull.branch} into ${t.pull.base})` : ''}`
    )
    .join('\n');

export const formatIssueTimeline = (t: Issue & { events: readonly Event[] }, diff: string) =>
  [
    `#${t.number} ${t.state} ${t.title} by ${t.author}${t.labels.length ? ` [${t.labels.join(', ')}]` : ''}\n\n${t.body}\n`,
    ...t.events.map(m => {
      const on = m.comment?.path ? ` on ${m.comment.path}${m.comment.line ? `:${m.comment.line}` : ''}` : '';
      const body = m.comment?.body ? `\n${m.comment.body}\n` : '';
      const when = m.comment?.edited ? `${m.at}, edited ${m.comment.edited}` : m.at;
      return `${when} ${m.actor} ${m.kind}${m.label ? ` ${m.label}` : ''}${on}${body}`;
    }),
    ...(t.pull ? [`\n${t.pull.branch} into ${t.pull.base} at ${t.pull.head}\n\n${diff}`] : []),
  ].join('\n');

export const formatEngineError = (trace: Trace[], file: string) => [
  `cause    ${trace.flatMap(t => ('outcome' in t && t.outcome.kind === 'ask' ? [t.outcome.question] : [])).at(-1) ?? 'not traced'}`,
  `trace    ${file}`,
];
