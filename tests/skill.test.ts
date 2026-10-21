import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { init, type step, tuneRows } from '../bin/tune.ts';
import { skill } from '../tune/skill.ts';
import { tmp } from './fixtures.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.BOTHUB_TUNE;
  delete process.env.BOTHUB_CLAUDE;
  delete process.env.STUB_HOT;
});

/** A bench stand-in: a case passes when the candidate's implementor prompt says `Mind <case>.` */
const fakeBench = (ran: { id: string; case: string; repeat?: number }[]) =>
  ({
    run: async (_dir: string, _t: unknown, jobs: typeof ran) => void ran.push(...jobs),
    rows: (dir: string, id: string) =>
      ran
        .filter(j => j.id === id)
        .map(j => ({
          point: 'opencode:luna/v2@e/h/s',
          case: j.case,
          repeat: j.repeat ?? 1,
          strata: {},
          hidden: +readFileSync(join(dir, 'cands', id, 'hub/agents/implementor.md'), 'utf8').includes(
            `Mind ${j.case}.`
          ) as 0 | 1,
          vsHuman: {},
          findings: { critical: 0, high: 0 },
          answers: 0,
          minutes: 2,
          tokens: {},
          usd: 0.1,
        })),
    codex: () => 10,
    propose: async () => ({}),
  }) as unknown as Parameters<typeof step>[2];

/** Fills slot d1 with a fix for f1 and d2 without a why; on resume writes d2's why. Logs each call. */
const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', d => (prompt += d));
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ cwd: process.cwd(), args, prompt }) + '\\n');
  const resumed = args.includes('--resume');
  if (!resumed) {
    fs.appendFileSync('out/d1/hub/agents/implementor.md', 'Mind f1.\\n');
    fs.writeFileSync('out/d1/why.md', 'f1 fails the hidden tests; a skill line on it.\\n');
    fs.appendFileSync('out/d2/hub/agents/implementor.md', 'Mind nothing.\\n');
  } else fs.writeFileSync('out/d2/why.md', 'f2 too.\\n');
  const window = u => ({ utilization: u, resetsAt: 0 });
  for (const e of [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: window(process.env.STUB_HOT ? 0.9 : resumed ? 0.3 : 0.2), seven_day: window(0.5) } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'cases/v1/issue.md' } }] } },
    { type: 'result', session_id: 's1', total_cost_usd: 0.5, result: 'd1 skill line' },
  ])
    console.log(JSON.stringify(e));
});
`;

const setup = () => {
  const root = tmp('skill');
  dirs.push(root);
  process.env.BOTHUB_TUNE = join(root, 'tune');
  const cases = join(root, 'cases');
  const splits: Record<string, string> = {};
  const add = (id: string, split: string, day: number) => {
    mkdirSync(join(cases, id), { recursive: true });
    const meta = { repo: 'me/demo', base: 'b', merged: 'm', mergedAt: `2026-01-${10 + day}`, tests: ['a.test.ts'] };
    writeFileSync(join(cases, id, 'case.json'), JSON.stringify(meta));
    writeFileSync(join(cases, id, 'issue.md'), `# ${id}\n`);
    splits[id] = split;
  };
  for (const [i, id] of ['m1', 'm2', 'm3', 'm4', 'f1', 'f2', 'f3', 'f4'].entries()) add(id, 'train', i);
  add('v1', 'validate', 10);
  add('v2', 'validate', 11);
  add('t1', 'test', 12);
  writeFileSync(join(root, 'splits.json'), JSON.stringify(splits));
  writeFileSync(join(root, 'claude'), stub, { mode: 0o755 });
  process.env.BOTHUB_CLAUDE = join(root, 'claude');
  process.env.STUB_LOG = join(root, 'calls.jsonl');
  return { root, cases, splits: join(root, 'splits.json'), repos: join(root, 'repos'), point: 'opencode:luna' };
};

const options = (rounds: number) => ({
  version: 't',
  rounds,
  k: 3,
  parallel: 2,
  limits: { codex: 25, claude5h: 40, claudeWeek: 12 },
  stop: { fiveHour: 100, week: 100 },
});

describe('skill benchmark', () => {
  it('runs the skill on the loop tune cases without the held-out ones, records usage and resumes', async () => {
    const s = setup();
    const ran: Parameters<typeof fakeBench>[0] = [];
    const io = fakeBench(ran);
    const like = await init('demo', s, io);
    for (const id of ['f1', 'v1']) {
      mkdirSync(join(like, 'runs/i000-init', id, 'v2/data/issue-1'), { recursive: true });
      writeFileSync(join(like, 'runs/i000-init', id, 'v2/data/issue-1/trace.jsonl'), '{}\n');
    }
    const dir = await skill(like, options(1), io);

    expect(dir).toBe(join(s.root, 'tune', 'demo', 'skill@t'));
    expect(tuneRows(dir).tune).toEqual(tuneRows(like).tune);
    const w = join(dir, 'skill', 'r001');
    expect(readdirSync(join(w, 'cases')).sort()).toEqual(['f1', 'f2', 'f3', 'f4', 'm1', 'm2', 'm3', 'm4']);
    expect(existsSync(join(w, 'runs/f1/v2/data/issue-1/trace.jsonl'))).toBe(true);
    expect(existsSync(join(w, 'runs/v1'))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(w, 'cases.json'), 'utf8')))).not.toContain('v1');
    const calls = readFileSync(s.root + '/calls.jsonl', 'utf8')
      .trim()
      .split('\n');
    expect(calls).toHaveLength(2);
    const first = JSON.parse(calls[0]!) as { cwd: string; args: string[]; prompt: string };
    expect(first.args).toContain('--restricted');
    expect(first.prompt).toMatch(/bothub:tune-graph skill in benchmark mode/);
    expect(existsSync(join(dir, 'skill/plugin/skills/tune-graph/SKILL.md'))).toBe(true);

    const steps = tuneRows(dir).steps;
    expect(steps.map(x => [x.id, x.proposer, x.verdict])).toEqual([
      ['i000-init', 'manual', 'kept'],
      ['i001-skill', 'skill', 'kept'],
      ['i001-skill-2', 'skill', 'discarded'],
    ]);
    expect(steps[1]!.evals[0]!.claude5h).toBe(5);
    expect(steps[1]!.evals.slice(1).every(e => e.claude5h === 0)).toBe(true);
    const round = JSON.parse(readFileSync(join(w, 'round.json'), 'utf8'));
    expect(round).toMatchObject({ iteration: 1, version: 't', usd: 1, claude: { after: { fiveHour: 30 } } });
    expect(round.leaks).toEqual(['Read: v1', 'Read: v1']);

    await skill(like, options(1), io);
    expect(
      readFileSync(s.root + '/calls.jsonl', 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(2);
    await skill(like, options(2), io);
    expect(readFileSync(join(dir, 'skill/r002/tried.md'), 'utf8')).toMatch(/i001-skill, skill, kept/);
    expect(readFileSync(join(dir, 'skill/r002/tried.md'), 'utf8')).not.toMatch(/\bv1\b/);
  }, 30_000);

  it('stops a session past a cap and asks the round again on resume', async () => {
    const s = setup();
    const ran: Parameters<typeof fakeBench>[0] = [];
    const io = fakeBench(ran);
    const like = await init('demo', s, io);
    process.env.STUB_HOT = '1';
    await expect(skill(like, { ...options(1), stop: { fiveHour: 75, week: 100 } }, io)).rejects.toThrow(
      /round 1 stopped: Claude 5h at 90%/
    );
    const dir = join(s.root, 'tune', 'demo', 'skill@t');
    expect(existsSync(join(dir, 'skill/r001/stopped.json'))).toBe(true);
    expect(tuneRows(dir).steps).toHaveLength(1);
    delete process.env.STUB_HOT;
    await skill(like, options(1), io);
    expect(tuneRows(dir).steps.map(x => x.id)).toEqual(['i000-init', 'i001-skill', 'i001-skill-2']);
    expect(readdirSync(join(dir, 'skill')).filter(n => n.startsWith('r001.'))).toHaveLength(1);
  }, 30_000);
});
