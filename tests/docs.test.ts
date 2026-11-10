import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCodeBlocks, findHeadings } from '../bin/markdown.ts';
import { Run } from '../src/types.ts';

const root = join(import.meta.dirname, '..');
const content = join(root, 'docs');

const pages = () => (readdirSync(content, { recursive: true }) as string[]).filter(p => p.endsWith('.md')).sort();

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes, repeats numbered. */
const anchors = (file: string) => {
  const seen = new Map<string, number>();
  return new Set(
    findHeadings(readFileSync(file, 'utf8')).map(({ text }) => {
      const slug = text
        .trim()
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
    expect(checked).toBeGreaterThan(10);
    expect(broken).toEqual([]);
  });

  it('closes every code block and keeps code anchors out of them', () => {
    const problems = pages().flatMap(page => {
      return findCodeBlocks(readFileSync(join(content, page), 'utf8')).flatMap(b => [
        ...(b.closed ? [] : [`${page}:${b.from}: the code block never closes`]),
        ...(b.value.includes('<!-- code:') ? [`${page}:${b.from}: a code anchor inside a code block`] : []),
      ]);
    });
    expect(problems).toEqual([]);
  });

  it('shows the plugin example as the typechecked fixture', () => {
    const [example] = findCodeBlocks(readFileSync(join(content, 'plugins.md'), 'utf8'));
    expect(`${example!.value}\n`).toBe(readFileSync(join(root, 'tests/fixtures/docs/plugins.ts'), 'utf8'));
  });

  it('documents every run.json field', () => {
    const text = readFileSync(join(content, 'runs.md'), 'utf8');
    const table = text.slice(text.indexOf('## run.json'), text.indexOf('## Imported runs'));
    const named = new Set(
      [...table.matchAll(/^\| ([^|]+)\|/gm)].flatMap(m => [...m[1]!.matchAll(/`(\w+)`/g)].map(n => n[1]))
    );
    expect(Object.keys(Run.fields).filter(field => !named.has(field))).toEqual([]);
  });

  it('repeats only the current commit check and real field values in the written rules', () => {
    const literals = new Set(
      (readdirSync(join(root, 'src'), { recursive: true }) as string[])
        .filter(f => f.endsWith('.ts'))
        .flatMap(f => [
          ...readFileSync(join(root, 'src', f), 'utf8').matchAll(/(\w+):[^:\n]*?Schema\.Literals\(\[([^\]]*)\]/g),
        ])
        .map(m => `${m[1]}: ${[...m[2]!.matchAll(/'([\w-]+)'/g)].map(v => v[1]).join(' | ')}`)
    );
    const problems = ['AGENTS.md', 'STYLE.md', 'README.md', ...pages().map(p => `docs/${p}`)].flatMap(path => {
      const text = readFileSync(join(root, path), 'utf8');
      return [
        ...[...text.matchAll(/`npm run check`[^.]*before (?:a|every) commit/g)].map(
          () => `${path}: the full check runs once per branch`
        ),
        ...[...text.matchAll(/`(\w+: [\w-]+(?: \| [\w-]+)+)`/g)]
          .filter(m => !literals.has(m[1]!))
          .map(m => `${path}: ${m[1]} is no field and values in src/`),
      ];
    });
    expect(literals.has('session: fresh | same')).toBe(true);
    expect(problems).toEqual([]);
  });
});
