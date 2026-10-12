import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../src/sim.ts';

const sims = join(import.meta.dirname, '../examples/acme-app/sims');

const run = async (name: string) => {
  const lines: string[] = [];
  const results = await simulate(join(sims, name), line => lines.push(line));
  return { results, trace: lines.join('\n') };
};

describe('simulate', () => {
  it('runs a /bothub comment through triage, implementation with tool calls, and review', async () => {
    const { results, trace } = await run('bothub-comment.yaml');
    expect(results.map(r => ('skipped' in r ? 'skipped' : r.run.status))).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(trace).toContain('event  issue_comment (created) on #6 by @morgan: /bothub add cvToJson');
    expect(trace).toMatch(
      /job {4}issue\/triage \(triager\)\n {7}preload Notes [\d.]+ kB, Issue #6 [\d.]+ kB, Linked issues/
    );
    expect(trace).toContain(
      'tool  issues_get {"number":4}\n         ->  { "number": 4, "title": "Clarity values round-trip through JSON"'
    );
    expect(trace).toContain(
      'tool  notes_search {"query":"hex 0x"}\n         ->  [ { "kind": "caveat", "slug": "hex-no-0x"'
    );
    expect(trace).toContain('applied  open-pr: applied sim://github/repos/acme/app/pulls/1');
    expect(trace).toContain('    - labels: []\n    + labels: [ready]');
    expect(trace).toContain('    + No blocking findings.');
    expect(readFileSync(join(sims, '../issues/6-add-cvtojson-for-every-clarity-type.md'), 'utf8')).not.toContain(
      '@morgan'
    );
  });

  it('turns a run whose checks keep failing into unsure issues under the task', async () => {
    const { results, trace } = await run('stuck-run.yaml');
    const implement = results.find(r => r.job === 'implement');
    expect(implement && 'run' in implement && implement.run).toMatchObject({ status: 'failed', attempt: 4 });
    expect(trace).toContain('checks   tests fail, types pass');
    expect(trace).toContain('rejected push: checks still failing after 4 attempts');
    expect(trace).toMatch(
      /\+ 8-should-cvfromjson-reject-a-uint-passed-as-a-number\.md \(new\)\n.*\n {4}\| title: Should cvFromJson/
    );
    expect(trace).toContain('    | labels: [unsure]\n    | author: bothub[bot]\n    | parent: 7');
    expect(trace).toContain('    + @morgan needs a human: #8');
    expect(trace).toContain('issue/review: skipped, needs "implement", which did not succeed');
  });
});
