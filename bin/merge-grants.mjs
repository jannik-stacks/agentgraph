import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = process.argv[2] ?? 'examples';
const found = readdirSync(root, { recursive: true })
  .filter(path => /(^|\/)(agents|workflows)\/[^/]+\.md$/.test(path))
  .flatMap(path => {
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    const end = lines.indexOf('---', 1);
    if (lines[0] !== '---' || end < 0) return [];
    const front = parse(lines.slice(1, end).join('\n'));
    const grants = /(^|\/)agents\//.test(path)
      ? front?.returns?.includes('merge')
        ? [['returns', 'an agent may return merge']]
        : []
      : Object.entries(front?.steps ?? {}).flatMap(([name, step]) =>
          step?.returns?.includes('merge') ? [[name, `step ${name} may return merge`]] : []
        );
    return grants.map(([key, what]) => {
      const from = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*:`).test(line));
      const line = lines.findIndex((text, i) => i >= from && /\breturns\b.*\bmerge\b|^\s*-\s*merge\b/.test(text)) + 1;
      return `${join(root, path)}:${line}: ${what}; only a human merges`;
    });
  });
for (const f of found) console.error(f);
process.exit(found.length ? 1 : 0);
