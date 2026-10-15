import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, Either } from 'effect';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadHub } from '../src/hub.ts';

const core = join(import.meta.dirname, '..');

/** A hub directory with `files` written into it. */
const hubDir = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'core-hub-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

/** A real hub around a fixture's workflows: one file per bot, skill and check its hub.yaml names. */
const fromFixture = (name: string) => {
  const fixture = join(core, 'fixtures', name);
  const names = parse(readFileSync(join(fixture, 'hub.yaml'), 'utf8')) as {
    bots: string[];
    skills: string[];
    checks: Record<string, string>;
  };
  const dir = hubDir({
    'hub.yaml': 'repo: o/r\nlimits: { minutes: 20 }\n',
    ...Object.fromEntries(names.bots.map(b => [`bots/${b}.md`, `---\nharness: opencode\n---\nYou are ${b}.\n`])),
    ...Object.fromEntries(
      names.skills.map((s, i) => [
        i % 2 ? `skills/${s}.md` : `skills/${s}/SKILL.md`,
        `---\nname: ${s}\ndescription: Do ${s}.\n---\nSteps for ${s}.\n`,
      ])
    ),
    ...Object.fromEntries(
      Object.entries(names.checks).map(([c, mode]) => [`checks/${c}.md`, `---\nmode: ${mode}\nrun: make ${c}\n---\n`])
    ),
  });
  cpSync(join(fixture, 'workflows'), join(dir, 'workflows'), { recursive: true });
  return { dir, names };
};

const problems = async (dir: string) => {
  const result = await Effect.runPromise(Effect.either(loadHub(dir)));
  if (Either.isRight(result)) throw new Error('expected problems');
  return result.left.problems.map(p => `${p.path}: ${p.message}`);
};

describe('loadHub', () => {
  it.each(['bothub', 'clarinet', 'acme-app', 'hub', 'loop'])('loads a hub around the %s fixture', async name => {
    const { dir, names } = fromFixture(name);
    const hub = await Effect.runPromise(loadHub(dir));
    expect(Object.keys(hub.bots).sort()).toEqual([...names.bots].sort());
    expect(Object.keys(hub.skills).sort()).toEqual([...names.skills].sort());
    expect(Object.keys(hub.checks).sort()).toEqual(Object.keys(names.checks).sort());
    expect(Object.keys(hub.workflows).length).toBeGreaterThan(0);
  });

  it('fills the defaults and keeps each file as a doc', async () => {
    const { dir } = fromFixture('acme-app');
    const hub = await Effect.runPromise(loadHub(dir));
    expect(hub.repo).toBe('o/r');
    expect(hub.limits).toEqual({ minutes: 20, usdPerRun: 10, working: 2 });
    expect(hub.bots.implementor).toEqual({
      harness: 'opencode',
      tools: [],
      returns: ['reply'],
      name: 'implementor',
      path: 'bots/implementor.md',
      body: 'You are implementor.',
    });
    expect(hub.skills.implement!.description).toBe('Do implement.');
    expect(hub.checks.safety).toMatchObject({ mode: 'stop', run: 'make safety', body: '' });
    expect(hub.workflows.issue!.path).toBe('workflows/issue.md');
    expect(hub.sha).toMatch(/^[0-9a-f]{64}$/);
    expect((await Effect.runPromise(loadHub(dir))).sha).toBe(hub.sha);
  });

  it('names what replaces each key of the previous format', async () => {
    const found = await problems(join(core, '..', 'examples', 'acme-app'));
    expect(found).toEqual(
      expect.arrayContaining([
        'hub.yaml: issues is gone; threads come from the forge',
        'hub.yaml: deps is gone; remove it',
        'bots/implementor.md: skills is gone; a step names its skill',
        'bots/implementor.md: max-turns is gone; limits.minutes in hub.yaml ends a session that hangs',
        'bots/implementor.md: returns: merge-request is now pull',
        'bots/implementor.md: returns: note is gone; memory is docs in the repo, written by a push',
        'checks/tests.md: type is gone; run makes a script check and judge a bot check',
        'checks/docs-tone.md: bot is gone; name the bot as judge',
        'workflows/issue.md: jobs is gone; rewrite it as steps: each job becomes a step in needs order, until.checks becomes checks, over: each-hunk becomes each: hunks',
        'workflows/issue.md: on.issue_comment.guard is gone; only owners, members and collaborators reach bots',
      ])
    );
    expect(found.filter(p => p.startsWith('workflows/issue.md')).every(p => p.includes(' is gone; '))).toBe(true);
  });

  it('names session and resume on a bot', async () => {
    const dir = hubDir({ 'bots/a.md': '---\nharness: claude\nsession: { resume: attempts }\nresume: true\n---\n' });
    expect(await problems(dir)).toEqual([
      'bots/a.md: session is gone; a step starts a fresh session and a retry resumes it',
      'bots/a.md: resume is gone; a step starts a fresh session and a retry resumes it',
    ]);
  });

  it('reports wrong values, unknown keys, unknown judges and checks without a command or judge', async () => {
    const dir = hubDir({
      'hub.yaml': 'limits: { working: many }\n',
      'bots/a.md': '---\nharness: codex\ncolor: red\n---\n',
      'checks/judged.md': '---\nmode: block\njudge: ghost\n---\n',
      'checks/empty.md': '---\nmode: warn\n---\n',
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { bot: a, checks: [judged, nope] }\n---\n',
    });
    const found = await problems(dir);
    expect(found.some(p => p.startsWith('hub.yaml: limits.working: '))).toBe(true);
    expect(found.some(p => p.startsWith('bots/a.md: harness: '))).toBe(true);
    expect(found.some(p => p.startsWith('bots/a.md: color: '))).toBe(true);
    expect(found).toContain('checks/judged.md: judge: unknown bot ghost');
    expect(found).toContain('checks/empty.md: name run, judge or both');
    expect(found).toContain('workflows/w.md: steps.x.checks: unknown check nope');
  });

  it('reports broken frontmatter and a skill defined twice', async () => {
    const dir = hubDir({
      'bots/a.md': '---\nharness: [claude\n---\n',
      'skills/s.md': '---\ndescription: one\n---\n',
      'skills/s/SKILL.md': '---\ndescription: two\n---\n',
    });
    const found = await problems(dir);
    expect(found[0]).toMatch(/^bots\/a\.md: frontmatter: /);
    expect(found).toContain('skills/s/SKILL.md: s is defined twice');
  });
});
