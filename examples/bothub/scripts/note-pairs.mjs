// One JSON line per (note, hunk) pair worth judging: each accepted hub note is scored against each hunk hunks.mjs
// prints with BM25, and every hunk keeps its best few notes. Each item carries the note, the hunk and the files the
// change touches, so a judge can tell whether the note applies and whether the change follows it.
//
//   node note-pairs.mjs <root>...      e.g. node note-pairs.mjs src/ studio/src/ tests/
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const perHunk = 2;
const maxPairs = 40;
const maxNote = 1200;
const maxHunk = 2000;

const stop = new Set('the and for that this with from are not but its into when each one any all has have was'.split(' '));
const terms = text =>
  (text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [])
    .flatMap(word => [word, ...word.split(/(?<=[a-z0-9])(?=[A-Z])/)])
    .map(word => word.toLowerCase().replace(/(?<=..)(?:ies|es|s)$/, ''))
    .filter(word => word.length > 2 && !stop.has(word));

/** The accepted notes under `dir`, as `{ id, title, body }`. */
export const notesIn = dir =>
  readdirSync(dir).flatMap(kind =>
    readdirSync(join(dir, kind))
      .filter(name => name.endsWith('.md'))
      .flatMap(name => {
        const [, head = '', body = ''] = readFileSync(join(dir, kind, name), 'utf8').split(/^---$/m);
        if (!/^status: accepted$/m.test(head)) return [];
        const title = /^title: (.*)$/m.exec(head)?.[1] ?? name;
        return [{ id: `${kind}/${name.slice(0, -3)}`, title, body: body.trim() }];
      })
  );

/** The pairs to judge: each hunk's best `perHunk` notes, the best `maxPairs` overall. */
export const pairs = (notes, hunks) => {
  const docs = notes.map(note => {
    const counts = new Map();
    for (const t of [...terms(note.title), ...terms(note.title), ...terms(note.body)]) counts.set(t, (counts.get(t) ?? 0) + 1);
    return { note, counts, length: [...counts.values()].reduce((s, n) => s + n, 0) };
  });
  const average = docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1);
  const idf = t => {
    const df = docs.filter(d => d.counts.has(t)).length;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  };
  const score = (doc, query) =>
    query.reduce((s, t) => {
      const tf = doc.counts.get(t) ?? 0;
      return s + (tf && (idf(t) * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * doc.length) / average)));
    }, 0);
  const files = [...new Set(hunks.map(h => h.file))];
  const found = hunks.flatMap(h => {
    const changed = h.hunk.split('\n').filter(line => /^[+-]/.test(line));
    const query = [...new Set(terms(`${h.file}\n${changed.join('\n')}`))];
    return docs
      .map(doc => ({ h, note: doc.note, score: score(doc, query) }))
      .filter(p => p.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, perHunk);
  });
  return found
    .sort((x, y) => y.score - x.score)
    .slice(0, maxPairs)
    .map(({ h, note }) => ({
      path: `${h.file}:${h.line} ${note.id}`,
      note: `${note.title}\n\n${note.body.slice(0, maxNote)}`,
      hunk: h.hunk.slice(0, maxHunk),
      'files changed': files,
    }));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = process.argv.slice(2);
  if (!roots.length) throw new Error('usage: note-pairs.mjs <root>...');
  const here = dirname(fileURLToPath(import.meta.url));
  const out = execFileSync(process.execPath, [join(here, 'hunks.mjs'), ...roots], { encoding: 'utf8' });
  const hunks = out.split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const pair of pairs(notesIn(join(process.env.BOTHUB_HUB ?? join(here, '..'), 'notes')), hunks))
    console.log(JSON.stringify(pair));
}
