import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, symlinkSync } from 'node:fs';
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

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 10);

const config = JSON.stringify({
  jsPlugins: [join(root, 'bin/style.mjs')],
  rules: {
    'style/verb-first': 'error',
    'style/no-of-for': 'error',
    'style/unique-export': 'error',
    'style/retired-word': 'error',
    'style/type-suffix': 'error',
    'style/no-comment': 'error',
  },
});

describe('style lint', () => {
  it('flags a verbless, an xOf, a local, parameter or destructured xOf or xFrom and a shared export name and a retired word but not GitHub, minus the baseline', () => {
    const dir = tmp('style');
    write(dir, {
      '.oxlintrc.json': config,
      'src/a.ts': [
        'export const readGraph = (dir: string) => dir;',
        'export const trees = () => [];',
        'export const graphOf = () => 1;',
        'export const folderTracker = () => 1;',
        'export const memoryStore = () => 1;',
        'export const Button = () => null;',
        'export const limits = { files: 1 };',
        'export const plan = () => 1;',
        'export const makeClimb = () => 1;',
        'export type CoreRun = { id: string };',
        'export const isAlive = () => true;',
        'export const readHub = () => 1;',
        'export const isGitHubRef = () => true;',
        'export const makeTimestamp = () => 1;',
        'export type Graph = { dir: string };',
        'export const Graph = 1;',
        'export const readItems = () => { const itemsOf = [1]; return itemsOf; };',
        'export function readNext() { function stepFrom() { return 1; } return stepFrom(); }',
        'export const readKey = (keyOf: () => string) => keyOf();',
        'export const readName = ({ nameFor }: { nameFor: string }) => nameFor;',
        'export const readEnvOfLabels = () => 1;',
        'export const waitForLock = () => 1;',
        'export const waitForLockOfRun = () => 1;',
        'export const outOfRounds = true;',
        'export type EngineConfig = { name: string };',
        'export type SessionOptions = { item: string };',
        'export interface RunIndex { id: string }',
        'export type RunSettings = { id: string };',
      ].join('\n'),
      'src/b.ts': 'export const plan = 2;\n',
      'bin/style-baseline.txt': 'verb-first src/a.ts plan\n',
    });
    expect(lint(dir)).toEqual([
      'error style(no-of-for) graphOf',
      'error style(no-of-for) itemsOf',
      'error style(no-of-for) keyOf',
      'error style(no-of-for) nameFor',
      'error style(no-of-for) outOfRounds',
      'error style(no-of-for) readEnvOfLabels',
      'error style(no-of-for) stepFrom',
      'error style(no-of-for) waitForLockOfRun',
      'error style(retired-word) CoreRun',
      'error style(retired-word) isAlive',
      'error style(retired-word) makeClimb',
      'error style(retired-word) readHub',
      'error style(type-suffix) EngineConfig',
      'error style(type-suffix) RunIndex',
      'error style(type-suffix) SessionOptions',
      'error style(unique-export) plan',
      'error style(unique-export) plan',
      'error style(verb-first) graphOf',
      'error style(verb-first) memoryStore',
      'error style(verb-first) trees',
    ]);
  });

  it('fails a comment unless it is marked UNEXPECTED, a directive, or its text is in the baseline', () => {
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
      'src/b.ts': '// new\n//   kept   one\nexport const readB = 1;\n',
      'src/c.ts': '// same\n// same\nexport const readC = 1;\n',
      'bin/style-baseline.txt': `no-comment src/b.ts ${hash('kept one')}\nno-comment src/c.ts ${hash('same')}\n`,
    });
    expect(lint(dir)).toEqual(
      [
        `error style(no-comment) ${hash('* Reads the graph.')}`,
        `error style(no-comment) ${hash('new')}`,
        `error style(no-comment) ${hash('same')}-2`,
      ].toSorted()
    );
  });

  it('only removes entries on --write and names new violations without adding them', () => {
    const dir = tmp('style');
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    write(dir, {
      '.oxlintrc.json': JSON.stringify({ ...JSON.parse(config), ignorePatterns: ['node_modules/**'] }),
      'src/a.ts': 'export const trees = () => [];\nexport const readA = 1;\n',
      'bin/style-baseline.txt': 'verb-first src/a.ts plan\nverb-first src/a.ts gone\n',
    });
    const run = () =>
      spawnSync(process.execPath, [join(root, 'bin/style.mjs'), '--write'], { cwd: dir, encoding: 'utf8' });
    const { status, stdout } = run();
    expect(stdout).toContain(
      'new, fix it or add a reviewed exception to bin/style-baseline.txt: verb-first src/a.ts trees'
    );
    expect(status).toBe(1);
    expect(readFileSync(join(dir, 'bin/style-baseline.txt'), 'utf8')).toBe('\n');
  });
});
