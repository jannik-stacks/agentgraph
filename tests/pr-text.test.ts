import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/forge.ts';

const script = join(import.meta.dirname, '..', 'examples');
const hubs = readdirSync(script).filter(hub => existsSync(join(script, hub, 'scripts', 'pr-text.mjs')));

const check = (hub: string, proposals: Proposal[]) => {
  const file = join(mkdtempSync(join(tmpdir(), 'pr-text-')), 'proposals.json');
  writeFileSync(file, JSON.stringify(proposals));
  const out = spawnSync('node', [join(script, hub, 'scripts', 'pr-text.mjs')], {
    env: { ...process.env, AGENTGRAPH_PROPOSALS: file },
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

describe.each(hubs)('pr-text bounds in %s', hub => {
  it('fails a body over 120 words', () => {
    const { lines } = check(hub, [pull(Array(121).fill('word').join(' '))]);
    expect(lines).toEqual(['pull request body is 121 words, over 120']);
  });

  it('fails the filler the twin bodies ended with', () => {
    const { lines } = check(hub, [pull('Adds `bye`. This PR is small. Awaiting review.')]);
    expect(lines).toEqual([
      'pull request body is boilerplate: "Awaiting review"',
      'pull request body refers to itself: "This PR"',
    ]);
  });

  it('still passes a body of 120 words', () => {
    expect(check(hub, [pull(Array(120).fill('word').join(' '))])).toEqual({ code: 0, lines: [] });
  });
});

describe.each(hubs)('pr-text in %s', hub => {
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

  it('fails a body that names two pull requests it stacks on', () => {
    const { lines } = check(hub, [pull('Adds `bye`. Stacks on #20.\n\nCloses #23\n\nStacks on #22')]);
    expect(lines).toEqual(['pull request body has 2 Stacks on lines: Stacks on #20, Stacks on #22']);
  });

  it('passes a short body and a conventional commit', () => {
    const message = 'fix(signing): reject a signer from another key\n\nThe key was never compared.';
    const body = '`verifySigner` compares the recovered key with `expected`.\n\n- **Test:** another key is rejected.';
    expect(check(hub, [{ kind: 'push', branch: 'b', message }, pull(body)])).toEqual({ code: 0, lines: [] });
  });
});
