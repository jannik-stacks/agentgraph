import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const root = resolve(import.meta.dirname, '..');

const lint = (dir: string) => {
  const { stdout } = spawnSync(process.execPath, [join(root, 'node_modules/oxlint/bin/oxlint'), '-f', 'json', 'src'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const { diagnostics } = JSON.parse(stdout) as { diagnostics: { code: string; message: string; severity: string }[] };
  return diagnostics.map(d => `${d.severity} ${d.code} ${d.message.split(':')[0]}`).sort();
};

describe('names lint', () => {
  it('flags a verbless, an xOf and a shared export name and a retired word, minus the baseline', () => {
    const dir = tmp('names');
    write(dir, {
      '.oxlintrc.json': JSON.stringify({
        jsPlugins: [join(root, 'bin/names.mjs')],
        rules: {
          'names/verb-first': 'error',
          'names/no-of-for': 'error',
          'names/unique-export': 'error',
          'names/retired-word': 'warn',
        },
      }),
      'src/a.ts': [
        'export const readHub = (dir: string) => dir;',
        'export const trees = () => [];',
        'export const graphOf = () => 1;',
        'export const fileForge = () => 1;',
        'export const Button = () => null;',
        'export const limits = { files: 1 };',
        'export const plan = () => 1;',
        'export const makeClimb = () => 1;',
        'export type Hub = { dir: string };',
        'export const Hub = 1;',
      ].join('\n'),
      'src/b.ts': 'export const plan = 2;\n',
      'bin/names-baseline.txt': 'verb-first src/a.ts plan\n',
    });
    expect(lint(dir)).toEqual([
      'error names(no-of-for) graphOf',
      'error names(unique-export) plan',
      'error names(unique-export) plan',
      'error names(verb-first) graphOf',
      'error names(verb-first) trees',
      'warning names(retired-word) makeClimb',
    ]);
  });
});
