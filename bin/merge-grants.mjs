import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = process.argv[2] ?? 'examples';
const found = readdirSync(root, { recursive: true })
  .filter(path => /(^|\/)agents\/[^/]+\.md$/.test(path))
  .flatMap(path => {
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    const end = lines.indexOf('---', 1);
    if (lines[0] !== '---' || end < 0 || !parse(lines.slice(1, end).join('\n'))?.returns?.includes('merge')) return [];
    const from = lines.findIndex(line => /^returns\s*:/.test(line));
    const line = lines.findIndex((text, i) => i >= from && /\bmerge\b/.test(text)) + 1;
    return [`${join(root, path)}:${line}: an agent may return merge; only a human merges`];
  });
for (const f of found) console.error(f);
process.exit(found.length ? 1 : 0);
