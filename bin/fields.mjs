// Fails when a field of a graph or workflow schema is never read in src. Usage: node bin/fields.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dirname, '..', 'src');
const files = readdirSync(src).filter(f => f.endsWith('.ts'));
const text = Object.fromEntries(files.map(f => [f, readFileSync(join(src, f), 'utf8')]));

/** The text between the bracket at `open` and its match. */
const balanced = (s, open) => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if ('({['.includes(s[i])) depth++;
    if (')}]'.includes(s[i]) && --depth === 0) return [open, i];
  }
  throw new Error('unbalanced');
};

const declared = [];
const reading = {};
for (const [file, s] of Object.entries(text)) {
  let rest = s;
  for (const m of s.matchAll(/Schema\.Struct\(\{/g)) {
    const [from, to] = balanced(s, m.index + m[0].length - 1);
    rest = rest.slice(0, from) + ' '.repeat(to - from + 1) + rest.slice(to + 1);
    if (file !== 'folder.ts' && file !== 'workflow.ts') continue;
    const body = s.slice(from + 1, to);
    let depth = 0;
    let piece = '';
    const pieces = [];
    for (const c of body) {
      if ('({['.includes(c)) depth++;
      if (')}]'.includes(c)) depth--;
      if (c === ',' && depth === 0) {
        pieces.push(piece);
        piece = '';
      } else piece += c;
    }
    pieces.push(piece);
    for (const p of pieces) {
      const key = /^\s*(\w+)\s*:/.exec(p)?.[1];
      if (key) declared.push({ file, key });
    }
  }
  const gone = /const gone = \{/.exec(rest);
  if (gone) {
    const [from, to] = balanced(rest, gone.index + gone[0].length - 1);
    rest = rest.slice(0, from) + rest.slice(to + 1);
  }
  reading[file] = rest;
}

const all = Object.values(reading).join('\n');
const read = key => new RegExp(`\\.${key}\\b|[{,]\\s*${key}\\s*[,}=]|\\['${key}'\\]|\\b${key}\\s*\\(`).test(all);
const unread = declared.filter(({ key }) => !read(key));
for (const { file, key } of unread) console.log(`${file}: schema field ${key} is never read in src`);
process.exit(unread.length ? 1 : 0);
