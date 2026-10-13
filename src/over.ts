import type { Over } from './schema.ts';

/** One thing a check or job judges: its text, and a label naming it in findings when there are several. */
export type Item = { label: string; text: string };

/** The inputs `over` picks from: the diff of the change, the event's text and a script's output. */
export type OverInputs = { diff: string; event?: string | undefined; output?: string };

/** The lines a diff adds, under the name of each file they land in. */
export const addedLines = (diff: string) => {
  const parts: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) parts.push(`\n${line.replace(/^\+\+\+ (b\/)?/, '')}`);
    else if (line.startsWith('+')) parts.push(line.slice(1));
  }
  return parts.join('\n').trim();
};

const fileOf = (header: string) => /^diff --git a\/.* b\/(.*)$/.exec(header)?.[1] ?? header;

/** A git diff split per file, each part with its own header. */
export const fileDiffs = (diff: string): Item[] =>
  diff
    .split(/^(?=diff --git )/m)
    .filter(part => part.startsWith('diff --git '))
    .map(part => ({ label: fileOf(part.split('\n', 1)[0] ?? ''), text: part.trimEnd() }));

/** A git diff split per hunk, each part with its file's header so it reads on its own. */
export const hunks = (diff: string): Item[] =>
  fileDiffs(diff).flatMap(({ label, text }) => {
    const [head = '', ...parts] = text.split(/^(?=@@ )/m);
    return parts.map(part => ({
      label: `${label} ${/^@@ [^@]* @@/.exec(part)?.[0] ?? ''}`.trim(),
      text: `${head}${part}`.trimEnd(),
    }));
  });

const labelOf = (line: string, index: number) => {
  try {
    const value = JSON.parse(line) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { file, path, line: at } = value as Record<string, unknown>;
      const where = typeof file === 'string' ? file : typeof path === 'string' ? path : undefined;
      if (where) return typeof at === 'number' ? `${where}:${at}` : where;
    }
  } catch {}
  return `item ${index + 1}`;
};

/** The items a script printed: one per non-blank line, JSON or plain text. */
export const scriptItems = (output: string): Item[] =>
  output
    .split('\n')
    .filter(line => line.trim())
    .map((line, i) => ({ label: labelOf(line, i), text: line }));

/**
 * An item's text without what shifts when only the base under it moves: hunk line numbers, a `line` field and blob
 * ids, so the same change judged on another base reads the same.
 */
export const positionless = (text: string) =>
  text
    .replace(/@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/g, '@@ @@')
    .replace(/"line":\d+/g, '"line":0')
    .replace(/index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/g, 'index');

/** How many hunks an `each-hunk` takes and how much code around each it shows, or `undefined` for any other `over`. */
export const hunkOptions = (over: Over | undefined) =>
  over === 'each-hunk' ? { max: 30 } : typeof over === 'object' && 'each-hunk' in over ? over['each-hunk'] : undefined;

/** What a fan-out runs once for, or `undefined` when `over` runs once. */
export const fanOut = (over: Over | undefined) =>
  over === 'each-file'
    ? 'file'
    : hunkOptions(over)
      ? 'hunk'
      : typeof over === 'object' && 'each' in over
        ? 'item'
        : undefined;

/** The items `over` names from its inputs. A script `over` takes its items from `output`. */
export const itemsOf = (over: Over, { diff, event, output = '' }: OverInputs): Item[] => {
  const one = (label: string, text: string) => (text.trim() ? [{ label, text }] : []);
  if (typeof over === 'object')
    return 'each-hunk' in over ? hunks(diff) : 'each' in over ? scriptItems(output) : one('output', output.trim());
  switch (over) {
    case 'diff':
      return one('diff', diff);
    case 'added':
      return one('added lines', addedLines(diff));
    case 'event':
      return one('event', event ?? '');
    case 'each-file':
      return fileDiffs(diff);
    case 'each-hunk':
      return hunks(diff);
  }
};
