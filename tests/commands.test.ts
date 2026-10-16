import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { temp, write } from './kit.ts';

const root = resolve(import.meta.dirname, '..');

describe('commands', () => {
  it('fails a missing bin file, run.ts command, npm script and bothub binary, one line each', () => {
    const dir = temp('commands');
    for (const path of ['bin/commands.mjs', 'bin/run.ts', 'package.json', 'studio/package.json'])
      cpSync(join(root, path), join(dir, path));
    write(dir, {
      'README.md': 'Run `node bin/run.ts check --hub x` and `npm run dev`.\n',
      'infra/github/README.md': '',
      'docs/local.md': 'Run `node bin/run.ts serve`, `node bin/sim.ts`, `npm run retro` and `bothub sim`.\n',
      'examples/bothub/README.md': '`npm run -s precommit`\n',
    });
    const { status, stderr } = spawnSync('node', [join(dir, 'bin/commands.mjs')], { encoding: 'utf8' });
    expect(status).toBe(1);
    expect(stderr.trim().split('\n')).toEqual([
      'docs/local.md:1: bin/run.ts has no serve command',
      'docs/local.md:1: bin/sim.ts does not exist',
      'docs/local.md:1: there is no npm script retro',
      'docs/local.md:1: `bothub sim` names a binary that does not exist; say node bin/run.ts',
    ]);
  });
});
