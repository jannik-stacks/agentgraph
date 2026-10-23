import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmp, write } from './kit.ts';

const script = resolve(import.meta.dirname, '../bin/diagrams.mjs');

const check = (diagram: string) => {
  const dir = tmp('diagrams');
  write(dir, { 'a.md': `text\n\n\`\`\`\n${diagram}\`\`\`\n` });
  const { status, stdout } = spawnSync('node', [script, join(dir, 'a.md')], { encoding: 'utf8' });
  return {
    status,
    lines: stdout
      .trim()
      .split('\n')
      .map(l => l.replace(`${dir}/`, '')),
  };
};

describe('diagrams', () => {
  it('accepts a box', () => {
    expect(check('┌─────┐\n│ hi  │\n└─────┘\n')).toEqual({ status: 0, lines: ['1 diagrams ok'] });
  });

  it('accepts a line leaving a box through its bottom edge', () => {
    expect(check('┌─────┐\n│ hi  │\n└──┬──┘\n   ▼\n').status).toBe(0);
  });

  it('reports a right edge one column off', () => {
    const { status, lines } = check('┌─────┐\n│ hi   │\n└─────┘\n');
    expect(status).toBe(1);
    expect(lines.some(l => l.includes('right edge of box') && l.includes('off by one column'))).toBe(true);
  });

  it('reports a dangling vertical', () => {
    const { status, lines } = check('┌─────┐\n│ hi  │\n└─────┘\n  │\n');
    expect(status).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/a\.md:7:3: │ has no vertical connector/)]);
  });

  it('accepts a tree outline', () => {
    expect(check('src\n├─ a\n│  ├─ b\n│  └─ c\n└─ d\n')).toEqual({ status: 0, lines: ['1 diagrams ok'] });
  });

  it('measures a wide char as two columns', () => {
    expect(check('┌──────┐\n│ ok 🚀│\n└──────┘\n').status).toBe(0);
    expect(check('┌──────┐\n│ ok 🚀 │\n└──────┘\n').status).toBe(1);
  });
});
