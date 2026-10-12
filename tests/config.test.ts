import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, effectiveCan, jobOrder, type SourceFile } from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { parseMarkdown } from '../src/markdown.ts';

const hub = join(import.meta.dirname, '../examples/hub');

const file = (path: string, frontmatter: string, body = '') => ({ path, source: `---\n${frontmatter}\n---\n${body}` });
const bot = (name: string, can = '[reply]') =>
  file(`bots/${name}.md`, `harness: claude-code\ntools: []\ncan: ${can}\nmax-turns: 5`, 'role');
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
      'caveat/codex-turn-limit',
      'convention/typecheck-clean',
      'pitfall/empty-allowlist',
    ]);
    expect(bots.reviewer).toMatchObject({ 'max-turns': 15, body: expect.stringContaining('Try to break them') });
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
    expect(errorsOf([file('bots/b.md', 'executor: codex\ntools: []\ncan: []\nmax-turns: 1')]).join()).toMatch(
      /executor/
    );
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
      'notes/rumor/b.md: unknown note kind "rumor", expected one of "decision", "convention", "pattern", "caveat", "pitfall", "unsure"',
    ]);
    const errors = errorsOf([
      { ...bot('p'), source: bot('p').source.replace('max-turns', 'skills: [gone]\nmax-turns') },
      file('checks/both.md', 'run: x\nbot: p\nskill: gone'),
      file('checks/half.md', 'bot: p'),
      file('notes/decision/a.md', 'title: A\ncheck: nope'),
    ]);
    expect(errors).toEqual([
      'offers unknown skill "gone"',
      'needs either "run" or "bot"',
      'uses unknown skill "gone"',
      'runs bot "p" but has no skill',
      'refers to unknown check "nope"',
    ]);
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
