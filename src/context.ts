import type { Event, Proposal, Issue } from './forge.ts';
import type { Run, Seen, Workflow } from './workflow.ts';

/** A run's issue and the pull request on its branch, each with its timeline. */
export type Issues = { issue: Issue & { events: Event[] }; pull?: Issue & { events: Event[] } };

const cap = 20_000;

const line = (m: Event): string => {
  const c = m.comment;
  const said = c ? `${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body}` : '';
  const who = `@${m.actor}`;
  switch (m.kind) {
    case 'comment':
      return `${who}${said}`;
    case 'approved':
      return `${who} approved${said}`;
    case 'changes_requested':
      return `${who} requested changes${said}`;
    case 'commit':
      return `${who} pushed ${m.commit?.sha.slice(0, 7)} ${m.commit?.title}`;
    case 'check':
      return `check ${m.check?.name}: ${m.check?.conclusion}`;
    case 'label':
      return `${who} added the label ${m.label}`;
    case 'unlabel':
      return `${who} removed the label ${m.label}`;
    case 'closed':
    case 'merged':
      return `${who} ${m.kind} it`;
  }
};

/** Both timelines merged by time, each entry marked with its number when there are two. */
const timeline = (t: Issues, keep: (m: Event) => boolean) =>
  [t.issue, ...(t.pull ? [t.pull] : [])]
    .flatMap(issue => issue.events.filter(keep))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(m => (t.pull ? `#${m.issue} ${line(m)}` : line(m)));

/** The issue and its pull request as markdown: bodies, then one merged timeline. Older entries shrink to one line past a size cap. */
export function context(t: Issues): string {
  const pull = t.pull;
  const heads = [
    `## #${t.issue.number} ${t.issue.title}\n\n${t.issue.body}`,
    pull &&
      `## Pull request #${pull.number} ${pull.title}\n\n${pull.pull?.branch} into ${pull.pull?.base}\n\n${pull.body}`,
  ].filter(Boolean);
  const lines = timeline(t, () => true);
  let size = [...heads, ...lines].join('\n\n').length;
  for (let i = 0; i < lines.length && size > cap; i++) {
    const short = `${lines[i]!.split('\n')[0]!.slice(0, 120)} ...`;
    if (short.length >= lines[i]!.length) continue;
    size -= lines[i]!.length - short.length;
    lines[i] = short;
  }
  return [...heads, lines.length > 0 && `## Timeline\n\n${lines.join('\n\n')}`].filter(Boolean).join('\n\n');
}

/** Only what came after `seen`: what people said and pushed, checks, and the base moving. Empty when nothing did. */
export function news(t: Issues, seen: Seen): { text: string; seen: Seen } {
  const pull = (t.pull ?? t.issue).pull;
  const moved = pull?.baseSha !== undefined && seen.base !== undefined && pull.baseSha !== seen.base;
  const lines = [
    moved && `The base ${pull.base} moved to ${pull.baseSha!.slice(0, 7)}.`,
    ...timeline(t, m => m.at > seen.at && (m.kind === 'check' || !m.actor.endsWith('[bot]'))),
  ].filter(Boolean);
  const at = [t.issue, t.pull].flatMap(x => x?.events ?? []).reduce((at, m) => (m.at > at ? m.at : at), seen.at);
  return {
    text: lines.length > 0 ? `## New since you last looked\n\n${lines.join('\n\n')}` : '',
    seen: { at, ...(pull?.baseSha !== undefined && { base: pull.baseSha }) },
  };
}

const statuses: Record<Run['status'], string> = {
  running: 'bothub:working',
  waiting: 'bothub:waiting',
  done: 'bothub:done',
  stopped: 'bothub:stopped',
};
const failures = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);

/** How to answer a waiting run: mention the bot when its slug is known, else the `/bothub` command. */
export const answerWith = (slug?: string): string => {
  const say = slug ? `@${slug}` : '/bothub';
  return `Answer with \`${say} <your answer>\`, or \`${say} stop\` to end the run.`;
};

/** The labels and status comment for a run, as proposals; only what differs from the issue now. */
export function shown(run: Run, w: Workflow, t: Issues, slug?: string): Proposal[] {
  const label = statuses[run.status];
  const labels = t.issue.labels;
  const stale = labels.filter(l => Object.values(statuses).includes(l) && l !== label);
  const pull = t.pull ?? (t.issue.pull ? t.issue : undefined);
  const checks = new Map((pull?.events ?? []).flatMap(m => (m.check ? [[m.check.name, m.check.conclusion]] : [])));
  const failing = [...checks].filter(([, c]) => failures.has(c)).map(([name]) => name);
  const round = Math.max(0, ...Object.values(run.rounds));
  const tries = w.steps.find(s => s.name === run.step)?.tries ?? 1;
  const body = [
    {
      running: `Working on ${run.step}, try ${run.tries + 1} of ${tries}${round ? `, round ${round + 1}` : ''}.`,
      waiting: run.reason
        ? `Waiting for an answer at ${run.step}:\n\n${run.reason}\n\n${answerWith(slug)}`
        : `Waiting for a human at ${run.step}.`,
      done: 'Done.',
      stopped: `Stopped at ${run.step}: ${run.reason ?? 'no reason given'}`,
    }[run.status],
    `Cost so far: $${run.usd.toFixed(2)}.`,
    pull && `Pull request: ${pull.url}`,
    failing.length > 0 && `Failing checks: ${failing.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const now = run.comment && t.issue.events.find(m => m.comment?.id === run.comment)?.comment?.body;
  return [
    ...(labels.includes(label) && stale.length === 0
      ? []
      : [
          {
            kind: 'label' as const,
            ...(!labels.includes(label) && { add: [label] }),
            ...(stale.length > 0 && { remove: stale }),
          },
        ]),
    ...(now === body ? [] : [{ kind: 'comment' as const, body, ...(run.comment && { edit: run.comment }) }]),
  ];
}
