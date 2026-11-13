import { spawnSync } from 'node:child_process';
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

  it('allows TSDoc only on the published surface and other comments only when marked UNEXPECTED or a directive', () => {
    const dir = tmp('style');
    write(dir, {
      '.oxlintrc.json': config,
      'package.json': JSON.stringify({ exports: { './plugins': { import: './dist/plugin.mjs' } } }),
      'src/plugin.ts': [
        '/** Reads the graph. */',
        'export const readGraph = (dir: string) => dir;',
        'export type Host = {',
        '  /** Where it lives. */',
        '  dir: string;',
        '};',
        "export { readMore } from './more.ts';",
        '/** Not exported. */',
        'const x = 1;',
        '// UNEXPECTED: git answers 1 for a clean diff here',
        '// oxlint-disable-next-line no-unused-vars',
        'const y = x;',
      ].join('\n'),
      'src/more.ts': [
        '#!/usr/bin/env node',
        '/** Reads more. */',
        'export const readMore = () => 1;',
        '/** Reads less. */',
        'export const readLess = () => 1;',
        '/** @internal */',
        'export const readX = () => 1;',
        '/** @public */',
        'export const readY = () => 1;',
        'export const readZ = () => import(/* @vite-ignore */ "./z.ts");',
        '// plain',
        'export const readW = 1;',
      ].join('\n'),
    });
    expect(lint(dir)).toEqual([
      'error style(no-comment) comment',
      'error style(no-comment) tsdoc',
      'error style(no-comment) tsdoc',
    ]);
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
