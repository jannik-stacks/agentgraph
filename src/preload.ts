import { effectivePreload, effectiveTools, harnessTools, type Config } from './config.ts';
import { roles, type Issue, type Issues } from './issues.ts';
import { NoteKind, ruleKinds, type Bot, type Job, type Preload, type Skill } from './schema.ts';
import type { BotEvent } from './types.ts';

type Note = Config['notes'][number];

const prefix = (glob: string) => glob.split(/[*?{[]/)[0] ?? '';

/** Whether two glob lists can match a common path, judged by their literal prefixes. A missing list matches anything. */
export const overlaps = (a: string[] | undefined, b: string[] | undefined) =>
  !a || !b || a.some(x => b.some(y => prefix(x).startsWith(prefix(y)) || prefix(y).startsWith(prefix(x))));

/** Whether a note is in force: accepted, or without a status. Proposed notes wait for a human. */
export const accepted = (note: Note) => (note.status ?? 'accepted') === 'accepted';

/** Why a note loads: a rule in force, a kind the bot or skill lists, or `paths` that overlap the job's. */
export type NoteReason = 'rule' | 'kind' | 'paths';

/** Why a run with these `kinds` and `paths` loads `note`, or nothing when it does not. */
export const noteReason = (
  note: Note,
  { kinds, paths }: { kinds: NoteKind[]; paths: string[] | undefined }
): NoteReason | undefined => {
  if (!accepted(note)) return;
  if (ruleKinds.includes(note.kind)) return overlaps(note.paths, paths) ? 'rule' : undefined;
  if (kinds.includes(note.kind)) return overlaps(note.paths, paths) ? 'kind' : undefined;
  if (note.paths && paths && overlaps(note.paths, paths)) return 'paths';
};

/**
 * The notes a run loads. Rules (decisions and conventions) load whenever their `paths` overlap the job's. Knowledge
 * (patterns and caveats) loads when the bot or skill lists its kind, or when it names `paths` that overlap the job's
 * declared `paths`; the rest stays reachable through the `notes_search` tool. Only accepted notes load.
 */
export const relevantNotes = (notes: Note[], query: Parameters<typeof noteReason>[1]) =>
  notes.filter(note => noteReason(note, query) !== undefined);

/**
 * What a run of `bot` with `skill` starts with, given the `step` that casts it: the preload sources, the harness
 * tools, the hub tools and each note it loads with the reason.
 */
export const runContext = (
  notes: Note[],
  {
    bot,
    skill,
    step = {},
  }: { bot: Bot; skill?: Pick<Skill, 'notes'> | undefined; step?: Pick<Job, 'preload' | 'tools' | 'paths'> }
) => {
  const preload = effectivePreload(bot, step);
  const query = { kinds: [...(bot.notes ?? []), ...(skill?.notes ?? [])], paths: step.paths };
  return {
    preload,
    harnessTools: harnessTools(bot),
    hubTools: effectiveTools(bot, step),
    notes: preload.includes('notes')
      ? notes.flatMap(note => {
          const why = noteReason(note, query);
          return why ? [{ note, why }] : [];
        })
      : [],
  };
};

/** The notes section of a system prompt, grouped by kind. */
export const renderNotes = (notes: Note[]) => {
  const groups = NoteKind.options.flatMap(kind => {
    const group = notes.filter(n => n.kind === kind);
    return group.length ? [[`### ${kind}`, ...group.map(n => `#### ${n.title}\n\n${n.body}`)].join('\n\n')] : [];
  });
  return groups.length
    ? ['## Notes', 'What this hub knows. Read-only; follow them.', ...groups].join('\n\n')
    : undefined;
};

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
    const asked = await issues.list({ parent: issue.number, label: roles.unsure, state: 'all' });
    const questions = (await Promise.all(asked.map(q => issues.get(q.number)))).filter(q => q !== undefined);
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
