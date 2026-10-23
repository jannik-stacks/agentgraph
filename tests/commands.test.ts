import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const root = resolve(import.meta.dirname, '..');

describe('commands', () => {
  it('fails a missing bin file, command, flag, npm script and agentgraph binary, one line each', () => {
    const dir = tmp('commands');
    for (const path of ['bin/commands.mjs', 'bin/run.ts', 'bin/forge.ts', 'package.json', 'studio/package.json'])
      cpSync(join(root, path), join(dir, path));
    write(dir, {
      'README.md':
        'Run `node bin/run.ts check --hub x` and `npm run dev`.\n' +
        '`node bin/run.ts say --hub x --issue 1`, `node bin/run.ts tell --issue 1` and `node bin/run.ts dispatch --workflow triage --issue 1`.\n',
      'infra/github/README.md': '',
      'docs/local.md':
        'Run `node bin/run.ts serve`, `node bin/sim.ts`, `npm run retro` and `agentgraph sim`.\nUse `node bin/run.ts --hub x --watch` and `node bin/forge.ts /d wipe`; `--hub` and `--nope` are flags.\n',
      'examples/agentgraph/README.md': '`npm run -s precommit`\n',
    });
    const { status, stderr } = spawnSync('node', [join(dir, 'bin/commands.mjs')], { encoding: 'utf8' });
    expect(status).toBe(1);
    expect(stderr.trim().split('\n')).toEqual([
      'docs/local.md:1: bin/run.ts has no serve command',
      'docs/local.md:1: bin/sim.ts does not exist',
      'docs/local.md:1: there is no npm script retro',
      'docs/local.md:1: `agentgraph sim` names a binary that does not exist; say node bin/run.ts',
      'docs/local.md:2: bin/run.ts has no --watch option',
      'docs/local.md:2: bin/forge.ts has no wipe command',
      'docs/local.md:2: no bin file reads --nope',
    ]);
  });
});
