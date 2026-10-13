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
    expect(trace).toMatch(/job {4}issue\/triage \(triager\)\n {7}preload Issue #6 [\d.]+ kB, Linked issues/);
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

  it('turns a run whose checks keep failing into unsure issues under the task', { timeout: 20_000 }, async () => {
    const { results, trace } = await run('stuck-run.yaml');
    const implement = results.find(r => r.job === 'implement');
    expect(implement && 'run' in implement && implement.run).toMatchObject({ status: 'failed', attempt: 4 });
    expect(trace).toContain('checks   safety pass, harness-memory pass, style pass, lint pass, types pass, tests fail');
    expect(trace).toContain('rejected push: checks still failing after 4 attempts');
    expect(trace).toMatch(
      /\+ 8-should-cvfromjson-reject-a-uint-passed-as-a-number\.md \(new\)\n.*\n {4}\| title: Should cvFromJson/
    );
    expect(trace).toContain('    | labels: [unsure]\n    | author: bothub[bot]\n    | parent: 7');
    expect(trace).toContain('    + @morgan needs a human: #8');
    expect(trace).toContain('issue/review: skipped, deferred (needs "implement" (blocked) to be done)');
  });

  it('finishes a job the process stopped while applying, without repeating what landed', async () => {
    const { results, trace } = await run('crash-mid-apply.yaml');
    expect(trace).toContain('reconcile issue/implement: interrupted, the process running it stopped while applying');
    expect(trace.match(/git push bothub\/6/g)).toHaveLength(1);
    expect(trace.match(/github POST \/repos\/stacks\/acme-app\/pulls /g)).toHaveLength(1);
    expect(trace.match(/^job {4}issue\/triage/gm)).toHaveLength(1);
    expect(trace).toContain('applied  push: applied sim://acme/app/tree/bothub/6 (applied by an earlier run)');
    expect(results.map(r => [r.job, 'skipped' in r ? r.closure : r.run.closure])).toEqual([
      ['triage', 'done'],
      ['implement', 'handed-off'],
      ['review', 'done'],
    ]);
  });

  it('drops a second delivery of the same event', async () => {
    const { results, trace } = await run('redelivery.yaml');
    expect(trace).toMatch(/redeliver local-6-comment-1-\w+: dropped, already delivered/);
    expect(results).toHaveLength(3);
  });

  it('blocks a job whose pull request failed to open and holds back the job that needs it', async () => {
    const { trace } = await run('pull-request-fails.yaml');
    expect(trace).toContain('issue/implement: succeeded, blocked (open-pr failed: open-pr failed in this scenario)');
    expect(trace).toContain('issue/review: skipped, deferred (needs "implement" (blocked) to be done)');
  });

  it('defers a job the provider refused without asking a human', async () => {
    const { trace } = await run('provider-limit.yaml');
    expect(trace).toContain('issue/implement: failed, deferred (429 Too Many Requests: usage limit reached');
    expect(trace).toContain('issue/review: skipped, deferred (needs "implement" (deferred) to be done)');
    expect(trace).not.toContain('labels: [unsure]\n    | author: bothub[bot]');
  });
});
