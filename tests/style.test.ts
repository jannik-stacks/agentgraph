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

const config = JSON.stringify({
  jsPlugins: [join(root, 'bin/style.mjs')],
  rules: {
    'style/verb-first': 'error',
    'style/no-of-for': 'error',
    'style/unique-export': 'error',
    'style/retired-word': 'error',
    'style/no-comment': 'error',
  },
});

describe('style lint', () => {
  it('flags a verbless, an xOf, a local, parameter or destructured xOf or xFrom and a shared export name and a retired word, minus the baseline', () => {
    const dir = tmp('style');
    write(dir, {
      '.oxlintrc.json': config,
      'src/a.ts': [
        'export const readGraph = (dir: string) => dir;',
        'export const trees = () => [];',
        'export const graphOf = () => 1;',
        'export const fileForge = () => 1;',
        'export const memoryStore = () => 1;',
        'export const Button = () => null;',
        'export const limits = { files: 1 };',
        'export const plan = () => 1;',
        'export const makeClimb = () => 1;',
        'export type CoreRun = { id: string };',
        'export const isAlive = () => true;',
        'export const makeTimestamp = () => 1;',
        'export type Graph = { dir: string };',
        'export const Graph = 1;',
        'export const readItems = () => { const itemsOf = [1]; return itemsOf; };',
        'export function readNext() { function stepFrom() { return 1; } return stepFrom(); }',
        'export const readKey = (keyOf: () => string) => keyOf();',
        'export const readName = ({ nameFor }: { nameFor: string }) => nameFor;',
      ].join('\n'),
      'src/b.ts': 'export const plan = 2;\n',
      'bin/style-baseline.txt': 'verb-first src/a.ts plan\n',
    });
    expect(lint(dir)).toEqual([
      'error style(no-of-for) graphOf',
      'error style(no-of-for) itemsOf',
      'error style(no-of-for) keyOf',
      'error style(no-of-for) nameFor',
      'error style(no-of-for) stepFrom',
      'error style(retired-word) CoreRun',
      'error style(retired-word) isAlive',
      'error style(retired-word) makeClimb',
      'error style(unique-export) plan',
      'error style(unique-export) plan',
      'error style(verb-first) graphOf',
      'error style(verb-first) memoryStore',
      'error style(verb-first) trees',
    ]);
  });

  it('fails a comment unless it is marked UNEXPECTED, a directive, or within the file baseline', () => {
    const dir = tmp('style');
    write(dir, {
      '.oxlintrc.json': config,
      'src/a.ts': [
        '/** Reads the graph. */',
        'export const readGraph = (dir: string) => dir;',
        '// UNEXPECTED: git answers 1 for a clean diff here',
        '// oxlint-disable-next-line no-unused-vars',
        'const x = 1;',
        '/** @internal */',
        'export const readX = () => x;',
      ].join('\n'),
      'src/b.ts': '// one\n// two\nexport const readB = 1;\n',
      'src/c.ts': '// one\nexport const readC = 1;\n',
      'bin/style-baseline.txt': 'no-comment src/b.ts 1\nno-comment src/c.ts 1\n',
    });
    expect(lint(dir)).toEqual([
      'error style(no-comment) 2 comments, the baseline allows 1',
      'error style(no-comment) comment',
    ]);
  });
});
