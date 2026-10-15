import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const content = join(root, 'docs');

const pages = () => (readdirSync(content, { recursive: true }) as string[]).filter(p => p.endsWith('.md')).sort();

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes, repeats numbered. */
const anchors = (file: string) => {
  const seen = new Map<string, number>();
  const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(m => {
      const slug = m[1]!
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/ /g, '-');
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      return n ? `${slug}-${n}` : slug;
    })
  );
};

describe('docs', () => {
  it('links only to files and headings that exist', () => {
    const broken: string[] = [];
    let checked = 0;
    for (const page of pages()) {
      const text = readFileSync(join(content, page), 'utf8');
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = m[1]!;
        if (/^[a-z]+:/.test(link)) continue;
        const [path, hash] = link.split('#') as [string, string | undefined];
        const at = `${page}:${text.slice(0, m.index).split('\n').length} ${link}`;
        const file = path ? join(content, dirname(page), path) : join(content, page);
        checked++;
        if (!existsSync(file)) broken.push(`${at}: no file`);
        else if (hash && !anchors(file).has(hash)) broken.push(`${at}: no heading #${hash}`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(broken).toEqual([]);
  });
});
