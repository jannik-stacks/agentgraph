import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitFrontmatter } from '../src/workflow.ts';

const root = process.argv[2] ?? 'examples';
const found = readdirSync(root, { recursive: true })
  .filter(path => /(^|\/)(agents|workflows)\/[^/]+\.md$/.test(path))
  .toSorted()
  .flatMap(path => {
    const text = readFileSync(join(root, path), 'utf8');
    const { data } = splitFrontmatter(text);
    const grants = /(^|\/)agents\//.test(path)
      ? data?.returns?.includes('merge')
        ? [['returns', 'an agent may return merge']]
        : []
      : Object.entries(data?.steps ?? {}).flatMap(([name, step]) =>
          step?.returns?.includes('merge') ? [[name, `step ${name} may return merge`]] : []
        );
    const lines = text.split(/\r?\n/);
    return grants.map(([key, what]) => {
      const from = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*:`).test(line));
      const line = lines.findIndex((text, i) => i >= from && /\breturns\b.*\bmerge\b|^\s*-\s*merge\b/.test(text)) + 1;
      return `${join(root, path)}:${line}: ${what}; only a human merges`;
    });
  });
for (const f of found) console.error(f);
process.exit(found.length ? 1 : 0);
