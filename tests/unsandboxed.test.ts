import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const skip = new Set(['node_modules', 'dist', 'coverage', 'research', 'tests', '.git']);
const allowed = new Set(['src/runner.ts', 'src/sim.ts', 'examples/bothub/scripts/escape-hatches.mjs']);

const sources = (dir = ''): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return skip.has(entry.name) ? [] : sources(path);
    return /\.(m?[jt]sx?|cjs)$/.test(entry.name) ? [path] : [];
  });

describe('unsandboxed', () => {
  it('is defined in the runner and used only by the simulator', () => {
    const users = sources().filter(path => /\bunsandboxed\b/.test(readFileSync(join(root, path), 'utf8')));
    expect(users).toContain('src/runner.ts');
    expect(users.filter(path => !allowed.has(path))).toEqual([]);
  });
});
