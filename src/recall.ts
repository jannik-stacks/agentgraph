import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { Config } from './config.ts';
import { decide as askModel, defaultDecideModel, defaultDecideUrl } from './decide.ts';
import type { Issue } from './issues.ts';
import { type Asker, type Origin, visible, type SummaryRecord } from './summaries.ts';

/**
 * One searchable document: a note, an issue or a run summary. `pointer` says where the full text lives; a run
 * summary's `origin` is the run it comes from, which decides who may recall it.
 */
export type Doc = {
  id: string;
  kind: 'note' | 'issue' | 'summary';
  title: string;
  text: string;
  pointer: string;
  origin?: Origin;
};

const stop = new Set(
  'a an and are as at be but by do does for from has have if in into is it its not of on or so than that the then there these this to was were will with'.split(
    ' '
  )
);

/** A light stemmer: strips the common English inflections so `tests`, `testing` and `tested` meet. */
export const stem = (word: string) => {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('es') && /(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
};

/** Lowercase stemmed terms of `text`; a camelCase or snake_case name also yields its parts. */
export const terms = (text: string) => {
  const out: string[] = [];
  for (const raw of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const parts = raw.split(/_|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
    for (const word of parts.length > 1 ? [raw, ...parts] : [raw]) {
      const lower = word.toLowerCase();
      if (lower.length > 1 && !stop.has(lower)) out.push(stem(lower));
    }
  }
  return out;
};

/** Groups of words that mean the same here, as read from a hub's `synonyms.yaml` (a list of lists). */
export type Synonyms = Map<string, string[]>;

export const synonyms = (groups: string[][]): Synonyms => {
  const map: Synonyms = new Map();
  for (const group of groups) {
    const words = [...new Set(group.flatMap(terms))];
    for (const word of words) map.set(word, [...new Set([...(map.get(word) ?? []), ...words.filter(w => w !== word)])]);
  }
  return map;
};

/** Reads `synonyms.yaml`; a missing file means no synonyms. */
export const loadSynonyms = async (file: string) => {
  try {
    return synonyms((parse(await readFile(file, 'utf8')) ?? []) as string[][]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return synonyms([]);
    throw e;
  }
};

const k1 = 1.2;
const b = 0.75;
const titleWeight = 2;
const synonymWeight = 0.5;

/** A BM25 index over `docs`. Titles count twice. */
export const index = (docs: Doc[], words: Synonyms = new Map()) => {
  const postings = new Map<string, number[]>();
  const lengths = new Float64Array(docs.length);
  docs.forEach((doc, i) => {
    const counts = new Map<string, number>();
    const add = (t: string, n: number) => counts.set(t, (counts.get(t) ?? 0) + n);
    for (const t of terms(doc.title)) add(t, titleWeight);
    for (const t of terms(doc.text)) add(t, 1);
    let length = 0;
    for (const [t, n] of counts) {
      length += n;
      const list = postings.get(t) ?? [];
      list.push(i, n);
      postings.set(t, list);
    }
    lengths[i] = length;
  });
  const average = lengths.reduce((s, n) => s + n, 0) / (docs.length || 1);

  /** The best `limit` documents for `query` with their scores, optionally only those `keep` accepts. */
  const search = (query: string, { limit = 20, keep }: { limit?: number; keep?: (doc: Doc) => boolean } = {}) => {
    const weights = new Map<string, number>();
    for (const t of terms(query)) {
      weights.set(t, 1);
      for (const s of words.get(t) ?? []) if (!weights.has(s)) weights.set(s, synonymWeight);
    }
    const scores = new Float64Array(docs.length);
    for (const [t, weight] of weights) {
      const list = postings.get(t);
      if (!list) continue;
      const df = list.length / 2;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      for (let j = 0; j < list.length; j += 2) {
        const i = list[j]!;
        const tf = list[j + 1]!;
        scores[i]! += weight * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * lengths[i]!) / average)));
      }
    }
    const hits: { doc: Doc; score: number }[] = [];
    scores.forEach((score, i) => {
      if (score > 0 && (!keep || keep(docs[i]!))) hits.push({ doc: docs[i]!, score });
    });
    return hits.sort((x, y) => y.score - x.score).slice(0, limit);
  };

  return { size: docs.length, search };
};
export type Index = ReturnType<typeof index>;

/** Accepted and proposed hub notes as documents. */
export const noteDocs = (notes: Config['notes']): Doc[] =>
  notes.map(n => ({
    id: `note:${n.kind}/${n.name}`,
    kind: 'note',
    title: n.title,
    text: `${n.kind}\n${n.body}`,
    pointer: `notes/${n.kind}/${n.name}.md`,
  }));

/** Issues with their comments as documents. */
export const issueDocs = (issues: Issue[]): Doc[] =>
  issues.map(i => ({
    id: `issue:${i.number}`,
    kind: 'issue',
    title: `#${i.number} ${i.title}`,
    text: [i.body, ...i.comments.map(c => c.body)].join('\n\n'),
    pointer: i.url ?? `#${i.number}`,
  }));

/** Run summaries as documents; the pointer is `<run>#<from>-<to>`, the events they stand for. */
export const summaryDocs = (records: (SummaryRecord & { origin: Origin })[]): Doc[] =>
  records.map(r => ({
    id: `summary:${r.id}`,
    kind: 'summary',
    title: r.kind,
    text: r.line,
    pointer: `${r.run}#${r.from}-${r.to}`,
    origin: r.origin,
  }));

/** Whether `asker` may recall `doc`. Notes and issues are hub-wide; run summaries follow the asker's `history`. */
export const allowedFor = (asker: Asker | undefined) => (doc: Doc) =>
  doc.kind !== 'summary' || (asker !== undefined && visible(asker, doc.origin ?? {}));

/** The decision call recall uses; `decide` from decide.ts fits. */
export type DecideFn = typeof askModel;

const estimateTokens = (text: string) => Math.ceil(text.length / 3.6);
const maxTask = 4000;
const maxCandidate = 1200;

export type Recalled = { doc: Doc; score: number; p?: number };

/** What became of a candidate: kept, below the cutoff, or over the token budget. */
export type Weighed = Recalled & { fate: 'kept' | 'cutoff' | 'budget' };

/**
 * Every candidate recall considers for `task`, with its fate: BM25 picks the `top` candidates the asking bot may
 * see, then the decision model keeps those it judges relevant at or above `cutoff`, best first, until `budget` tokens
 * are used. Without a reachable decision model the BM25 order is kept and `error` says why.
 */
export const weigh = async ({
  index: idx,
  task,
  query = task,
  asker,
  top = 20,
  cutoff = 0.7,
  budget = 2000,
  decide = askModel,
  url = defaultDecideUrl,
  model = defaultDecideModel,
}: {
  index: Index;
  task: string;
  query?: string;
  asker?: Asker;
  top?: number;
  cutoff?: number;
  budget?: number;
  decide?: DecideFn;
  url?: string;
  model?: string;
}): Promise<{ weighed: Weighed[]; error?: string }> => {
  const candidates = idx.search(query, { limit: Math.min(top, 64), keep: allowedFor(asker) });
  if (!candidates.length) return { weighed: [] };
  let ranked: Recalled[];
  const below: Weighed[] = [];
  let error: string | undefined;
  try {
    const answers = await decide({
      url,
      model,
      state: `Task:\n${task.slice(0, maxTask)}`,
      questions: Object.fromEntries(
        candidates.map(({ doc }, i) => [
          `c${i}`,
          {
            type: 'noul' as const,
            instructions: `Would this ${doc.kind} help an agent doing the task?\n${doc.title}\n${doc.text.slice(0, maxCandidate)}`,
          },
        ])
      ),
    });
    const judged = candidates.map((c, i) => ({ ...c, p: answers[`c${i}`]!.noul }));
    ranked = judged.filter(c => c.p >= cutoff).sort((x, y) => y.p - x.p);
    below.push(...judged.filter(c => c.p < cutoff).map(c => ({ ...c, fate: 'cutoff' as const })));
  } catch (e) {
    ranked = candidates;
    error = (e as Error).message;
  }
  const weighed: Weighed[] = [];
  let used = 0;
  for (const hit of ranked) {
    const cost = estimateTokens(`${hit.doc.title}\n${hit.doc.text}`);
    const fits = used + cost <= budget;
    if (fits) used += cost;
    weighed.push({ ...hit, fate: fits ? 'kept' : 'budget' });
  }
  return { weighed: [...weighed, ...below], ...(error !== undefined && { error }) };
};

/** The candidates `weigh` keeps, best first. */
export const recall = async (options: Parameters<typeof weigh>[0]): Promise<Recalled[]> =>
  (await weigh(options)).weighed.filter(w => w.fate === 'kept').map(({ fate: _, ...hit }) => hit);
