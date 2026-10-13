import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

type Plugin = { buildStart: (this: { error: (message: string) => never }) => Promise<void> };
type BothubCode = (options: { root: string; content: string }) => Plugin;
type Slugger = new () => { slug: (text: string) => string };

const content = join(studioDir, 'content', 'docs');
const root = join(studioDir, '..');

/** Runs the docs build's reference check: resolves every `<Source>`, `<Sym>` and `<Fields>` against the source. */
const checkReferences = async (dir: string, from = root) => {
  const { bothubCode } = await studioModule<{ bothubCode: BothubCode }>('code/plugin.ts');
  const plugin = bothubCode({ root: from, content: dir });
  await plugin.buildStart.call({
    error: message => {
      throw new Error(message);
    },
  });
};

const pages = () => (readdirSync(content, { recursive: true }) as string[]).filter(p => p.endsWith('.mdx')).sort();

/** The page a `/docs/...` path names, as a file under the content directory. */
const pageFile = (path: string) => {
  const slug = path.replace(/^\/docs\/?/, '').replace(/\/$/, '');
  return [`${slug}.mdx`, join(slug, 'index.mdx')].map(p => join(content, p)).find(existsSync);
};

const anchors = async (file: string) => {
  const { default: Slugger } = (await import(
    /* @vite-ignore */ join(studioDir, 'node_modules', 'github-slugger', 'index.js')
  )) as { default: Slugger };
  const slugger = new Slugger();
  const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(m => {
      const custom = /\[#([\w-]+)\]$/.exec(m[1]!);
      return custom ? custom[1]! : slugger.slug(m[1]!.replace(/`/g, ''));
    })
  );
};

describe('docs', () => {
  it('resolves every source reference in the docs', async () => {
    await expect(checkReferences(content)).resolves.toBeUndefined();
  });

  it('loads every zod schema module the docs reference for its field tables', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await checkReferences(content);
      expect(warn.mock.calls.flat().filter(text => String(text).includes('could not load'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('fails on a reference to a name several files export, or that no file has', async () => {
    const from = mkdtempSync(join(tmpdir(), 'bothub-docs-root-'));
    mkdirSync(join(from, 'src'));
    for (const file of ['package.json', 'tsconfig.json']) writeFileSync(join(from, file), '{}\n');
    writeFileSync(join(from, 'src', 'config.ts'), 'export type Validated = { ok: true };\n');
    writeFileSync(join(from, 'src', 'hub-files.ts'), 'export type Validated = { ok: boolean };\n');
    const dir = mkdtempSync(join(tmpdir(), 'bothub-docs-'));
    writeFileSync(
      join(dir, 'page.mdx'),
      '<Fields name="Validated" />\n<Sym name="Gone" />\n<Sym name="x" file="src/nope.ts" />\n'
    );
    const error = await checkReferences(dir, from).then(
      () => undefined,
      (e: Error) => e.message
    );
    expect(error).toMatch(/page\.mdx:1 <Fields>: Validated is exported by several files/);
    expect(error).toMatch(/page\.mdx:2 <Sym>: no symbol Gone/);
    expect(error).toMatch(/page\.mdx:3 <Sym>: no source file src\/nope\.ts/);
  });

  it('links only to pages and headings that exist', async () => {
    const broken: string[] = [];
    let checked = 0;
    for (const page of pages()) {
      const text = readFileSync(join(content, page), 'utf8');
      for (const m of text.matchAll(/\]\((\/docs[^)\s]*)\)|href=["'](\/docs[^"']*)["']/g)) {
        const [path, hash] = (m[1] ?? m[2]!).split('#') as [string, string | undefined];
        const at = `${page}:${text.slice(0, m.index).split('\n').length} ${m[1] ?? m[2]}`;
        const file = pageFile(path);
        checked++;
        if (!file) broken.push(`${at}: no page`);
        else if (hash && !(await anchors(file)).has(hash)) broken.push(`${at}: no heading #${hash}`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(broken).toEqual([]);
  });

  it('lists every page in a meta.json, and every meta.json entry is a page', () => {
    const problems: string[] = [];
    const listed = new Set<string>();
    for (const meta of (readdirSync(content, { recursive: true }) as string[]).filter(p => p.endsWith('meta.json'))) {
      const dir = join(content, meta, '..');
      const { pages: entries = [] } = JSON.parse(readFileSync(join(content, meta), 'utf8')) as { pages?: string[] };
      for (const entry of entries) {
        if (entry.startsWith('---') || entry === '...') continue;
        const file = [`${entry}.mdx`, join(entry, 'index.mdx')].map(p => join(dir, p)).find(existsSync);
        if (!file) problems.push(`${meta}: "${entry}" is not a page`);
        else listed.add(relative(content, file));
        if (existsSync(join(dir, entry, 'index.mdx'))) listed.add(relative(content, join(dir, entry, 'index.mdx')));
      }
    }
    for (const page of pages())
      if (!listed.has(page) && !page.endsWith('index.mdx')) problems.push(`${page} is in no meta.json`);
    expect(problems).toEqual([]);
  });
});
