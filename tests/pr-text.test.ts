import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/forge.ts';

const script = join(import.meta.dirname, '..', 'examples');

const check = (hub: string, proposals: Proposal[]) => {
  const file = join(mkdtempSync(join(tmpdir(), 'pr-text-')), 'proposals.json');
  writeFileSync(file, JSON.stringify(proposals));
  const out = spawnSync('node', [join(script, hub, 'scripts', 'pr-text.mjs')], {
    env: { ...process.env, BOTHUB_PROPOSALS: file },
    encoding: 'utf8',
  });
  return { code: out.status, lines: out.stdout.split('\n').filter(Boolean) };
};

const pull = (body: string): Proposal => ({
  kind: 'pull_request',
  branch: 'b',
  base: 'main',
  title: 't',
  body,
});

describe.each(['sk', 'sandbox'])('pr-text in %s', hub => {
  it('fails one line per hit on the real long body and a loose commit', () => {
    const body =
      'Validation: new regressions failed without the fix. Each touched test file passes individually; npm --prefix kit run typecheck passes; npm --prefix kit test passes all 897 tests in 37 files. No docs generators run.\n\nNothing left open for this issue. Human review and merge required.';
    const { code, lines } = check(hub, [{ kind: 'push', branch: 'b', message: 'Fixed things' }, pull(body)]);
    expect(code).toBe(1);
    expect(lines).toHaveLength(5);
    expect(lines.join('\n')).toMatch(
      /not a conventional commit.*897 tests.*passes.*No docs generators run.*Nothing left open/s
    );
  });

  it('fails a long subject and a four line body', () => {
    const message = `fix(core): ${'x'.repeat(70)}\n\na\nb\nc\nd`;
    expect(check(hub, [{ kind: 'push', branch: 'b', message }]).lines).toHaveLength(2);
  });

  it('passes a short body and a conventional commit', () => {
    const message = 'fix(signing): reject a signer from another key\n\nThe key was never compared.';
    const body = '`verifySigner` compares the recovered key with `expected`.\n\n- **Test:** another key is rejected.';
    expect(check(hub, [{ kind: 'push', branch: 'b', message }, pull(body)])).toEqual({ code: 0, lines: [] });
  });
});
