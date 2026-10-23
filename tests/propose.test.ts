import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Either } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHub } from '../src/hub.ts';
import { claudeUsed, fitting, propose, type Proposer } from '../tune/propose.ts';
import { tmp } from './kit.ts';

const root = join(import.meta.dirname, '..');
const save = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const answers = {
  retro: {
    verdict: 'change',
    missClass: 'tests written but never run',
    rationale: 'Both runs wrote a test and opened the pull request without running it.',
    cases: [
      { id: 'a-1', evidence: '3 tool write {"path":"a.test.ts"} ok' },
      { id: 'a-2', evidence: '3 tool write {"path":"a.test.ts"} ok' },
    ],
    changes: [
      {
        path: 'checks/ran-tests.md',
        content:
          '---\nmode: block\nrun: node "$AGENTGRAPH_HUB/scripts/ran-tests.mjs"\n---\nThe tests the change adds ran.\n',
      },
      { path: 'scripts/ran-tests.mjs', content: 'process.exit(0);\n' },
      { path: 'workflows/issue.md', old: 'checks: [tests]', new: 'checks: [tests, ran-tests]' },
    ],
  },
  history: {
    verdict: 'change',
    missClass: 'changelog entry',
    rationale: 'Reviewers asked for a changelog line twice.',
    cases: [
      { id: 'm-1', evidence: 'please add a changelog entry' },
      { id: 'm-2', evidence: 'changelog?' },
    ],
    changes: [{ path: 'skills/implement.md', content: 'Add a line to CHANGELOG.md for every user-facing change.\n' }],
  },
  nothing: { verdict: 'nothing', rationale: 'The misses differ.', cases: [], changes: [] },
  one: {
    verdict: 'change',
    missClass: 'tests written but never run',
    rationale: 'The run wrote a test and never ran it.',
    cases: [{ id: 'a-1', evidence: '3 tool write {"path":"a.test.ts"} ok' }],
    changes: [{ path: 'skills/implement.md', content: 'Run every test you write before you finish.\n' }],
  },
  structure: {
    verdict: 'change',
    rationale: 'a-1 ended its last try one check short.',
    cases: [{ id: 'a-1', evidence: '5 check tests: FAIL' }],
    changes: [{ path: 'workflows/issue.md', old: 'tries: 3', new: 'tries: 4' }],
  },
};

const stub = `#!/usr/bin/env node
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', d => (prompt += d));
process.stdin.on('end', () => {
  const answers = ${JSON.stringify(answers)};
  const name = /^# (\\w+) proposer/.exec(prompt)?.[1]?.toLowerCase();
  const resumed = args.includes('--resume');
  const answer = process.env.STUB_ANSWER
    ? answers[process.env.STUB_ANSWER]
    : resumed
    ? answers[process.env.STUB_FIRST]
    : process.env.STUB_FIRST
      ? { ...answers[process.env.STUB_FIRST], cases: [{ id: 'v-1', evidence: 'x' }] }
      : answers[name];
  const window = u => ({ utilization: u, resetsAt: 0 });
  for (const e of [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: window(resumed ? 0.05 : 0.04), seven_day: window(0.54) } } },
    { type: 'result', session_id: 's1', total_cost_usd: 0.25, result: '', structured_output: answer },
  ])
    console.log(JSON.stringify(e));
});
`;

const trace = [
  {
    at: 't',
    step: 'implement',
    prompt: { harness: 'opencode', agent: 'implementor', model: 'smart', system: 'Fix it.', prompt: 'Fix #1' },
  },
  { at: 't', step: 'implement', event: { type: 'tool', name: 'write', input: { path: 'a.test.ts' }, ok: true } },
  { at: 't', step: 'implement', check: { check: 'tests', pass: false, findings: '1 failing' } },
  { at: 't', step: 'implement', outcome: { kind: 'pass' }, run: { step: 'merge', status: 'waiting' } },
];

let dir: string;
let tune: string;
beforeEach(() => {
  dir = tmp('propose');
  tune = join(dir, 'tune', 'r', 't1');
  const cases = {
    'a-1': 'fit',
    'a-2': 'fit',
    'a-3': 'fit',
    'm-1': 'mine',
    'm-2': 'mine',
    'm-3': 'mine',
    'v-1': 'validate',
  };
  save(join(tune, 'tune.json'), JSON.stringify({ repo: 'o/r', cases }));
  for (const id of Object.keys(cases)) {
    const c = join(dir, 'tune', 'r', 'cases', id);
    save(join(c, 'case.json'), JSON.stringify({ repo: 'o/r', pr: 7, title: `title of ${id}` }));
    save(join(c, 'issue.md'), `# title of ${id}\n\nbody of ${id}`);
    save(join(c, 'merged.diff'), `diff --git a/src/${id}.ts b/src/${id}.ts\n+fixed\n`);
    save(
      join(c, 'reviews.md'),
      id.startsWith('m-') ? `### src/a.ts:1 (rev)\n\nplease add a changelog entry for ${id}, ${'x'.repeat(80)}\n` : ''
    );
    const arm = join(tune, 'runs', 'inc', id, 'v2');
    save(join(tune, 'runs', 'inc', id, 'human', 'score.json'), '{}');
    save(join(arm, 'score.json'), JSON.stringify({ files: 1, hidden: { ok: id === 'a-3', tail: `hidden of ${id}` } }));
    save(join(arm, 'diff.patch'), `diff --git a/src/x.ts b/src/x.ts\n+bot ${id}\n`);
    save(
      join(arm, 'data', 'issue-1-1', 'run.json'),
      JSON.stringify({ id: 'issue-1-1', workflow: 'issue', status: 'waiting', usd: 0.1 })
    );
    save(join(arm, 'data', 'issue-1-1', 'trace.jsonl'), trace.map(t => JSON.stringify(t)).join('\n'));
  }
  cpSync(join(root, 'examples', 'bench'), join(dir, 'hub'), { recursive: true });
  save(join(dir, 'claude'), stub);
  spawnSync('chmod', ['+x', join(dir, 'claude')]);
  process.env.AGENTGRAPH_CLAUDE = join(dir, 'claude');
});
afterEach(() => {
  delete process.env.AGENTGRAPH_CLAUDE;
  delete process.env.STUB_FIRST;
  delete process.env.STUB_ANSWER;
  rmSync(dir, { recursive: true, force: true });
});

const run = (proposer: Proposer, id = `i1-${proposer}`) =>
  propose({ tune, id, proposer, from: join(dir, 'hub'), runs: join(tune, 'runs', 'inc'), iteration: 2 });
const hubOk = (hub: string) => Effect.runPromise(Effect.either(loadHub(hub))).then(Either.isRight);

describe('propose', () => {
  it.each(['retro', 'history', 'structure'] as const)('%s writes a valid hub and a rationale', async proposer => {
    const p = await run(proposer);
    expect(p.problems).toEqual([]);
    expect(p.hub).toBe(join(tune, 'cands', `i1-${proposer}`, 'hub'));
    expect(await hubOk(p.hub!)).toBe(true);
    expect(p.usd).toBe(0.25);
    expect(p.usage).toEqual({ fiveHour: 4, week: 54 });
    const md = readFileSync(join(tune, 'cands', p.id, 'proposal.md'), 'utf8');
    expect(md).toContain(answers[proposer].rationale);
    expect(md).toMatch(/^\+/m);
    const prompt = readFileSync(join(tune, 'cands', p.id, 'input', 'prompt.md'), 'utf8');
    expect(prompt).not.toContain('v-1');
    expect(prompt).not.toContain('a-3');
  });

  it('gives retro only the failing fit cases and history only the mine cases', async () => {
    await run('retro');
    await run('history');
    const read = (id: string) => readFileSync(join(tune, 'cands', id, 'input', 'prompt.md'), 'utf8');
    expect(read('i1-retro')).toMatch(/### a-1[\s\S]*hidden of a-1[\s\S]*bot a-1[\s\S]*tool write/);
    expect(read('i1-retro')).not.toContain('m-1');
    expect(read('i1-history')).toMatch(/### m-\d: PR #7[\s\S]*please add a changelog entry/);
    expect(read('i1-history')).not.toContain('a-1');
  });

  it('structure applies the edit the iteration picks', async () => {
    await run('structure');
    expect(readFileSync(join(tune, 'cands', 'i1-structure', 'input', 'prompt.md'), 'utf8')).toContain('**tries**');
    expect(readFileSync(join(tune, 'cands', 'i1-structure', 'hub', 'workflows', 'issue.md'), 'utf8')).toContain(
      'tries: 4'
    );
  });

  it('asks again with the problems when an answer cites a case it was not given', async () => {
    process.env.STUB_FIRST = 'retro';
    const p = await run('retro');
    expect(p.problems).toEqual([]);
    expect(p.usd).toBe(0.5);
    expect(p.usage).toEqual({ fiveHour: 5, week: 54 });
    expect(existsSync(join(tune, 'cands', p.id, 'stream-2.jsonl'))).toBe(true);
  });

  it('lets retro learn from one failing case and shows held-out cases only as counts', async () => {
    save(join(tune, 'runs', 'inc', 'a-2', 'v2', 'score.json'), JSON.stringify({ files: 1, hidden: { ok: true } }));
    process.env.STUB_ANSWER = 'one';
    const p = await run('retro');
    expect(p.problems).toEqual([]);
    expect(p.hub).toBeDefined();
    const prompt = readFileSync(join(tune, 'cands', p.id, 'input', 'prompt.md'), 'utf8');
    expect(prompt).toContain('## Held-out cases\n\nOn the held-out cases this hub is scored on, 1 of 1 fail');
    expect(prompt).not.toContain('v-1');
  });

  it('skips the call with no failing case or a question already answered with nothing', async () => {
    process.env.STUB_ANSWER = 'nothing';
    expect((await run('retro', 'i1-a')).verdict).toBe('nothing');
    expect(existsSync(join(tune, 'cands', 'i1-a', 'stream-1.jsonl'))).toBe(true);
    const again = await run('retro', 'i1-b');
    expect([again.rationale, again.usd]).toEqual(['the same question was answered with nothing before', 0]);
    expect(existsSync(join(tune, 'cands', 'i1-b'))).toBe(false);
    for (const id of ['a-1', 'a-2'])
      save(join(tune, 'runs', 'inc', id, 'v2', 'score.json'), JSON.stringify({ files: 1, hidden: { ok: true } }));
    expect((await run('history', 'i1-c')).usd).toBe(0.25);
    expect((await run('structure', 'i1-d')).rationale).toBe('no cases to learn from');
  });

  it('lists earlier candidates with their verdicts', async () => {
    save(
      join(tune, 'cands', 'i1-retro', 'candidate.json'),
      JSON.stringify({ proposer: 'retro', rationale: 'Run it. More.' })
    );
    save(join(tune, 'iterations.jsonl'), `${JSON.stringify({ id: 'i1-retro', verdict: 'discarded' })}\n`);
    const p = await run('history', 'i2-history');
    const prompt = readFileSync(join(tune, 'cands', p.id, 'input', 'prompt.md'), 'utf8');
    expect(prompt).toContain('## Tried before\n\n- i1-retro, retro, discarded: Run it.');
  });

  it('offers only the structure edits that can change the hub', async () => {
    const hub = await Effect.runPromise(loadHub(join(dir, 'hub')));
    expect(fitting(hub)).toEqual(['drop', 'tries', 'scout']);
  });

  it('refuses a candidate id that already has a proposal', async () => {
    await run('history', 'dup');
    await expect(run('history', 'dup')).rejects.toThrow(/already has a proposal/);
  });

  it('reads no usage from a stream without a rate limit event', () => {
    expect(claudeUsed('{"type":"result"}\n')).toBeUndefined();
  });
});
