import { makeStudioRunUrl, type Event, type Issue, type IssueStatus } from './event.ts';
import { formatFailedTryFeedback } from './workflow.ts';
import { type CheckEntry, type Run, type Seen, type Trace } from './types.ts';

/** A run's issue and the pull request on its branch, each with its timeline. */
export type IssueWithPull = { issue: Issue & { events: Event[] }; pull?: Issue & { events: Event[] } };

const cap = 20_000;

/** One event as a line of a timeline: who did what, and what they said. */
export const formatEventLine = (m: Event): string => {
  const c = m.comment;
  const said = c
    ? `${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}, id ${c.under ?? c.id}` : ''}: ${c.body}`
    : '';
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
    case 'column':
      return `${who} moved it to ${m.column?.name} on project ${m.column?.project}`;
    case 'closed':
    case 'merged':
      return `${who} ${m.kind} it`;
  }
};

/** Both timelines merged by time, each entry marked with its number when there are two. */
const timeline = (t: IssueWithPull, keep: (m: Event) => boolean) =>
  [t.issue, ...(t.pull ? [t.pull] : [])]
    .flatMap(issue => issue.events.filter(keep))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(m => (t.pull ? `#${m.issue} ${formatEventLine(m)}` : formatEventLine(m)));

/** The issue and its pull request as markdown: bodies, then one merged timeline. Older entries shrink to one line past a size cap. */
export function context(t: IssueWithPull): string {
  const pull = t.pull;
  const heads = [
    `## #${t.issue.number} ${t.issue.title}\n\n${t.issue.body}`,
    pull &&
      `## Pull request #${pull.number} ${pull.title}\n\n${pull.pull?.branch} into ${pull.pull?.base}\n\n${pull.body}`,
  ].filter(Boolean);
  const lines = timeline(t, m => !isEngineStatus(m));
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

const isEngineStatus = (m: Event) => bot(m) && (m.kind === 'label' || m.kind === 'unlabel');

export function formatRequest(t: IssueWithPull, started: string): string {
  const events = [t.issue, t.pull].flatMap(x => x?.events ?? []);
  const said = events.filter(m => m.trusted && m.comment?.agentRequest !== undefined && m.at === started);
  if (said.length === 0) return '';
  const threads = new Set(said.map(thread).filter(Boolean));
  const around = events.filter(m => !said.includes(m) && threads.has(thread(m)));
  const before = around.filter(m => m.at < started);
  const after = around.filter(m => m.at > started);
  return [
    `## What you were asked\n\n${said.map(formatEventLine).join('\n\n')}`,
    before.length > 0 && `Earlier in its review thread:\n\n${before.map(formatEventLine).join('\n\n')}`,
    after.length > 0 && `Later in its review thread:\n\n${after.map(formatEventLine).join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Only what came after `seen`: what people said and pushed, checks, and the base moving. Empty when nothing did. A
 * review comment a bot already answered in its thread is left out.
 */
export function news(t: IssueWithPull, seen: Seen): { text: string; seen: Seen } {
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

export const stoppedByEngine = 'Stopped by an engine error';

const findRunStatus = (run: Run, runs: Run[], pulled: boolean): IssueStatus =>
  run.status === 'running' || runs.some(r => r.by === run.id && run.reason === `waiting on ${r.id}`)
    ? 'working'
    : run.status === 'waiting'
      ? run.reason || !pulled
        ? 'needs-answer'
        : 'needs-review'
      : run.status;

export const findIssueStatus = (runs: Run[], pulled: boolean): IssueStatus | undefined => {
  const all = runs.toSorted((a, b) => a.started.localeCompare(b.started)).map(r => findRunStatus(r, runs, pulled));
  return (['needs-answer', 'needs-review', 'working'] as const).find(s => all.includes(s)) ?? all.at(-1);
};

const formatUpdate = (text: string, run: Run, pull?: string, studio?: string) =>
  [
    text,
    [pull && `Pull request: ${pull}`, studio && `Run: ${makeStudioRunUrl(studio, run.id)}`].filter(Boolean).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

export function proposeQuestion(before: Run | undefined, run: Run, t: IssueWithPull, runs: Run[], studio?: string) {
  if (
    run.status !== 'waiting' ||
    run.reason === undefined ||
    findRunStatus(run, runs, true) !== 'needs-answer' ||
    (before?.status === 'waiting' && before.reason === run.reason)
  )
    return [];
  const events = [...t.issue.events, ...(t.pull?.events ?? [])].filter(m => m.trusted && !bot(m));
  const pull = (t.pull ?? (t.issue.pull ? t.issue : undefined))?.url;
  const who = events.toSorted((a, b) => a.at.localeCompare(b.at)).at(-1)?.actor ?? t.issue.author;
  const text = `@${who} ${run.reason.startsWith(stoppedByEngine) ? 'Paused on an agentgraph problem, not this change. Reply `/agent` to retry.' : `${run.reason}\n\nReply \`/agent\` and your answer, or \`/agent:stop\` to end the run.`}`;
  return [{ kind: 'comment' as const, body: formatUpdate(text, run, pull, studio) }];
}

const statusWords: Record<IssueStatus, string> = {
  working: 'working on',
  'needs-review': 'waiting for review at',
  'needs-answer': 'waiting for an answer at',
  done: 'done',
  stopped: 'stopped at',
};

export const formatStatusHeader = (
  runs: Run[],
  pulled: boolean,
  steps: (run: Run) => string[],
  usd: (run: Run) => number,
  links: { pull?: string; studio?: string } = {}
) => {
  const status = findIssueStatus(runs, pulled);
  if (!status) return '';
  const sorted = runs.toSorted((a, b) => a.started.localeCompare(b.started));
  const shown = sorted.findLast(r => findRunStatus(r, runs, pulled) === status)!;
  const names = steps(shown);
  const at = names.indexOf(shown.step) + 1;
  const line =
    status === 'done'
      ? names.length > 1
        ? `${names.length} of ${names.length} steps done`
        : 'done'
      : `${statusWords[status]} ${shown.step}${names.length > 1 && at > 0 ? ` (${at} of ${names.length})` : ''}`;
  const rows = sorted.map(r =>
    [
      r.workflow,
      r.step,
      r.status,
      `$${usd(r).toFixed(2)}`,
      (r.checkout && links.pull) ?? '',
      links.studio ? `[${r.id}](${makeStudioRunUrl(links.studio, r.id)})` : r.id,
    ].join(' | ')
  );
  return [
    `※ ${line}`,
    '<details><summary>Runs</summary>',
    [
      '| Workflow | Step | State | Cost | Pull request | Studio |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows.map(r => `| ${r} |`),
    ].join('\n'),
    '</details>',
  ].join('\n\n');
};

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

export const formatRedactedText = (text: string, hidden: readonly string[] = []) => {
  const known = hidden.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
  const cleaned = known.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
  return secrets.reduce(
    (value, pattern) => value.replace(pattern, (_, keep) => `${typeof keep === 'string' ? keep : ''}[redacted]`),
    cleaned
  );
};

/** Text without secrets, on one line, at most `max` long, its middle cut out. */
const clip = (text: string, max: number) => {
  const one = formatRedactedText(text).replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max / 2)} ... ${one.slice(-max / 2)}`;
};

const checked = (e: CheckEntry) => {
  const on = e.item ? ` on ${clip(e.item.split('\n')[0]!, 120)}` : '';
  return `${e.at} ${e.step}, check ${e.check.check}${on}: ${e.check.pass ? 'pass' : `FAIL ${clip(e.check.findings ?? '', 400)}`}`;
};

/** A trace line as one transcript entry, or nothing for lines a reader does not need. */
const entry = (t: Trace): string | undefined => {
  if ('prompt' in t) return `prompt: ${clip(t.prompt.prompt, 1500)}`;
  if ('session' in t) return `session ended ${t.session.ended}, $${t.session.usd.toFixed(2)}`;
  if ('applied' in t) {
    const { proposal: p, ok, reason } = t.applied;
    if (p.kind === 'react') return;
    const { kind: _kind, ...fields } = p;
    return `applied ${p.kind} ${ok ? 'ok' : `refused: ${reason}`}: ${clip(JSON.stringify(fields), 200)}`;
  }
  if ('outcome' in t) {
    const o = t.outcome;
    const why =
      o.kind === 'failed'
        ? formatFailedTryFeedback(o)
        : 'why' in o
          ? o.why
          : 'question' in o
            ? o.question
            : 'text' in o
              ? o.text
              : '';
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
 * run and session the prompt, thinking, text and tool calls, proposals and moves, then its check results. Each trace
 * entry starts with its line in the run's trace. Past `budget`, the older runs keep only how their sessions ended and their outcomes, and
 * then the middle is cut, so the newest run's last sessions stay.
 */
export function transcript(
  issue: number,
  runs: { run: Run; lines: Trace[]; checks: CheckEntry[] }[],
  budget = 60_000
): string {
  const agents = new Map<string, string>();
  const rendered = runs.map(({ run, lines, checks }) => {
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
    if (checks.length > 0) sections.push({ head: '### Checks', entries: checks.map(checked) });
    const usd = lines.reduce((sum, t) => sum + ('session' in t ? t.session.usd : 0), 0);
    const head = `## Run ${run.id} (${run.workflow}, ${run.status}, $${usd.toFixed(2)})`;
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

/** Keeps the first and last part of a long text. */
export const formatSqueezed = (text: string, max = 1500) =>
  text.length <= max ? text.trim() : `${text.slice(0, max / 2).trim()}\n...\n${text.slice(-max / 2).trim()}`;
