// Fails when a `code: path#symbol` ref in docs/*.md points at a missing file or an undeclared symbol.
// Usage: node bin/refs.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const docs = join(root, 'docs');
const ref = /code: ([\w./-]+)#([\w$]+)/g;
const declared = (text, name) =>
  new RegExp(
    `^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(const|let|var|function\\*?|class|type|interface|enum)\\s+${name.replace(/\$/g, '\\$')}\\b`,
    'm'
  ).test(text);

const bad = [];
let count = 0;
for (const doc of readdirSync(docs).filter(f => f.endsWith('.md'))) {
  for (const [, file, name] of readFileSync(join(docs, doc), 'utf8').matchAll(ref)) {
    count++;
    const path = join(root, file);
    if (!existsSync(path)) bad.push(`docs/${doc}: ${file} does not exist`);
    else if (!declared(readFileSync(path, 'utf8'), name)) bad.push(`docs/${doc}: ${name} is not declared in ${file}`);
  }
}
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log(`${count} code refs ok`);
