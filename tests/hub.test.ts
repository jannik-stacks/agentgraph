import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, Either } from 'effect';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadHub } from '../src/hub.ts';

/** A hub directory with `files` written into it. */
const hubDir = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-hub-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

/** A real hub around a fixture's workflows: one file per agent, skill and check its hub.yaml names. */
const fromFixture = (name: string) => {
  const fixture = join(import.meta.dirname, 'fixtures', name);
  const names = parse(readFileSync(join(fixture, 'hub.yaml'), 'utf8')) as {
    agents: string[];
    skills: string[];
    checks: Record<string, string | { mode: string; agent: string }>;
  };
  const dir = hubDir({
    'hub.yaml': 'repo: o/r\nlimits: { minutes: 20 }\n',
    ...Object.fromEntries(names.agents.map(b => [`agents/${b}.md`, `---\nharness: opencode\n---\nYou are ${b}.\n`])),
    ...Object.fromEntries(
      names.skills.map((s, i) => [
        i % 2 ? `skills/${s}.md` : `skills/${s}/SKILL.md`,
        `---\nname: ${s}\ndescription: Do ${s}.\n---\nSteps for ${s}.\n`,
      ])
    ),
    ...Object.fromEntries(
      Object.entries(names.checks).map(([c, check]) => {
        const { mode, agent } = typeof check === 'string' ? { mode: check, agent: undefined } : check;
        return [`checks/${c}.md`, `---\nmode: ${mode}\nrun: make ${c}\n${agent ? `agent: ${agent}\n` : ''}---\n`];
      })
    ),
  });
  cpSync(join(fixture, 'workflows'), join(dir, 'workflows'), { recursive: true });
  return { dir, names };
};

const problems = async (dir: string) => {
  const result = await Effect.runPromise(Effect.either(loadHub(dir)));
  if (Either.isRight(result)) throw new Error('expected problems');
  return result.left.message.split('\n');
};

describe('loadHub', () => {
  it.each(['bothub', 'clarinet', 'acme-app', 'hub', 'loop'])('loads a hub around the %s fixture', async name => {
    const { dir, names } = fromFixture(name);
    const hub = await Effect.runPromise(loadHub(dir));
    expect(Object.keys(hub.agents).sort()).toEqual([...names.agents].sort());
    expect(Object.keys(hub.skills).sort()).toEqual([...names.skills].sort());
    expect(Object.keys(hub.checks).sort()).toEqual(Object.keys(names.checks).sort());
    expect(Object.keys(hub.workflows).length).toBeGreaterThan(0);
  });

  it('fills the defaults and keeps each file as a doc', async () => {
    const { dir } = fromFixture('acme-app');
    const hub = await Effect.runPromise(loadHub(dir));
    expect(hub.repo).toBe('o/r');
    expect(hub.limits).toEqual({ minutes: 20, usdPerRun: 10, parallel: 2, sessions: 4 });
    expect(hub.agents.implementor).toEqual({
      harness: 'opencode',
      tools: [],
      returns: ['comment'],
      name: 'implementor',
      path: 'agents/implementor.md',
      body: 'You are implementor.',
    });
    expect(hub.skills.implement!.description).toBe('Do implement.');
    expect(hub.checks.safety).toMatchObject({ mode: 'stop', run: 'make safety', body: '' });
    expect(hub.workflows.issue!.path).toBe('workflows/issue.md');
    expect(hub.sha).toMatch(/^[0-9a-f]{64}$/);
    expect((await Effect.runPromise(loadHub(dir))).sha).toBe(hub.sha);
  });

  it('names what replaces each key of the previous format', async () => {
    const found = await problems(
      hubDir({
        'hub.yaml': 'issues: local\ndeps: { install: npm ci }\n',
        'bots/implementor.md':
          '---\nharness: opencode\nreturns: [reply, merge-request, note]\nskills: [implement]\n---\n',
        'checks/tests.md': '---\ntype: script\nrun: npm test\nmode: block\n---\n',
        'checks/docs-tone.md': '---\ntype: bot\nbot: implementor\nmode: warn\n---\n',
        'workflows/issue.md':
          '---\non: { issue_comment: { command: /bothub, guard: { associations: [OWNER] } } }\nsteps:\n  a: { agent: implementor }\n---\n',
      })
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'hub.yaml: issues is gone; the forge lists them',
        'hub.yaml: deps is gone; name the install command as setup',
        'bots/implementor.md: skills is gone; a step names its skill',
        'bots/implementor.md: returns: merge-request is now pull_request',
        'bots/implementor.md: returns: note is gone; memory is docs in the repo, written by a push',
        'bots: bots/ is now agents/; rename the folder',
        'checks/tests.md: type is gone; name run for a script check and agent for a judged one',
        'checks/docs-tone.md: bot is gone; name it as agent',
        'workflows/issue.md: on.issue_comment.guard is gone; only owners, members and collaborators reach agents',
      ])
    );
    expect(found.filter(p => p.startsWith('workflows/issue.md')).every(p => p.includes(' is gone; '))).toBe(true);
  });

  it('names the bots folder, max-turns on an agent and jobs in a workflow', async () => {
    const dir = hubDir({
      'bots/a.md': '---\nharness: opencode\nmax-turns: 40\n---\n',
      'workflows/w.md': '---\njobs: { a: { type: bot, bot: a } }\n---\n',
    });
    expect(await problems(dir)).toEqual(
      expect.arrayContaining([
        'bots: bots/ is now agents/; rename the folder',
        'bots/a.md: max-turns is gone; limits.minutes in hub.yaml ends a session that hangs',
        'workflows/w.md: jobs is gone; rewrite it as steps: each job becomes a step in needs order, until.checks becomes checks, over: each-hunk becomes each: hunks',
      ])
    );
  });

  it('names session and resume on an agent', async () => {
    const dir = hubDir({
      'agents/a.md': '---\nharness: claude\nsession: { resume: attempts }\nresume: true\n---\n',
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a }\n---\n',
    });
    expect(await problems(dir)).toEqual([
      'agents/a.md: session is gone; a step starts a fresh session and a retry resumes it',
      'agents/a.md: resume is gone; a step starts a fresh session and a retry resumes it',
    ]);
  });

  it('reports wrong values, unknown keys, unknown agents and checks without a command or agent', async () => {
    const dir = hubDir({
      'hub.yaml': 'limits: { parallel: many }\n',
      'agents/a.md': '---\nharness: codex\ncolor: red\n---\n',
      'checks/judged.md': '---\nmode: block\nagent: ghost\n---\n',
      'checks/empty.md': '---\nmode: warn\n---\n',
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a, checks: [judged, nope] }\n---\n',
    });
    const found = await problems(dir);
    expect(found.some(p => p.startsWith('hub.yaml: limits.parallel: '))).toBe(true);
    expect(found.some(p => p.startsWith('agents/a.md: harness: '))).toBe(true);
    expect(found.some(p => p.startsWith('agents/a.md: color: '))).toBe(true);
    expect(found).toContain('checks/judged.md: agent: unknown agent ghost');
    expect(found).toContain('checks/empty.md: name run, agent or both');
    expect(found).toContain('workflows/w.md: steps.x.checks: unknown check nope');
  });

  it('fails on a skill that uses an unknown skill', async () => {
    const dir = hubDir({
      'agents/a.md': '---\nharness: opencode\n---\n',
      'skills/x.md': '---\nuses: [rules, ghost]\n---\nDo x.\n',
      'skills/rules.md': 'Keep it small.\n',
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a }\n---\n',
    });
    expect(await problems(dir)).toEqual(['skills/x.md: uses: unknown skill ghost']);
  });

  it('fails on a skill no step names and no skill uses, and on a folder neither it nor a hub script reads', async () => {
    const dir = hubDir({
      'agents/a.md': '---\nharness: opencode\n---\n',
      'skills/x.md': '---\nuses: [rules]\n---\nDo x.\n',
      'skills/rules.md': 'Keep it small.\n',
      'skills/orphan.md': 'Never read.\n',
      'scripts/check.mjs': '',
      'fixtures/check.jsonl': '',
      'notes/style/a.md': 'A note.\n',
      'issues/1-a.md': 'An issue.\n',
      'scripts/brief.mjs': "const dir = join(process.env.BOTHUB_HUB, 'issues');\n",
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a }\n---\n',
    });
    expect(await problems(dir)).toEqual([
      "skills/orphan.md: no step names orphan and no skill uses it; name it as a step's skill or in a skill's uses, or remove it",
      'notes: nothing reads notes/; the engine loads agents, skills, checks and workflows, and a hub script reads a folder through $BOTHUB_HUB',
    ]);
  });

  it('fails on a check and an agent no step names, and on a body naming a kind the engine lacks', async () => {
    const dir = hubDir({
      'agents/a.md': '---\nharness: opencode\n---\n',
      'agents/idle.md': '---\nharness: opencode\n---\nEnd with a `comment`.\n',
      'agents/judge.md': '---\nharness: opencode\n---\n',
      'checks/used.md': '---\nmode: warn\nagent: judge\n---\n',
      'checks/idle.md': '---\nmode: warn\nrun: "true"\n---\n',
      'skills/s.md': 'End with one `reply`, a `close` or {"kind": "merge-request"}, never a `comment`.\n',
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a, skill: s, checks: [used] }\n---\n',
    });
    expect(await problems(dir)).toEqual([
      'skills/s.md: names the proposal kind reply, which the engine does not have: reply is now comment',
      'skills/s.md: names the proposal kind close, which the engine does not have: close is gone; a lone comment that answers the issue ends the run',
      'skills/s.md: names the proposal kind merge-request, which the engine does not have: merge-request is now pull_request',
      'checks/idle.md: no step names idle in its checks; name it in a step or remove it',
      'agents/idle.md: no step or check names idle as its agent; name it in a step or remove it',
    ]);
  });

  it('fails retired words in any hub prompt, naming the word and what to say now', async () => {
    const dir = hubDir({
      'agents/a.md': '---\nharness: opencode\n---\nOpen a merge request.\n',
      'skills/s.md': 'A human answers with `/bothub <answer>` on the issue.\n',
      'checks/c.md': '---\nmode: warn\nrun: "true"\n---\nReads bots/triage.md.\n',
      'workflows/w.md':
        '---\non: issues\nsteps:\n  x: { agent: a, skill: s, checks: [c] }\n---\nThe persona runs for-each file.\n',
    });
    expect(await problems(dir)).toEqual([
      'agents/a.md: says "merge request", which is retired; say pull request',
      'skills/s.md: says "/bothub <", which is retired; say a plain reply answers and a reply of stop ends the run, with no command',
      'checks/c.md: says "bots/", which is retired; say agents/',
      'workflows/w.md: says "persona", which is retired; say agent, or harness for the program that runs a session',
      'workflows/w.md: says "for-each", which is retired; say returns: and each:',
    ]);
  });

  it('reads the milestone and the trust list, unset by default', async () => {
    const set = await Effect.runPromise(loadHub(hubDir({ 'hub.yaml': 'milestone: v1\ntrust: [ana, bob]\n' })));
    expect(set.milestone).toBe('v1');
    expect(set.trust).toEqual(['ana', 'bob']);
    const unset = await Effect.runPromise(loadHub(hubDir({ 'hub.yaml': 'repo: o/r\n' })));
    expect([unset.milestone, unset.trust]).toEqual([undefined, undefined]);
  });

  it('reads the image and network every command of a run gets, and refuses an image that reads as a flag', async () => {
    const hub = await Effect.runPromise(loadHub(hubDir({ 'hub.yaml': 'image: acme-rust:1\nnetwork: models\n' })));
    expect([hub.image, hub.network]).toEqual(['acme-rust:1', 'models']);
    const found = await problems(hubDir({ 'hub.yaml': 'image: --privileged\nnetwork: open\n' }));
    expect(found.some(p => p.startsWith('hub.yaml: image: '))).toBe(true);
    expect(found.some(p => p.startsWith('hub.yaml: network: '))).toBe(true);
  });

  it('reports broken frontmatter and a skill defined twice', async () => {
    const dir = hubDir({
      'agents/a.md': '---\nharness: [claude\n---\n',
      'skills/s.md': '---\ndescription: one\n---\n',
      'skills/s/SKILL.md': '---\ndescription: two\n---\n',
    });
    const found = await problems(dir);
    expect(found[0]).toMatch(/^agents\/a\.md: frontmatter: /);
    expect(found).toContain('skills/s/SKILL.md: s is defined twice');
  });
});
