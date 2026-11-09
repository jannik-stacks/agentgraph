import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const dockerfiles = globSync('infra/local/**/Dockerfile', { cwd: root }).toSorted();

const readPins = (path: string) => {
  const text = readFileSync(join(root, path), 'utf8');
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
    expect(readPins(path)).toEqual({ loose: [], dangling: [] });
  });
});
