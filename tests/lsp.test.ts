import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tmp } from './fixtures.ts';

const cli = join(import.meta.dirname, '..', 'bin', 'lsp.ts');
const dir = tmp('lsp');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const files = {
  'tsconfig.json': '{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["*.ts"] }\n',
  'a.ts': 'export const helper = (n: number) => n + 1;\nexport const twice = (n: number) => helper(helper(n));\n',
  'b.ts': "import { helper } from './a';\nexport const three = helper(2);\nconst local = 1;\n",
  'c.ts': 'const local = 2;\nexport const four = local + 2;\n',
};
const reset = () => {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
};
const lsp = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args, '--timeout', '30'], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim().split('\n').filter(Boolean), err: r.stderr };
};
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

describe('bin/lsp.ts', () => {
  it('lists references across files', () => {
    reset();
    const { code, out } = lsp('refs', 'a.ts:1:14');
    expect(code).toBe(0);
    expect(out.sort()).toEqual(['a.ts:1:14', 'a.ts:2:37', 'a.ts:2:44', 'b.ts:1:10', 'b.ts:2:22'].sort());
  });

  it('prints the edits of a dry rename and changes nothing', () => {
    reset();
    const { code, out } = lsp('rename', 'a.ts:1:14', 'bump', '--dry');
    expect(code).toBe(0);
    expect(out).toHaveLength(5);
    expect(read('a.ts')).toBe(files['a.ts']);
  });

  it('renames a symbol found by name in every file', () => {
    reset();
    const { code, out } = lsp('rename-symbol', 'helper', 'bump');
    expect(code).toBe(0);
    expect(out.sort()).toEqual(['a.ts', 'b.ts']);
    expect(read('a.ts')).toBe(files['a.ts'].replaceAll('helper', 'bump'));
    expect(read('b.ts')).toBe(files['b.ts'].replaceAll('helper', 'bump'));
  });

  it('refuses an ambiguous name and lists the declarations', () => {
    reset();
    const { code, err } = lsp('rename-symbol', 'local', 'other');
    expect(code).toBe(1);
    expect(err).toContain('2 declarations named "local"');
    expect(read('b.ts')).toBe(files['b.ts']);
  });
});
