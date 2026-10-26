import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/proposal.ts';

const examples = join(import.meta.dirname, '..', 'examples');
const graphs = readdirSync(examples).filter(graph => existsSync(join(examples, graph, 'scripts', 'sized.mjs')));

const check = (graph: string, proposals: object[]) => {
  const file = join(mkdtempSync(join(tmpdir(), 'sized-')), 'proposals.json');
  writeFileSync(file, JSON.stringify(proposals));
  const out = spawnSync('node', [join(examples, graph, 'scripts', 'sized.mjs')], {
    env: { ...process.env, AGENTGRAPH_PROPOSALS: file },
    encoding: 'utf8',
  });
  return { code: out.status, out: out.stdout.trim() };
};

const part = (title: string, size: string) => ({
  kind: 'issue',
  relation: 'part',
  title,
  body: 'b',
  size,
});
const label = (size: string): Proposal => ({ kind: 'label', add: [`size/${size}`] });

describe.each(graphs)('sized in %s', graph => {
  it('still passes a size label alone', () => {
    expect(check(graph, [label('S')]).code).toBe(0);
  });

  it('still fails a block with no size', () => {
    expect(check(graph, [{ kind: 'comment', body: 'x' }]).out).toMatch(/No size label/);
  });

  it('fails parts as large as the issue', () => {
    const { code, out } = check(graph, [label('XL'), part('a', 'L'), part('b', 'XL')]);
    expect(code).toBe(1);
    expect(out).toContain('"b" is XL');
    expect(out).not.toContain('"a"');
  });

  it('still passes parts smaller than the issue', () => {
    expect(check(graph, [label('XL'), part('a', 'L'), part('b', 'M')]).code).toBe(0);
  });
});
