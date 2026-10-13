export type Kind = 'add' | 'del' | 'ctx';
export type Line = { kind: Kind; text: string; old?: number; new?: number };
export type Hunk = { header: string; lines: Line[] };

/** A half-open range of character offsets in a line. */
export type Span = [start: number, end: number];

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The hunks of a unified patch, each line with its old and new line number. */
export const hunksOf = (patch: string): Hunk[] => {
  const hunks: Hunk[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const header = hunkHeader.exec(raw);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunks.push({ header: raw, lines: [] });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk || raw.startsWith('\\')) continue;
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') hunk.lines.push({ kind: 'add', text, new: newNo++ });
    else if (sign === '-') hunk.lines.push({ kind: 'del', text, old: oldNo++ });
    else hunk.lines.push({ kind: 'ctx', text, old: oldNo++, new: newNo++ });
  }
  return hunks;
};

/**
 * Removed lines paired with the added lines that replace them: each run of removed lines is matched, line by line, to
 * the run of added lines right after it. Answers each paired line's index with its partner's.
 */
export const pairLines = (lines: Pick<Line, 'kind'>[]) => {
  const partner = new Map<number, number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const dels = i;
    while (i < lines.length && lines[i]!.kind === 'del') i++;
    const adds = i;
    while (i < lines.length && lines[i]!.kind === 'add') i++;
    const pairs = Math.min(adds - dels, i - adds);
    for (let k = 0; k < pairs; k++) {
      partner.set(dels + k, adds + k);
      partner.set(adds + k, dels + k);
    }
  }
  return partner;
};

/** Below this share of unchanged text, a pair of lines counts as rewritten and nothing in it is emphasized. */
export const minSimilarity = 0.4;

/**
 * The changed part of a removed line `a` and the added line `b` that replaces it, as spans in each, or undefined when
 * the lines are too dissimilar to be worth emphasizing. The unchanged part is what the two lines share at their start
 * and end.
 */
export const changedSpans = (a: string, b: string): { del: Span[]; add: Span[] } | undefined => {
  if (a === b) return { del: [], add: [] };
  const shorter = Math.min(a.length, b.length);
  let start = 0;
  while (start < shorter && a[start] === b[start]) start++;
  let end = 0;
  while (end < shorter - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const unchanged = start + end;
  if ((2 * unchanged) / (a.length + b.length) < minSimilarity) return;
  const span = (text: string): Span[] => (start < text.length - end ? [[start, text.length - end]] : []);
  return { del: span(a), add: span(b) };
};

/** The on-screen column of offset `index` in `text`, with tabs stopping every `tab` columns. */
export const columnOf = (text: string, index: number, tab = 4) => {
  let column = 0;
  for (let i = 0; i < index && i < text.length; i++)
    column = text[i] === '\t' ? column + tab - (column % tab) : column + 1;
  return column;
};

/** For each line of a hunk, the column ranges to emphasize, keyed by line index. */
export const emphasisOf = (lines: Line[], tab = 4) => {
  const ranges = new Map<number, Span[]>();
  for (const [index, other] of pairLines(lines)) {
    const line = lines[index]!;
    if (line.kind !== 'del') continue;
    const spans = changedSpans(line.text, lines[other]!.text);
    if (!spans) continue;
    const columns = (text: string, list: Span[]) =>
      list.map(([s, e]): Span => [columnOf(text, s, tab), columnOf(text, e, tab)]);
    ranges.set(index, columns(line.text, spans.del));
    ranges.set(other, columns(lines[other]!.text, spans.add));
  }
  return ranges;
};
