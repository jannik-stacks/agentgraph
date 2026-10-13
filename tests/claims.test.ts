import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, temp } from './kit.ts';

const script = resolve(import.meta.dirname, '../examples/acme-app/scripts/claims/extract.mjs');
const fixtures = resolve(import.meta.dirname, 'fixtures/claims');

type Claim = {
  id: string;
  file: string;
  line: number;
  end: number;
  kind: string;
  section: string;
  sentence: string;
  symbols: { name: string; at: string[] }[];
  values: string[];
  before: string[];
  after: string[];
};

const run = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(process.execPath, [script, '--kit', 'kit/src', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    claims: result.stdout
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Claim),
  };
};

const extract = (file: string, ...args: string[]) => run(fixtures, [...args, `docs/${file}`]).claims;

const copy = () => {
  const dir = temp('claims');
  cpSync(fixtures, dir, { recursive: true });
  return dir;
};

describe('claims extractor', () => {
  it('finds claims in prose, list items and wrapper children, and nothing in fences, JSX props or frontmatter', () => {
    const prose = extract('signing.mdx').filter(c => c.kind !== 'example');
    expect(prose.map(c => c.line)).toEqual([16, 34, 39, 42, 44, 46, 55, 61]);
    const text = prose.map(c => c.sentence).join('\n');
    expect(text).not.toContain('Sighash returns the digest');
    expect(text).not.toContain('always throws');
    expect(text).not.toContain('returns a new tx');
    expect(text).not.toContain('<Cite');
  });

  it('skips questions, hedged sentences, proposed examples and examples that import another library', () => {
    const claims = extract('signing.mdx');
    expect(claims.filter(c => c.kind === 'example').map(c => [c.line, c.end])).toEqual([
      [9, 13],
      [23, 25],
    ]);
    expect(claims.find(c => c.line === 48 || c.line === 50)).toBeUndefined();
  });

  it('resolves namespace members, interface members and bare camel-case names to their declarations', () => {
    const at = (line: number) =>
      Object.fromEntries(
        extract('signing.mdx')
          .find(c => c.line === line)!
          .symbols.map(s => [s.name, s.at])
      );
    expect(at(16)).toEqual({ 'Tx.sighash': ['kit/src/signing.ts:4'] });
    expect(at(46)).toEqual({ 'client.broadcast': ['kit/src/client.ts:7'] });
    expect(at(34)).toEqual({ signAsSponsor: ['kit/src/signing.ts:16'] });
    expect(at(61)).toEqual({ merge: ['kit/src/signing.ts:31'], finalize: ['kit/src/signing.ts:25'] });
  });

  it('classifies each claim by its strongest assertion and keeps asserted values', () => {
    const claims = extract('signing.mdx');
    const kinds = Object.fromEntries(claims.map(c => [c.line, c.kind]));
    expect(kinds).toMatchObject({
      9: 'example',
      34: 'constraint',
      39: 'returns',
      42: 'throws',
      44: 'default',
      46: 'returns',
    });
    expect(claims.find(c => c.line === 46)!.values).toEqual(['32-byte']);
    expect(claims.find(c => c.line === 42)!.section).toBe('finalize');
    expect(claims.find(c => c.line === 9)!.values).toContain('32-byte hex');
  });

  it('keeps ids stable across runs and across edits to other sentences', () => {
    const first = extract('signing.mdx');
    expect(extract('signing.mdx')).toEqual(first);

    const dir = copy();
    const path = join(dir, 'docs/signing.mdx');
    const edited = readFileSync(path, 'utf8')
      .replace('## The two primitives\n', '## The two primitives\n\nAn unrelated new paragraph.\n\nAnd another one.\n')
      .replace('returns a fresh draft', 'returns a new draft');
    writeFileSync(path, edited);
    const after = run(dir, ['docs/signing.mdx']).claims;

    const byId = new Map(after.map(c => [c.id, c]));
    const kept = first.filter(c => c.line !== 55);
    for (const claim of kept) expect(byId.get(claim.id)?.line).toBe(claim.line + 4);
    const changed = after.find(c => c.sentence.includes('a new draft'))!;
    expect(first.map(c => c.id)).not.toContain(changed.id);
  });

  it('clips context windows at the start and end of the file', () => {
    const [top, bottom] = extract('edges.mdx', '-C', '3');
    expect(top!.before).toEqual([]);
    expect(top!.after).toEqual(['', 'Some prose in between that names nothing.', '']);
    expect(bottom!.before).toEqual(['', 'Some prose in between that names nothing.', '']);
    expect(bottom!.after).toEqual(['']);
  });

  it('lets -C override -A and -B, and uses -A and -B on their own otherwise', () => {
    const [, bottom] = extract('edges.mdx', '-A', '0', '-B', '0', '-C', '1');
    expect([bottom!.before, bottom!.after]).toEqual([[''], ['']]);
    const [top, last] = extract('edges.mdx', '-B', '4', '-A', '0');
    expect(top!.before).toEqual([]);
    expect(last!.before).toEqual([
      '`sighash` returns the digest the next signer signs.',
      '',
      'Some prose in between that names nothing.',
      '',
    ]);
    expect(last!.after).toEqual([]);
  });

  it('rejects a context size that is not a whole number', () => {
    const result = run(fixtures, ['-C', 'two', 'docs/edges.mdx']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('context size must be a whole number');
  });

  it('with --changed, keeps claims on added lines and claims naming an export whose code changed, not its comments', () => {
    const dir = copy();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');

    const doc = join(dir, 'docs/signing.mdx');
    writeFileSync(doc, readFileSync(doc, 'utf8').replace('accepts the 32-byte transaction', 'accepts the transaction'));
    const code = join(dir, 'kit/src/signing.ts');
    writeFileSync(
      code,
      readFileSync(code, 'utf8')
        .replace('({ ...partials[0] })', '({ ...partials.at(-1) })')
        .replace(
          'export const sighash = (tx: Transaction): string => {\n',
          '$&  // keys are sorted by insertion order\n'
        )
    );

    const { claims } = run(dir, ['--changed', 'docs/*.mdx'], { BOTHUB_BASE: base });
    expect(claims.map(c => `${c.file}:${c.line}`)).toEqual([
      'docs/signing.mdx:46',
      'docs/signing.mdx:55',
      'docs/signing.mdx:61',
    ]);
  });
});
