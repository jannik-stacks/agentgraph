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

/** Below this share of unchanged text, a pair of lines counts as rewritten and nothing in it is emphasized. */
export const minSimilarity = 0.3;

/** Lines whose token comparison table would be larger than this are not compared. */
const maxCells = 250_000;

/** Uneven runs of removed and added lines with more pairings than this to weigh are paired by position. */
const maxAlignment = 400;

type Token = { text: string; start: number; end: number };

const tokenPattern = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** A line as words, whitespace runs and single punctuation characters. */
const tokensOf = (line: string): Token[] =>
  Array.from(line.matchAll(tokenPattern), m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));

const isSpace = (token: Token) => /^\s/.test(token.text);

/**
 * Which tokens of `a` and of `b` are outside their longest common subsequence, weighing each token by its length so
 * long shared words win over scattered punctuation.
 */
const changedTokens = (a: Token[], b: Token[]) => {
  const width = b.length + 1;
  const best = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => best[i * width + j]!;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      const skip = Math.max(at(i + 1, j), at(i, j + 1));
      const take = a[i]!.text === b[j]!.text ? at(i + 1, j + 1) + a[i]!.text.length : 0;
      best[i * width + j] = Math.max(skip, take);
    }
  const changedA = a.map(() => true);
  const changedB = b.map(() => true);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.text === b[j]!.text && at(i, j) === at(i + 1, j + 1) + a[i]!.text.length) {
      changedA[i++] = false;
      changedB[j++] = false;
    } else if (at(i, j) === at(i + 1, j)) i++;
    else j++;
  }
  return [changedA, changedB] as const;
};

/**
 * The changed tokens as spans, joining two changes that only a single whitespace token separates. Whitespace at the
 * start or end of the line is never marked, so re-indenting a line does not light it up.
 */
const spansOf = (tokens: Token[], changed: boolean[]) => {
  const spans: Span[] = [];
  const edge = (k: number) => (k === 0 || k === tokens.length - 1) && isSpace(tokens[k]!);
  let previous = -2;
  tokens.forEach((token, k) => {
    if (!changed[k] || edge(k)) return;
    const last = spans.at(-1);
    if (last && (previous === k - 1 || (previous === k - 2 && isSpace(tokens[k - 1]!)))) last[1] = token.end;
    else spans.push([token.start, token.end]);
    previous = k;
  });
  return spans;
};

const visibleLength = (tokens: Token[], keep: (k: number) => boolean) =>
  tokens.reduce((sum, token, k) => (keep(k) && !isSpace(token) ? sum + token.text.length : sum), 0);

/**
 * How lines `a` and `b` differ word by word: the share of their non-whitespace text they have in common, and the
 * changed spans in each. Undefined when the lines are too long to compare.
 */
const compare = (a: string, b: string) => {
  const tokensA = tokensOf(a);
  const tokensB = tokensOf(b);
  if ((tokensA.length + 1) * (tokensB.length + 1) > maxCells) return;
  const [changedA, changedB] = changedTokens(tokensA, tokensB);
  const shared = visibleLength(tokensA, k => !changedA[k]);
  const total = visibleLength(tokensA, () => true) + visibleLength(tokensB, () => true);
  return {
    similarity: total ? (2 * shared) / total : 1,
    del: spansOf(tokensA, changedA),
    add: spansOf(tokensB, changedB),
  };
};

const similarityOf = (a: string, b: string) => (a === b ? 1 : (compare(a, b)?.similarity ?? 0));

/**
 * The best order-keeping pairing of removed lines with added lines: the pairs, as offsets into each run, whose summed
 * similarity is highest, leaving out pairs below the cutoff.
 */
const alignRuns = (dels: string[], adds: string[]) => {
  const width = adds.length + 1;
  const similar = dels.map(a => adds.map(b => similarityOf(a, b)));
  const best = new Float64Array((dels.length + 1) * width);
  const at = (i: number, j: number) => best[i * width + j]!;
  const gain = (i: number, j: number) => (similar[i]![j]! >= minSimilarity ? similar[i]![j]! : -Infinity);
  for (let i = dels.length - 1; i >= 0; i--)
    for (let j = adds.length - 1; j >= 0; j--)
      best[i * width + j] = Math.max(at(i + 1, j), at(i, j + 1), at(i + 1, j + 1) + gain(i, j));
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < dels.length && j < adds.length) {
    if (at(i, j) === at(i + 1, j + 1) + gain(i, j)) pairs.push([i++, j++]);
    else if (at(i, j) === at(i + 1, j)) i++;
    else j++;
  }
  return pairs;
};

/**
 * Removed lines paired with the added lines that replace them, within each run of removed lines and the run of added
 * lines right after it. Runs of equal length pair line by line; uneven runs pair each line with its most similar
 * counterpart, keeping their order, or by position when the runs are too long to weigh. Answers each paired line's
 * index with its partner's.
 */
export const pairLines = (lines: Pick<Line, 'kind' | 'text'>[]) => {
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
    const removed = adds - dels;
    const added = i - adds;
    const texts = (from: number, count: number) => lines.slice(from, from + count).map(l => l.text);
    const pairs =
      removed !== added && removed * added <= maxAlignment
        ? alignRuns(texts(dels, removed), texts(adds, added))
        : Array.from({ length: Math.min(removed, added) }, (_, k): [number, number] => [k, k]);
    for (const [d, a] of pairs) {
      partner.set(dels + d, adds + a);
      partner.set(adds + a, dels + d);
    }
  }
  return partner;
};

/**
 * The changed words of a removed line `a` and the added line `b` that replaces it, as spans in each, or undefined when
 * the lines are too dissimilar to be worth emphasizing.
 */
export const changedSpans = (a: string, b: string): { del: Span[]; add: Span[] } | undefined => {
  if (a === b) return { del: [], add: [] };
  const diff = compare(a, b);
  if (!diff || diff.similarity < minSimilarity) return;
  return { del: diff.del, add: diff.add };
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
