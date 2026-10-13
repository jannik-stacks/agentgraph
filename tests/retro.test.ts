import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commit, git, runScript, temp, write } from './kit.ts';

const scripts = resolve(import.meta.dirname, '../examples/bothub/scripts');

type Run = { id: string; run: Record<string, unknown>; outcome?: Record<string, unknown>; events?: object[] };

/** A data directory holding `runs` and `pulls`, the way serve leaves them. */
const data = (runs: Run[], pulls: object[] = []) => {
  const dir = temp('retro');
  write(dir, {
    'pulls.jsonl': pulls.map(p => JSON.stringify(p)).join('\n'),
    ...Object.fromEntries(
      runs.flatMap(({ id, run, outcome = {}, events = [] }) => [
        [`runs/${id}/run.json`, JSON.stringify({ workflow: 'issue', job: 'implement', attempt: 1, ...run })],
        [`runs/${id}/outcome.json`, JSON.stringify(outcome)],
        [
          `runs/${id}/events.jsonl`,
          [{ type: 'start' }, ...events]
            .map((event, seq) => JSON.stringify({ ts: '2026-10-13T10:00:01.000Z', seq, event }))
            .join('\n'),
        ],
      ])
    ),
  });
  return dir;
};

const retro = (dir: string, args: string[] = []) => {
  const { ok, out } = runScript(join(scripts, 'retro.mjs'), { dir }, [dir, ...args]);
  expect(ok, out).toBe(true);
  return out ? out.split('\n').map(line => JSON.parse(line) as { id: string; key: string; runs: string[] }) : [];
};
const keys = (dir: string, args: string[] = []) => retro(dir, args).map(item => item.key);

const id = (n: number) => `2026-10-13T10-0${n}-00-000Z-run00${n}`;
const event = { number: 2, body: '/bothub' };
const failing = (check: string, findings: string) => ({
  checks: [{ check, gating: true, pass: false, findings }],
  accepted: [{ kind: 'push' }],
});

describe('retro.mjs', () => {
  it('flags a job that stopped without posting anything, and not one that asked', () => {
    const dir = data([
      { id: id(1), run: { status: 'succeeded', closure: 'deferred', reason: 'sandbox-failed: npm error', event } },
      {
        id: id(2),
        run: { status: 'succeeded', closure: 'blocked', reason: 'asked', event: { number: 3 } },
        outcome: { results: [{ kind: 'ask', status: 'applied' }] },
      },
    ]);
    expect(keys(dir).filter(key => key.startsWith('silent-stop'))).toEqual([
      'silent-stop: issue/implement: sandbox-failed: npm error',
    ]);
  });

  it('flags the same gating finding on two runs in a row, whatever its numbers', () => {
    const dir = data([
      {
        id: id(1),
        run: { status: 'succeeded', event },
        outcome: failing('size', '11 files outside tests/, more than 8'),
      },
      {
        id: id(2),
        run: { status: 'succeeded', event },
        outcome: failing('size', '12 files outside tests/, more than 8'),
      },
    ]);
    expect(keys(dir)).toContain('stuck-finding: size: N files outside tests/, more than N');
  });

  it('flags a retry when no failing check of the attempt before blocks, by the mode the hub gives it', () => {
    const dir = data([
      { id: id(1), run: { status: 'succeeded', event }, outcome: failing('criterion-met', 'criterion 2 fails') },
      { id: id(2), run: { status: 'succeeded', event, attempt: 2, parent: id(1) } },
    ]);
    const hub = temp('retro-hub');
    write(hub, { 'checks/criterion-met.md': '---\ntype: bot\nmode: warn\n---\nq' });
    expect(keys(dir, ['--hub', hub])).toContain('retry-no-holding: issue/implement');
    expect(keys(dir)).not.toContain('retry-no-holding: issue/implement');
  });

  it('flags parking onto the branch of an open merge request, and not after it merged', () => {
    const parked = {
      id: id(2),
      run: { status: 'succeeded', closure: 'blocked', parked: 'bothub/2', event, endedAt: '2026-10-13T10:05:00.000Z' },
    };
    const open = { op: 'open', number: 6, branch: 'bothub/2', ts: '2026-10-13T10:01:00.000Z' };
    const merged = { op: 'merge', number: 6, branch: 'bothub/2', ts: '2026-10-13T10:02:00.000Z' };
    expect(keys(data([parked], [open]))).toContain('park-on-open-request: bothub/2');
    expect(keys(data([parked], [open, merged]))).not.toContain('park-on-open-request: bothub/2');
  });

  it('flags an opencode bot set to resume its session whose runs record none', () => {
    const dir = data([
      { id: id(1), run: { status: 'succeeded', closure: 'done', bot: 'implementor', harness: 'opencode', event } },
    ]);
    const hub = temp('retro-hub');
    write(hub, { 'bots/implementor.md': '---\nresume: session\n---\nx' });
    expect(keys(dir, ['--hub', hub])).toContain('no-session: implementor');
  });

  it('names the environment error and a proposal bothub found invalid', () => {
    const dir = data([
      {
        id: id(1),
        run: { status: 'succeeded', closure: 'done', event },
        outcome: {
          checks: [
            {
              check: 'types',
              gating: true,
              pass: false,
              findings: "TS5033: EROFS: read-only file system, open '/work/x'",
            },
          ],
          rejected: [{ proposal: { kind: 'push' }, reason: 'branch "***" must be a plain name under "bothub/"' }],
        },
      },
    ]);
    expect(keys(dir)).toEqual(
      expect.arrayContaining([
        'env-error: read-only path',
        'rejected: issue/implement: push: branch "***" must be a plain name under "bothub/"',
      ])
    );
  });

  it('flags a cut-off ask, a crashed check at handoff, heavy tests, a wide brief, a repeated line and extra attempts', () => {
    const edit = (filePath: string, lines: number) => ({
      type: 'tool_call',
      tool: 'edit',
      input: { filePath, oldString: '', newString: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') },
    });
    const brief = `## Task\nx\n\n## Criteria\n${[1, 2, 3, 4].map(n => `${n}. c Test: it('t${n}') in tests/a.test.ts`).join('\n')}\n`;
    const coverage = failing('coverage', 'src/serve.ts:256: added code no test runs');
    const dir = data([
      {
        id: id(1),
        run: { status: 'succeeded', closure: 'done', job: 'triage', event },
        outcome: {
          accepted: [
            { kind: 'reply', body: brief },
            { kind: 'ask', question: 'The adapter emits usage but' },
          ],
        },
      },
      { id: id(2), run: { status: 'succeeded', event }, outcome: coverage, events: [edit('/work/src/a.ts', 2)] },
      {
        id: id(3),
        run: { status: 'succeeded', event },
        outcome: coverage,
        events: [edit('/work/tests/a.test.ts', 30)],
      },
      {
        id: id(4),
        run: { status: 'succeeded', closure: 'handed-off', event },
        outcome: {
          checks: [{ check: 'review-tests', gating: false, pass: false, findings: 'a.ts:1:\nrun X failed: boom' }],
        },
      },
    ]);
    const hub = temp('retro-hub');
    write(hub, {
      'issues/2-x.md': '---\ntitle: x\n---\n## Done when\n\n- one\n- two\n\n## @morgan at now\n',
      'workflows/issue.md': '---\njobs:\n  implement:\n    until:\n      checks: [coverage]\n      max: 2\n---\n',
    });
    expect(keys(dir, ['--hub', hub])).toEqual(
      expect.arrayContaining([
        'cut-title: issue/triage',
        'crashed-handoff: issue/implement',
        'test-heavy: issue/implement',
        'wide-brief: issue/triage',
        'same-line: coverage: src/serve.ts:256',
        'over-attempts: issue/implement#2',
      ])
    );
    expect(keys(dir).filter(key => /^(wide-brief|over-attempts)/.test(key))).toEqual([]);
  });

  it('flags an empty turn after an engine ask, shipped gaps, fast script failures, a pushed park and a flat decider', () => {
    const repo = temp('retro-repo');
    git(repo, 'init', '-q', '-b', 'main');
    const base = commit(repo, { 'a.ts': '1\n' });
    write(repo, { 'a.ts': '2\n' });
    git(repo, 'commit', '-qam', 'bothub: implement (parked)');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const decision = (p: number) => ({ type: 'decision', ask: 'In scope?', p });
    const dir = data([
      {
        id: id(1),
        run: { status: 'succeeded', event, bot: 'implementor' },
        outcome: {
          checks: [{ check: 'lint', gating: true, pass: false, durationMs: 900, findings: 'a.ts:1: no' }],
          accepted: [{ kind: 'push' }, { kind: 'ask', question: 'checks could not run: review-src' }],
        },
        events: [1, 2, 3, 4, 5].map(n => decision(0.5 + n / 100)),
      },
      {
        id: id(2),
        run: { status: 'succeeded', closure: 'handed-off', event, bot: 'implementor', base },
        outcome: {
          checks: [{ check: 'review-tests', gating: false, pass: false, findings: 'exited with code 137' }],
          accepted: [{ kind: 'push' }],
          results: [{ kind: 'push', status: 'applied', url: `${join(repo, '.git')}#bothub/2`, sha }],
        },
        events: [{ type: 'decision', ask: 'In scope?', error: 'decide: timed out after 5000 ms' }],
      },
    ]);
    const hub = temp('retro-hub');
    write(hub, { 'checks/lint.md': '---\ntype: script\nmode: block\n---\nx' });
    expect(keys(dir, ['--hub', hub])).toEqual(
      expect.arrayContaining([
        'empty-retrigger: issue/implement',
        'shipped-gaps: review-tests',
        'fast-script-fail: lint',
        'parked-pushed: issue/implement',
        'decider-flat: In scope?',
        'decider-error: decide: timed out after N ms',
        'env-error: killed',
      ])
    );
  });

  it('gives each item a stable id from its key, and reports nothing for a clean run', () => {
    const stopped = { id: id(1), run: { status: 'failed', error: 'boom', event } };
    const ids = [retro(data([stopped]))[0]?.id, retro(data([stopped]))[0]?.id];
    expect(ids[0]).toMatch(/^retro:[0-9a-f]{8}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(retro(data([{ id: id(1), run: { status: 'succeeded', closure: 'done', event } }]))).toEqual([]);
  });
});

describe('retro-items.mjs', () => {
  const item = (id: string) => JSON.stringify({ id, key: `silent-stop: ${id}` });

  it('prints each pasted item once, leaving out those a reply or another issue already names', () => {
    const hub = temp('retro-items');
    write(hub, {
      'issues/5-retro.md': [
        '---\ntitle: retro\n---',
        '/retro',
        item('retro:aaaa1111'),
        item('retro:bbbb2222'),
        item('retro:cccc3333'),
        item('retro:cccc3333'),
        '',
        'expected retro:aaaa1111: a continuation a human asked for',
      ].join('\n'),
      'issues/6-retro-silent-stop.md': '---\ntitle: retro silent-stop\nparent: 5\n---\nretro:bbbb2222',
    });
    const { ok, out } = runScript(join(scripts, 'retro-items.mjs'), { dir: hub }, [], {
      BOTHUB_HUB: hub,
      BOTHUB_ISSUE: '5',
    });
    expect(ok, out).toBe(true);
    expect(out.split('\n')).toEqual([item('retro:cccc3333')]);
  });
});
