import type { Event, Proposal, Issue } from './forge.ts';
import type { Trace } from './store.ts';
import { failure, type Run, type Seen, type Workflow } from './workflow.ts';

/** A run's issue and the pull request on its branch, each with its timeline. */
export type Issues = { issue: Issue & { events: Event[] }; pull?: Issue & { events: Event[] } };

const cap = 20_000;

/** One event as a line of a timeline: who did what, and what they said. */
export const line = (m: Event): string => {
  const c = m.comment;
  const said = c ? `${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}, id ${c.id}` : ''}: ${c.body}` : '';
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

const bot = (m: Event) => m.actor.endsWith('[bot]');
const thread = (m: Event) => m.comment?.under ?? (m.comment?.path !== undefined ? m.comment.id : undefined);

/**
 * Only what came after `seen`: what people said and pushed, checks, and the base moving. Empty when nothing did. A
 * review comment a bot already answered in its thread is left out.
 */
export function news(t: Issues, seen: Seen): { text: string; seen: Seen } {
  const pull = (t.pull ?? t.issue).pull;
  const moved = pull?.baseSha !== undefined && seen.base !== undefined && pull.baseSha !== seen.base;
  const events = [t.issue, t.pull].flatMap(x => x?.events ?? []);
  const answered = (m: Event) =>
    thread(m) !== undefined && events.some(b => bot(b) && b.at > m.at && thread(b) === thread(m));
  const lines = [
    moved && `The base ${pull.base} moved to ${pull.baseSha!.slice(0, 7)}.`,
    ...timeline(t, m => m.at > seen.at && (m.kind === 'check' || (!bot(m) && !answered(m)))),
  ].filter(Boolean);
  const at = events.reduce((at, m) => (m.at > at ? m.at : at), seen.at);
  return {
    text: lines.length > 0 ? `## New since you last looked\n\n${lines.join('\n\n')}` : '',
    seen: { at, ...(pull?.baseSha !== undefined && { base: pull.baseSha }) },
  };
}

const statuses: Record<Run['status'], string> = {
  running: 'agentgraph:working',
  waiting: 'agentgraph:waiting',
  done: 'agentgraph:done',
  stopped: 'agentgraph:stopped',
};
const failures = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);

/** Housekeeping lines as a collapsed, small-print footer. */
export const footer = (...lines: string[]): string =>
  `<details><summary><sub>agentgraph</sub></summary>\n<sub>${lines.join(' ')}</sub>\n</details>`;

export const answerWith = 'Answer with <code>/agent</code> and your reply, or <code>/agent stop</code> to end the run.';

/** The labels and status comment for a run, as proposals; only what differs from the issue now. */
export function shown(run: Run, w: Workflow, t: Issues): Proposal[] {
  const label = statuses[run.status];
  const labels = t.issue.labels;
  const stale = labels.filter(l => (Object.values(statuses).includes(l) || l.startsWith('bothub:')) && l !== label);
  const pull = t.pull ?? (t.issue.pull ? t.issue : undefined);
  const checks = new Map((pull?.events ?? []).flatMap(m => (m.check ? [[m.check.name, m.check.conclusion]] : [])));
  const failing = [...checks].filter(([, c]) => failures.has(c)).map(([name]) => name);
  const round = Math.max(0, ...Object.values(run.rounds));
  const tries = w.steps.find(s => s.name === run.step)?.tries ?? 1;
  const body = [
    {
      running: `Working on ${run.step}, try ${run.tries + 1} of ${tries}${round ? `, round ${round + 1}` : ''}.`,
      waiting: run.reason
        ? `Waiting for an answer to the question below, at ${run.step}.`
        : `Waiting for a human at ${run.step}.`,
      done: 'Done.',
      stopped: `Stopped at ${run.step}: ${run.reason ?? 'no reason given'}`,
    }[run.status],
    pull && `Pull request: ${pull.url}`,
    failing.length > 0 && `Failing checks: ${failing.join(', ')}`,
    footer(...(run.status === 'waiting' && run.reason ? [answerWith] : []), `Cost so far: $${run.usd.toFixed(2)}.`),
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

/** Tokens, keys and secret assignments a transcript never shows. */
const secrets = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:gh[pousr]_|github_pat_)\w{20,}/g,
  /\bsk-[\w-]{16,}/g,
  /\bxox[abp]-[\w-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bnpm_\w{30,}/g,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
  /\b(bearer\s+)[\w.~+/-]{12,}=*/gi,
  /\b(\w*(?:key|token|secret|password)\w*["']?\s*[=:]\s*["']?)[^\s"']{12,}/gi,
];

/** Text without secrets, on one line, at most `max` long, its middle cut out. */
const clip = (text: string, max: number) => {
  const one = secrets
    .reduce((t, re) => t.replace(re, (_, keep) => `${typeof keep === 'string' ? keep : ''}[redacted]`), text)
    .replace(/\s+/g, ' ')
    .trim();
  return one.length <= max ? one : `${one.slice(0, max / 2)} ... ${one.slice(-max / 2)}`;
};

/** A trace line as one transcript entry, or nothing for lines a reader does not need. */
const entry = (t: Trace): string | undefined => {
  if ('prompt' in t) return `prompt: ${clip(t.prompt.prompt, 1500)}`;
  if ('session' in t) return `session ended ${t.session.ended}, $${t.session.usd.toFixed(2)}`;
  if ('check' in t) {
    const on = t.item ? ` on ${clip(t.item.split('\n')[0]!, 120)}` : '';
    return `check ${t.check.check}${on}: ${t.check.pass ? 'pass' : `FAIL ${clip(t.check.findings ?? '', 400)}`}`;
  }
  if ('applied' in t) {
    const { proposal: p, ok, reason } = t.applied;
    if (p.kind === 'react') return;
    const { kind: _kind, ...fields } = p;
    return `applied ${p.kind} ${ok ? 'ok' : `refused: ${reason}`}: ${clip(JSON.stringify(fields), 200)}`;
  }
  if ('outcome' in t) {
    const o = t.outcome;
    const why =
      o.kind === 'failed' ? failure(o) : 'why' in o ? o.why : 'question' in o ? o.question : 'text' in o ? o.text : '';
    return `outcome ${o.kind}${why ? `: ${clip(why, 300)}` : ''} -> ${t.run.step} ${t.run.status}`;
  }
  if (!('event' in t)) return;
  const e = t.event;
  if (e.type === 'text' || e.type === 'thinking') return `${e.type}: ${clip(e.text, 600)}`;
  if (e.type !== 'tool') return;
  const how = e.denied ? 'denied' : e.exit !== undefined ? `exit ${e.exit}` : e.ok === false ? 'failed' : 'ok';
  return `tool ${e.name} ${clip(JSON.stringify(e.input ?? {}), 200)} ${how}${e.output ? `: ${clip(e.output, 300)}` : ''}`;
};

/** Keeps the first and last entries of a long session and tallies the ones cut between them. */
const shorten = (entries: string[], max = 8000) => {
  if (entries.join('\n').length <= max) return entries;
  const fit = (list: string[]) => {
    let room = max / 2;
    return list.findIndex(e => (room -= e.length + 1) < 0);
  };
  const head = fit(entries);
  const tail = entries.length - fit([...entries].reverse());
  const cut = entries.slice(head, tail).map(e => /^\d+ (tool \S+|\w+)/.exec(e)?.[1] ?? '');
  const tally = [...new Set(cut)].map(k => `${k} ${cut.filter(c => c === k).length}`).join(', ');
  return [...entries.slice(0, head), `... ${cut.length} entries cut: ${tally}`, ...entries.slice(tail)];
};

/**
 * The runs on an issue as one markdown file for an agent that reads traces: each agent's system prompt once, then per
 * run and session the prompt, thinking, text and tool calls, then checks, proposals and moves. Each entry starts with
 * its line in the run's trace. Past `budget`, the older runs keep only how their sessions ended and their outcomes, and
 * then the middle is cut, so the newest run's last sessions stay.
 */
export function transcript(issue: number, runs: { run: Run; lines: Trace[] }[], budget = 60_000): string {
  const agents = new Map<string, string>();
  const rendered = runs.map(({ run, lines }) => {
    const sections = [{ head: '', entries: [] as string[] }];
    lines.forEach((t, n) => {
      if ('prompt' in t) {
        const p = t.prompt;
        agents.set(p.agent, `### ${p.agent} (${p.harness}${p.model ? `, ${p.model}` : ''})\n\n${clip(p.system, 2000)}`);
        const on = t.item ? ` on ${clip(t.item.split('\n')[0]!, 120)}` : '';
        sections.push({ head: `### ${t.step}, ${p.agent}, ${p.resume ? 'resumed' : 'fresh'}${on}`, entries: [] });
      }
      const said = entry(t);
      if (said) sections.at(-1)!.entries.push(`${n + 1} ${said}`);
    });
    const head = `## Run ${run.id} (${run.workflow}, ${run.status}, $${run.usd.toFixed(2)})`;
    const ends = sections.flatMap(s => s.entries.filter(e => /^\d+ (session|outcome)/.test(e)));
    return {
      full: [head, ...sections.flatMap(s => [s.head, shorten(s.entries).join('\n')].filter(Boolean))].join('\n\n'),
      short: [head, 'Shortened to fit: how sessions ended and the outcomes.', ends.join('\n')].join('\n\n'),
    };
  });
  const top = [
    `# Traces of #${issue}`,
    "Runs on this issue, oldest first. Each entry starts with its line in that run's trace.",
    ...(agents.size > 0 ? [`## Agents\n\n${[...agents.values()].join('\n\n')}`] : []),
  ];
  const parts = rendered.map(r => r.full);
  const size = () => [...top, ...parts].join('\n\n').length;
  for (let i = 0; i < parts.length - 1 && size() > budget; i++) parts[i] = rendered[i]!.short;
  const text = [...top, ...parts].join('\n\n');
  return text.length <= budget
    ? text
    : `${text.slice(0, budget / 4)}\n\n... cut to ${budget} characters, the newest kept\n\n${text.slice((-budget * 3) / 4)}`;
}
