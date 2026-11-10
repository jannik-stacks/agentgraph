import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const root = resolve(import.meta.dirname, '..');

it('flags JSON.parse cast to a type, but not to unknown', () => {
  const dir = tmp('json-cast');
  write(dir, {
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [join(root, 'bin/style.mjs')],
      rules: { 'style/no-json-cast': 'error' },
    }),
    'src/a.ts': [
      "export const a = JSON.parse('1') as number;",
      "export const b = (JSON.parse('1') ?? 2) as number;",
      "export const c = JSON.parse('1') as unknown;",
    ].join('\n'),
  });
  const { stdout } = spawnSync(process.execPath, [join(root, 'node_modules/oxlint/bin/oxlint'), '-f', 'json', 'src'], {
    cwd: dir,
    encoding: 'utf8',
  });
  expect(stdout.match(/no-json-cast/g)).toHaveLength(2);
});
