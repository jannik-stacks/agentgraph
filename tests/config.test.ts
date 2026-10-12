import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compile,
  effectiveCan,
  effectivePreload,
  effectiveTools,
  harnessTools,
  jobOrder,
  type SourceFile,
} from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { parseMarkdown } from '../src/markdown.ts';

const hub = join(import.meta.dirname, '../examples/hub');

const file = (path: string, frontmatter: string, body = '') => ({ path, source: `---\n${frontmatter}\n---\n${body}` });
const bot = (name: string, can = '[reply]') =>
  file(`bots/${name}.md`, `harness: opencode\ntools: []\ncan: ${can}\nmax-turns: 5`, 'role');
const skill = (name: string) => file(`skills/${name}.md`, 'description: does it', 'prompt');
const workflow = (frontmatter: string) => file('workflows/w.md', frontmatter);
const errorsOf = (files: SourceFile[]) => {
  const result = compile(files);
  return result.ok ? [] : result.errors.map(e => e.message);
};

describe('parseMarkdown', () => {
  it('splits frontmatter and body', () => {
    expect(parseMarkdown('---\na: 1\n---\n\nbody\n')).toEqual({ data: { a: 1 }, body: 'body' });
    expect(() => parseMarkdown('no frontmatter')).toThrow('missing YAML frontmatter');
  });
});

describe('compile', () => {
  it('accepts the example hub and applies defaults', async () => {
    const result = compile(await readHub(hub));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { bots, skills, checks, workflows, notes } = result.config;
    expect(Object.keys(bots).sort()).toEqual(['implementor', 'reviewer']);
    expect(Object.keys(skills).sort()).toEqual(['implement', 'review', 'review-file']);
    expect(Object.keys(checks).sort()).toEqual(['review', 'types']);
    expect(notes.map(n => `${n.kind}/${n.name}`)).toEqual([
      'caveat/empty-allowlist',
      'caveat/esm-only-bin',
      'convention/typecheck-clean',
      'decision/parse-at-the-boundary',
      'pattern/small-pure-functions',
    ]);
    expect(bots.reviewer).toMatchObject({ harness: 'pi', body: expect.stringContaining('Try to break them') });
    expect(checks.review).toMatchObject({ bot: 'reviewer', 'for-each': 'file', mode: 'warn' });
    const flow = workflows.issue;
    expect(flow?.name).toBe('issue');
    expect(flow?.on.issue_comment?.guard?.associations).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    expect(flow?.jobs.implement).toMatchObject({ needs: [], until: { checks: ['types', 'review'], max: 2 } });
    expect(flow?.jobs.review?.mode).toBe('shadow');
    expect(flow?.body).toContain('/bothub');
  });

  it('rejects unknown keys and old names', () => {
    expect(errorsOf([workflow('on: {}\njobs: {}\npermissions: {}')]).join()).toMatch(/permissions/);
    expect(errorsOf([file('bots/b.md', 'harness: codex\ntools: []\ncan: []\nmax-turns: 1')]).join()).toMatch(/harness/);
    expect(errorsOf([bot('b', '[push-branch]')]).join()).toMatch(/can/);
  });

  it('checks references between jobs, bots, skills and checks', () => {
    const errors = errorsOf([
      bot('p'),
      skill('s'),
      workflow(
        [
          'on: { pull_request: }',
          'jobs:',
          '  a: { needs: missing, bot: p, skill: s, can: [open-pr], until: { checks: [ghost] } }',
          '  b: { bot: ghost, skill: s }',
          '  c: { on: { issue_comment: {} }, run: echo }',
          '  d: { bot: p }',
          '  e: { skill: nope }',
          '  f: { run: echo, until: { checks: [ghost] }, branch: "main-{x}" }',
        ].join('\n')
      ),
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        'job "a" needs unknown job "missing"',
        'job "a" waits for unknown check "ghost"',
        'job "a" allows "open-pr", which bot "p" cannot do',
        'job "b" uses unknown bot "ghost"',
        'job "c" triggers on "issue_comment", which the workflow does not listen to',
        'job "d" runs bot "p" but has no skill',
        'job "e" needs either "bot" and "skill", or "run"',
        'job "e" uses unknown skill "nope"',
        'job "f" loops "until" checks pass but has no bot',
        'job "f" branch "main-{x}" must start with "bothub/"',
        'job "f" branch uses unknown placeholder "{x}"',
      ])
    );
  });

  it('checks checks, bot skills and notes', () => {
    const result = compile([
      { ...bot('p'), source: bot('p').source.replace('max-turns', 'skills: [gone]\nmax-turns') },
      file('checks/both.md', 'run: x\nbot: p\nskill: gone'),
      file('checks/half.md', 'bot: p'),
      file('notes/decision/a.md', 'title: A\ncheck: nope'),
      file('notes/rumor/b.md', 'title: B'),
    ]);
    expect(result.ok ? [] : result.errors.map(e => `${e.path}: ${e.message}`)).toEqual([
      'notes/rumor/b.md: unknown note kind "rumor", expected one of "decision", "convention", "pattern", "caveat"',
    ]);
    const errors = errorsOf([
      { ...bot('p'), source: bot('p').source.replace('max-turns', 'skills: [gone]\nmax-turns') },
      file('checks/both.md', 'run: x\nbot: p\nskill: gone'),
      file('checks/half.md', 'bot: p'),
      file('notes/decision/a.md', 'title: A\ncheck: nope'),
    ]);
    expect(errors).toEqual([
      'offers unknown skill "gone"',
      'needs one of "run", "bot" or "decide"',
      'uses unknown skill "gone"',
      'runs bot "p" but has no skill',
      'refers to unknown check "nope"',
    ]);
  });

  it('reads hub.yaml and checks preload and tools grants', () => {
    const tooled = file('bots/t.md', 'harness: opencode\ntools: [read, issues_get]\ncan: [reply]\nmax-turns: 5');
    const result = compile([{ path: 'hub.yaml', source: 'issues: local\n' }, tooled]);
    expect(result.ok && result.config.hub).toEqual({ issues: 'local' });
    const empty = compile([]);
    expect(empty.ok && empty.config.hub).toEqual({ issues: 'github' });
    expect(errorsOf([{ path: 'hub.yaml', source: 'issues: jira\n' }])[0]).toMatch(/issues/);
    expect(
      errorsOf([
        tooled,
        skill('s'),
        workflow(
          'on: { push: {} }\njobs:\n  a: { bot: t, skill: s, tools: [issues_get, runs_read] }\n  b: { run: x, preload: [issue] }'
        ),
      ])
    ).toEqual([
      'job "a" grants tool "runs_read", which bot "t" does not have',
      'job "b" has "preload" or "tools" but no bot',
    ]);
  });

  it('rejects tool names the harness does not have, so a bot never runs with a silently empty allowlist', () => {
    const errors = errorsOf([
      file('bots/caps.md', 'harness: opencode\ntools: [Read, bash(git diff*), issues_get]\ncan: [reply]'),
      file('bots/pi.md', 'harness: pi\ntools: [glob, find, bash(git *)]\ncan: [reply]'),
    ]);
    expect(errors).toEqual([
      expect.stringMatching(/^lists tool "Read", which opencode does not have \(one of read, /),
      expect.stringMatching(/^lists tool "glob", which pi does not have/),
      'lists tool "bash(git *)", but pi takes no patterns',
    ]);
  });

  it('warns that pi ignores max-turns and gets no hub tools', () => {
    const result = compile([file('bots/p.md', 'harness: pi\ntools: [read, notes_search]\ncan: [reply]\nmax-turns: 4')]);
    expect(result.ok && result.warnings.map(w => w.message)).toEqual([
      '"max-turns" is declared, not enforced: pi has no turn limit, only the run timeout stops it',
      'lists hub tools (notes_search) that pi runs do not get',
    ]);
    const quiet = compile([file('bots/p.md', 'harness: pi\ntools: [read]\ncan: [reply]')]);
    expect(quiet.ok && quiet.warnings).toEqual([]);
  });

  it('warns about fields it does not enforce and loops that never repeat', async () => {
    const result = compile([
      { ...bot('b'), source: bot('b').source.replace('max-turns', 'budget: { usd-per-run: 2 }\nmax-turns') },
      skill('s'),
      file('checks/quiet.md', 'run: x'),
      file('checks/judge.md', "decide: { question: 'Is it fine?' }\nmode: block"),
      file('checks/tuned.md', "decide: { question: 'Is it fine?', threshold: 0.7 }\nmode: block"),
      workflow(
        [
          'on: { issues: {} }',
          'jobs:',
          '  a: { bot: b, skill: s, for-each: file, until: { checks: [quiet] } }',
          '  c: { bot: b, skill: s, until: { checks: [quiet, judge] } }',
        ].join('\n')
      ),
    ]);
    expect(result.ok && result.warnings.map(w => `${w.path}: ${w.message}`)).toEqual([
      'bots/b.md: "usd-per-run" is declared, not enforced: harness "opencode" reports no cost',
      'checks/judge.md: decides in block mode without a "threshold"; tune one in shadow mode first',
      'workflows/w.md: job "a" has "for-each", declared, not enforced: the job runs once over all its changes',
      'workflows/w.md: job "a" loops until checks that are all in shadow mode, so it never repeats',
    ]);
    const examples = compile(await readHub(hub));
    expect(examples.ok && examples.warnings).toEqual([]);
  });

  it('rejects needs cycles', () => {
    const errors = errorsOf([workflow('on: {}\njobs:\n  a: { needs: b, run: x }\n  b: { needs: [a], run: x }')]);
    expect(errors).toContain('needs cycle: a -> b -> a');
  });
});

describe('effectiveCan', () => {
  it('narrows the bot to the job', () => {
    expect(effectiveCan({ can: ['reply', 'push', 'ask'] }, { can: ['push', 'label'] })).toEqual(['push']);
    expect(effectiveCan({ can: ['reply'] }, {})).toEqual(['reply']);
  });
});

describe('effective context', () => {
  const bot = { tools: ['read', 'issues_get', 'notes_search'], preload: ['issue' as const] };

  it('splits hub tools from harness tools and lets the job narrow them', () => {
    expect(harnessTools(bot)).toEqual(['read']);
    expect(effectiveTools(bot, {})).toEqual(['issues_get', 'notes_search']);
    expect(effectiveTools(bot, { tools: ['issues_get'] })).toEqual(['issues_get']);
  });

  it('takes the job preload, then the bot preload, then the notes alone', () => {
    expect(effectivePreload(bot, { preload: ['links'] })).toEqual(['links']);
    expect(effectivePreload(bot, {})).toEqual(['issue']);
    expect(effectivePreload({}, {})).toEqual(['notes']);
  });
});

describe('jobOrder', () => {
  it('puts every job after the jobs it needs', () => {
    const jobs = {
      ship: { needs: ['lint', 'test'] },
      lint: { needs: ['changed'] },
      test: { needs: ['changed'] },
      changed: { needs: [] },
    };
    expect(jobOrder({ jobs } as never)).toEqual(['changed', 'lint', 'test', 'ship']);
  });
});
