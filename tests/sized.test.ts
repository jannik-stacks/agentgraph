import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/forge.ts';

const examples = join(import.meta.dirname, '..', 'examples');
const hubs = readdirSync(examples).filter(hub => existsSync(join(examples, hub, 'scripts', 'sized.mjs')));

const check = (hub: string, proposals: object[]) => {
  const file = join(mkdtempSync(join(tmpdir(), 'sized-')), 'proposals.json');
  writeFileSync(file, JSON.stringify(proposals));
  const out = spawnSync('node', [join(examples, hub, 'scripts', 'sized.mjs')], {
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
  priority: 'low',
});
const label = (size: string): Proposal => ({ kind: 'label', add: [`size/${size}`] });

describe.each(hubs)('sized in %s', hub => {
  it('still passes a size label alone', () => {
    expect(check(hub, [label('S')]).code).toBe(0);
  });

  it('still fails a block with no size', () => {
    expect(check(hub, [{ kind: 'comment', body: 'x' }]).out).toMatch(/No size label/);
  });

  it('fails parts as large as the issue', () => {
    const { code, out } = check(hub, [label('XL'), part('a', 'L'), part('b', 'XL')]);
    expect(code).toBe(1);
    expect(out).toContain('"b" is XL');
    expect(out).not.toContain('"a"');
  });

  it('still passes parts smaller than the issue', () => {
    expect(check(hub, [label('XL'), part('a', 'L'), part('b', 'M')]).code).toBe(0);
  });
});
