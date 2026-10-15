import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unsandboxed } from '../src/runner.ts';
import { Harness } from '../src/schema.ts';
import type { AgentEvent, HarnessAdapter } from '../src/types.ts';
import { sourceRepo, temp, write } from './kit.ts';

const { measure, patchHub, runCase, splitOf, splits, summarize, sweep } = await import(
  join(import.meta.dirname, '../bench/run.mjs')
);

describe('bench hub overrides', () => {
  it('merges into frontmatter and hub.yaml, replaces and deletes files', () => {
    const dir = temp('bench-hub');
    write(dir, {
      'hub.yaml': 'issues: local\nhuman: seed\n',
      'checks/simpler.md': '---\ntype: script\nrun: "true"\nmode: block\n---\n\nKeep it small.\n',
      'skills/a.md': '---\ndescription: A.\n---\n\nA.\n',
      'skills/b.md': '---\ndescription: B.\n---\n\nB.\n',
    });
    patchHub(dir, {
      'checks/simpler.md': { mode: 'warn', run: null },
      'hub.yaml': { human: 'bench' },
      'skills/a.md': '---\ndescription: New.\n---\n\nNew.\n',
      'skills/b.md': null,
    });
    const read = (path: string) => readFileSync(join(dir, path), 'utf8');
    expect(read('checks/simpler.md')).toBe('---\ntype: script\nmode: warn\n---\n\nKeep it small.\n');
    expect(read('hub.yaml')).toBe('issues: local\nhuman: bench\n');
    expect(read('skills/a.md')).toContain('New.');
    expect(existsSync(join(dir, 'skills/b.md'))).toBe(false);
  });
});

describe('bench splits', () => {
  it('assigns a case by the hash of its id and keeps a stored split', () => {
    expect(['acme__clarinet-2543', 'b', 'e'].map(splitOf)).toEqual(['train', 'validation', 'test']);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) counts[splitOf(`case-${i}`)] = (counts[splitOf(`case-${i}`)] ?? 0) + 1;
    expect(counts.train).toBeGreaterThan(500);
    expect(counts.test).toBeGreaterThan(150);

    const dir = temp('bench-cases');
    for (const id of ['one', 'two']) write(dir, { [`${id}/case.json`]: '{}' });
    expect(splits(dir)).toEqual({ one: splitOf('one'), two: splitOf('two') });
    writeFileSync(join(dir, 'splits.json'), JSON.stringify({ one: 'test' }));
    write(dir, { 'three/case.json': '{}' });
    expect(splits(dir)).toEqual({ one: 'test', three: splitOf('three'), two: splitOf('two') });
  });

  it('refuses the test split unless it only reports', async () => {
    const dir = temp('bench-cases');
    await expect(sweep({ hub: dir, cases: dir, clone: dir, split: 'test' })).rejects.toThrow(/report-only/);
  });
});

describe('bench summary', () => {
  const row = (setting: string, id: string, usd: number, closure = 'merge-request') => ({
    setting,
    case: id,
    usd,
    closure,
    timedOut: false,
  });
  it('reports median and spread per setting and pairs each against the baseline per case', () => {
    const rows = [
      row('baseline', 'a', 1),
      row('baseline', 'a', 3),
      row('baseline', 'b', 2),
      row('cheap', 'a', 1),
      row('cheap', 'a', 1),
      row('cheap', 'b', 4, 'blocked'),
      row('cheap', 'c', 9),
    ];
    const out = summarize(rows);
    expect(out.baseline.metrics.usd).toEqual({ median: 2, min: 1, max: 3, n: 3 });
    expect(out.cheap.metrics.usd).toEqual({ median: 2.5, min: 1, max: 9, n: 4 });
    expect(out.cheap.metrics.mergeRequest.median).toBe(1);
    expect(out.cheap.paired.usd).toEqual({ delta: 0.5, up: 1, down: 1, cases: 2 });
    expect(out.cheap.paired.mergeRequest).toEqual({ delta: -0.5, up: 0, down: 1, cases: 2 });
    expect(out.baseline.paired).toBeUndefined();
  });
});

describe('bench measure', () => {
  it('counts held checks that passed on the final attempt as false holds', () => {
    const event = { number: 1 };
    const run = (attempt: number, closure: string) => ({ workflow: 'w', job: 'fix', attempt, closure, event });
    const records = [
      { run: run(1, 'done'), outcome: { checks: [{ check: 'size', gating: true, pass: false }] }, events: [] },
      { run: { ...run(1, 'done'), check: 'size' }, events: [] },
      {
        run: run(2, 'done'),
        outcome: { checks: [{ check: 'size', gating: true, pass: true }], accepted: [{ kind: 'ask' }] },
        events: [],
      },
    ];
    expect(measure({ records })).toMatchObject({ closure: 'done', attempts: 2, falseHolds: 1, questions: 1 });
    expect(measure({ records, modes: { size: 'warn' } }).falseHolds).toBe(0);
  });
});

const steps = [
  { write: { 'fix.txt': 'fixed\n' } },
  {
    propose: [
      { kind: 'push', branch: 'bothub/1', files: ['fix.txt'] },
      { kind: 'merge-request', title: 'Fix', body: 'Closes #1.', branch: 'bothub/1' },
    ],
  },
];

const merged = `diff --git a/fix.txt b/fix.txt
new file mode 100644
--- /dev/null
+++ b/fix.txt
@@ -0,0 +1 @@
+fixed
diff --git a/tests/fix.test.ts b/tests/fix.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/fix.test.ts
@@ -0,0 +1 @@
+it('fixes', () => expect(1).toBe(1));
`;

describe('bench driver', () => {
  it('runs a case to a merge request with a stub harness and measures it', async () => {
    const root = temp('bench-driver');
    const counter = join(root, 'count');
    const hub = join(root, 'hub');
    write(hub, {
      'hub.yaml': 'issues: local\n',
      'bots/coder.md': '---\nharness: opencode\ntools: [read]\nreturns: [push, merge-request]\n---\n\nYou fix.\n',
      'skills/fix.md': '---\ndescription: Fix.\n---\n\nFix it.\n',
      'checks/flaky.md': `---\ntype: script\nrun: 'n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}; test "$n" -ge 1'\nmode: block\n---\n`,
      'workflows/issue.md': [
        '---',
        'on: { issue_comment: { types: [created], command: /bothub } }',
        'steps:',
        '  fix:',
        '    { bot: coder, skill: fix, branch: "bothub/{issue}",',
        '      returns: [push, merge-request], checks: [flaky], tries: 3 }',
        '---',
        '',
      ].join('\n'),
      'issues/1-old.md': '---\ntitle: Old\n---\n\nLeft out of the copy.\n',
    });
    const file = join(root, 'steps.json');
    writeFileSync(file, JSON.stringify(steps));
    const harness = fileURLToPath(new URL('../src/sim-harness.ts', import.meta.url));
    const adapter = (name: Harness): HarnessAdapter => ({
      name,
      command: () => ({ cmd: process.execPath, args: [harness], env: { BOTHUB_SIM_STEPS: file } }),
      parseLine: line => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
    });
    const repo = sourceRepo();
    const before = readdirSync(tmpdir()).filter(name => name.startsWith('bench-run-'));
    const row = await runCase({
      hub,
      kase: { id: 'x', repo: 'acme/app', base: repo.main, title: 'Fix', body: 'Add fix.txt.', merged, followups: [] },
      clone: repo.dir,
      env: {},
      interval: 50,
      timeout: 50_000,
      adapters: Object.fromEntries(Harness.options.map(name => [name, adapter(name)])),
      launch: unsandboxed,
    });
    expect(row).toMatchObject({
      closure: 'merge-request',
      attempts: 2,
      maxAttempt: 2,
      falseHolds: 1,
      questions: 0,
      usd: 0,
      added: 1,
      addedNoTests: 1,
      mergedAdded: 2,
      mergedAddedNoTests: 1,
      fileJaccard: 0.5,
      timedOut: false,
    });
    const kept = (row as { kept: string }).kept;
    expect(readdirSync(kept).sort()).toEqual(['data', 'diff.patch', 'hub']);
    expect(readFileSync(join(kept, 'diff.patch'), 'utf8')).toContain('fix.txt');
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('bench-run-'))).toEqual(
      [...before, basename(kept)].sort()
    );
  });
});
