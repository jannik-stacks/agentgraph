import { execFileSync } from 'node:child_process';
import { cpSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp } from './kit.ts';

const root = join(import.meta.dirname, '..');
const dockerfiles = globSync('infra/local/**/Dockerfile', { cwd: root }).toSorted();

const readPins = (path: string) => {
  const text = readFileSync(path, 'utf8');
  const args = Object.fromEntries([...text.matchAll(/^ARG (\w+_VERSION)=(\S*)$/gm)].map(m => [m[1], m[2]]));
  const used = [...text.matchAll(/@\$\{(\w+)\}/g)].map(m => m[1]!);
  return {
    loose: Object.entries(args).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(String(version))),
    dangling: used.filter(name => !Object.hasOwn(args, name)),
  };
};

describe('Dockerfile pins', () => {
  it('finds the sandbox Dockerfile', () => {
    expect(dockerfiles).toContain('infra/local/sandbox/Dockerfile');
  });

  it.each(dockerfiles)('%s pins exact versions and names only its own ARGs', path => {
    expect(readPins(join(root, path))).toEqual({ loose: [], dangling: [] });
  });

  it('sets one pin by rewriting its ARG line, and the pins stay exact', () => {
    const copy = tmp('pins');
    cpSync(join(root, 'infra/local'), join(copy, 'infra/local'), { recursive: true });
    const sandbox = join(copy, 'infra/local/sandbox/Dockerfile');
    const before = readFileSync(sandbox, 'utf8').split('\n');
    const pins = join(root, 'bin/pins.mjs');
    execFileSync('node', [pins, '--root', copy, '--set', 'OPENCODE_VERSION=9.8.7'], { stdio: 'ignore' });
    const after = readFileSync(sandbox, 'utf8');
    expect([after.split('\n').filter((line, i) => line !== before[i]), readPins(sandbox)]).toEqual([
      ['ARG OPENCODE_VERSION=9.8.7'],
      { loose: [], dangling: [] },
    ]);
    expect(() =>
      execFileSync('node', [pins, '--root', copy, '--set', 'OPENCODE_VERSION=latest'], { stdio: 'ignore' })
    ).toThrow();
  });
});
