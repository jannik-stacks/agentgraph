import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compile,
  effectiveReturns,
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
const bot = (name: string, returns = '[reply]') =>
  file(`bots/${name}.md`, `harness: opencode\ntools: []\nreturns: ${returns}\nmax-turns: 5`, 'role');
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
      'decision/parse-at-the-boundary',
      'style/small-pure-functions',
      'style/typecheck-clean',
    ]);
    expect(bots.reviewer).toMatchObject({ harness: 'pi', body: expect.stringContaining('Try to break them') });
    expect(checks.review).toMatchObject({
      type: 'bot',
      bot: 'reviewer',
      skill: 'review-file',
      over: 'each-file',
      mode: 'warn',
    });
    const flow = workflows.issue;
    expect(flow?.name).toBe('issue');
    expect(flow?.on.issue_comment?.guard?.associations).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    expect(flow?.jobs.implement).toMatchObject({ needs: [], until: { checks: ['types', 'review'], max: 2 } });
    expect(flow?.jobs.review?.mode).toBe('log');
    expect(flow?.body).toContain('/bothub');
  });

  it('rejects unknown keys and old names', () => {
    expect(errorsOf([workflow('on: {}\njobs: {}\npermissions: {}')]).join()).toMatch(/permissions/);
    expect(errorsOf([file('bots/b.md', 'harness: codex\ntools: []\nreturns: []\nmax-turns: 1')]).join()).toMatch(
      /harness/
    );
    expect(errorsOf([bot('b', '[push-branch]')]).join()).toMatch(/returns/);
    const old = (line: string) => file('bots/b.md', `harness: opencode\ntools: []\n${line}\nmax-turns: 1`, 'role');
    expect(errorsOf([old('can: [reply]')]).join()).toMatch(/Unrecognized key: "can"/);
    expect(errorsOf([old('returns: []\nnotes: [caveat]')]).join()).toMatch(/Unrecognized key: "notes"/);
    expect(errorsOf([old('returns: []\npreload: [notes]')])).not.toEqual([]);
    expect(errorsOf([file('notes/pattern/a.md', 'title: A')]).join()).toMatch(/unknown note kind "pattern"/);
  });

  it('rewrites an old session in its error, and keeps resume: session to harnesses that can', () => {
    const of = (harness: string, lines: string) =>
      file('bots/b.md', `harness: ${harness}\ntools: []\nreturns: []\n${lines}`, 'role');
    expect(errorsOf([of('opencode', 'session: { resume: attempts, share: hub }')]).join()).toMatch(
      /session is replaced by resume and history; write resume: summary and history: hub/
    );
    expect(errorsOf([of('opencode', 'session: {}\ncan: [reply]')]).join()).toMatch(
      /session is replaced by resume and history; remove it; Unrecognized keys: "can"/
    );
    expect(errorsOf([of('pi', 'resume: session')]).join()).toMatch(
      /pi cannot resume its session yet; use resume: summary/
    );
    const result = compile([of('opencode', 'resume: session\nhistory: issue')]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.bots.b).toMatchObject({ resume: 'session', history: 'issue' });
  });

  it('reads hub(<globs>) returns from a YAML flow list and keeps them inside the hub', () => {
    const result = compile([bot('p', '[reply, hub(notes/**, skills/*.md), note]')]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.bots.p?.returns).toEqual(['reply', 'hub(notes/**, skills/*.md)', 'note']);
    expect(errorsOf([bot('p', '[hub(../x/**)]')])).toEqual(['returns "hub(../x/**)": "../x/**" leaves the hub']);
    expect(errorsOf([bot('p', '[hub(/etc/**)]')])).toEqual(['returns "hub(/etc/**)": "/etc/**" leaves the hub']);
    expect(errorsOf([bot('p', '[hub()]')]).join()).toMatch(
      /must be one of reply, label, push, merge-request, merge, note, ask, or hub\(<globs>\)/
    );
  });

  it('never lets a bot return changes to hub.yaml, bots or workflows', () => {
    const reach = 'reaches hub.yaml, bots/**, workflows/**, which only a human changes';
    for (const glob of ['**', 'bots/**', 'workflows/x.md', 'hub.yaml', '*.yaml', 'bots/**/*.md'])
      expect(errorsOf([bot('p', `[hub(${glob})]`)])).toEqual([`returns "hub(${glob})": "${glob}" ${reach}`]);
    expect(errorsOf([bot('p', '[hub(notes/**, skills/**, checks/*.md)]')])).toEqual([]);
  });

  it('lets a job narrow hub globs only to globs the bot returns', () => {
    const errors = errorsOf([
      bot('p', '[reply, hub(notes/**)]'),
      skill('s'),
      workflow(
        [
          'on: { push: {} }',
          'jobs:',
          '  same: { type: bot, bot: p, skill: s, returns: [hub(notes/**)] }',
          '  inner: { type: bot, bot: p, skill: s, returns: [hub(notes/caveat/*.md)] }',
          '  wider: { type: bot, bot: p, skill: s, returns: [hub(skills/**)] }',
          '  kind: { type: bot, bot: p, skill: s, returns: [note] }',
        ].join('\n')
      ),
    ]);
    expect(errors).toEqual([
      'job "wider" returns "hub(skills/**)", which bot "p" does not return',
      'job "kind" returns "note", which bot "p" does not return',
    ]);
  });

  it('checks references between jobs, bots, skills and checks', () => {
    const errors = errorsOf([
      bot('p'),
      skill('s'),
      workflow(
        [
          'on: { pull_request: }',
          'jobs:',
          '  a: { type: bot, needs: missing, bot: p, skill: s, returns: [merge-request], until: { checks: [ghost] } }',
          '  b: { type: bot, bot: ghost, skill: s }',
          '  c: { type: script, on: { issue_comment: {} }, run: echo }',
          '  e: { type: bot, bot: p, skill: nope }',
          '  f: { type: bot, bot: p, skill: s, branch: "main-{x}" }',
          '  g: { type: script, run: echo, over: { run: ls } }',
          '  h: { type: script, run: echo, returns: [merge] }',
          '  i: { type: script, run: echo, branch: bothub/5/x, into: bothub/5 }',
          '  j: { type: script, run: echo, into: "bothub/{nope}", requires: [ghost] }',
        ].join('\n')
      ),
    ]);
    expect(errors).toEqual([
      'job "a" needs unknown job "missing"',
      'job "a" waits for unknown check "ghost"',
      'job "a" returns "merge-request", which bot "p" does not return',
      'job "b" uses unknown bot "ghost"',
      'job "c" triggers on "issue_comment", which the workflow does not listen to',
      'job "e" uses unknown skill "nope"',
      'job "f" branch "main-{x}" must start with "bothub/"',
      'job "f" branch uses unknown placeholder "{x}"',
      'job "g" runs its own command, so "over: { run }" needs type bot',
      'job "h" returns "merge" without "into", so it would merge into the default branch, which only a human does',
      'job "i" branch "bothub/5/x" sits inside "bothub/5", and git cannot hold both; try "bothub/5-…"',
      'job "j" into uses unknown placeholder "{nope}"',
      'job "j" requires unknown check "ghost"',
    ]);
    expect(errorsOf([bot('p', '[open-pr]')]).join()).toMatch(
      'there is no "open-pr"; a request to merge a branch is "merge-request"'
    );
  });

  it('names the missing or wrong type and guesses it from the fields', () => {
    expect(errorsOf([file('checks/c.md', 'run: x')])).toEqual([
      expect.stringContaining(
        'missing "type": use one of script, bot, decide; it has "run", so probably "type: script"'
      ),
    ]);
    expect(errorsOf([file('checks/c.md', 'type: robot\nbot: p')])).toEqual([
      expect.stringContaining('type "robot" is not one of script, bot, decide; it has "bot", so probably "type: bot"'),
    ]);
    expect(errorsOf([file('checks/c.md', 'mode: warn')])).toEqual([
      expect.stringContaining('missing "type": use one of script, bot, decide\n'),
    ]);
    expect(errorsOf([workflow('on: { push: {} }\njobs:\n  a: { bot: p, skill: s }')])).toEqual([
      expect.stringContaining('missing "type": use one of bot, script; it has "bot", so probably "type: bot"'),
    ]);
  });

  it('rejects fields the type does not take', () => {
    expect(errorsOf([file('checks/c.md', 'type: bot\nbot: p\nrun: npm test', 'Judge it.')])).toEqual([
      expect.stringContaining(
        'a bot check does not take "run"; to judge what a command prints, use "over: { run: <command> }"'
      ),
    ]);
    expect(errorsOf([file('checks/c.md', 'type: decide\nbot: p\nskill: s', 'Is it fine?')])).toEqual([
      expect.stringContaining('a decide check does not take "bot", "skill"'),
    ]);
    expect(errorsOf([workflow('on: { push: {} }\njobs:\n  b: { type: script, run: x, preload: [issue] }')])).toEqual([
      expect.stringContaining('a script job does not take "preload"'),
    ]);
    expect(errorsOf([file('checks/c.md', 'type: script\nrun: x\nover: { each: ls, max: 0 }')])).toHaveLength(1);
    expect(errorsOf([file('checks/c.md', 'type: script\nrun: x\nover: chunk')])).toHaveLength(1);
  });

  it('checks checks, bot skills and notes', () => {
    const result = compile([
      { ...bot('p'), source: bot('p').source.replace('max-turns', 'skills: [gone]\nmax-turns') },
      file('checks/gone.md', 'type: bot\nbot: p\nskill: gone'),
      file('notes/decision/a.md', 'title: A\ncheck: nope'),
      file('notes/rumor/b.md', 'title: B'),
    ]);
    expect(result.ok ? [] : result.errors.map(e => `${e.path}: ${e.message}`)).toEqual([
      'notes/rumor/b.md: unknown note kind "rumor", expected one of "decision", "style", "caveat"',
    ]);
    const errors = errorsOf([
      { ...bot('p'), source: bot('p').source.replace('max-turns', 'skills: [gone]\nmax-turns') },
      file('checks/gone.md', 'type: bot\nbot: p\nskill: gone'),
      file('checks/ghost.md', 'type: bot\nbot: ghost', 'Judge it.'),
      file('checks/mute.md', 'type: bot\nbot: p'),
      file('checks/blank.md', 'type: decide'),
      file('checks/own.md', 'type: script\nrun: x\nover: { run: ls }'),
      file('notes/decision/a.md', 'title: A\ncheck: nope'),
    ]);
    expect(errors).toEqual([
      'offers unknown skill "gone"',
      'uses unknown skill "gone"',
      'uses unknown bot "ghost"',
      'has no prompt: give the bot a body or a skill',
      'has no question: a decide check asks its body',
      'runs its own command, so "over: { run }" needs type bot or decide',
      'refers to unknown check "nope"',
    ]);
  });

  it('reads hub.yaml and checks preload and tools grants', () => {
    const tooled = file('bots/t.md', 'harness: opencode\ntools: [read, issues_get]\nreturns: [reply]\nmax-turns: 5');
    const result = compile([{ path: 'hub.yaml', source: 'issues: local\n' }, tooled]);
    expect(result.ok && result.config.hub).toEqual({ issues: 'local', merge: { 'default-branch': 'human' } });
    const empty = compile([]);
    expect(empty.ok && empty.config.hub).toEqual({ issues: 'github', merge: { 'default-branch': 'human' } });
    expect(errorsOf([{ path: 'hub.yaml', source: 'issues: jira\n' }])[0]).toMatch(/issues/);
    expect(
      errorsOf([
        tooled,
        skill('s'),
        workflow('on: { push: {} }\njobs:\n  a: { type: bot, bot: t, skill: s, tools: [issues_get, runs_read] }'),
      ])
    ).toEqual(['job "a" grants tool "runs_read", which bot "t" does not have']);
  });

  it('needs a threshold and a say before a decider question acts', () => {
    const errors = errorsOf([
      file(
        'bots/d.md',
        'harness: opencode\ntools: [read]\nreturns: [reply]\ndecider: [{ on: stop, ask: Done?, mode: act }]'
      ),
    ]);
    expect(errors).toEqual([expect.stringMatching(/mode act needs a "threshold" and a "say"/)]);
  });

  it('rejects tool names the harness does not have, so a bot never runs with a silently empty allowlist', () => {
    const errors = errorsOf([
      file('bots/caps.md', 'harness: opencode\ntools: [Read, bash(git diff*), issues_get]\nreturns: [reply]'),
      file('bots/pi.md', 'harness: pi\ntools: [glob, find, bash(git *)]\nreturns: [reply]'),
    ]);
    expect(errors).toEqual([
      expect.stringMatching(/^lists tool "Read", which opencode does not have \(one of read, /),
      expect.stringMatching(/^lists tool "glob", which pi does not have/),
      'lists tool "bash(git *)", but pi takes no patterns',
    ]);
  });

  it('warns that pi ignores max-turns and gets no hub tools or decider', () => {
    const result = compile([
      file(
        'bots/p.md',
        'harness: pi\ntools: [read, notes_search]\nreturns: [reply]\nmax-turns: 4\ndecider: [{ on: stop, ask: Done? }]'
      ),
    ]);
    expect(result.ok && result.warnings.map(w => w.message)).toEqual([
      '"max-turns" is declared, not enforced: pi has no turn limit, only the run timeout stops it',
      'lists hub tools (notes_search) that pi runs do not get',
      'asks decider questions, which pi runs do not get',
    ]);
    const quiet = compile([file('bots/p.md', 'harness: pi\ntools: [read]\nreturns: [reply]')]);
    expect(quiet.ok && quiet.warnings).toEqual([]);
  });

  it('warns about fields it does not enforce, checks that never run and loops that never repeat', async () => {
    const result = compile([
      { ...bot('b'), source: bot('b').source.replace('max-turns', 'budget: { usd-per-run: 2 }\nmax-turns') },
      skill('s'),
      file('checks/quiet.md', 'type: script\nrun: x'),
      file('checks/judge.md', 'type: decide\nmode: block', 'Is it fine?'),
      file('checks/tuned.md', 'type: decide\nthreshold: 0.7\nmode: block', 'Is it fine?'),
      workflow(
        [
          'on: { issues: {} }',
          'jobs:',
          '  a: { type: bot, bot: b, skill: s, over: each-file, until: { checks: [quiet] } }',
          '  c: { type: bot, bot: b, skill: s, until: { checks: [quiet, judge] } }',
        ].join('\n')
      ),
    ]);
    expect(result.ok && result.warnings.map(w => `${w.path}: ${w.message}`)).toEqual([
      'checks/judge.md: decides in block mode without a "threshold"; tune one in log mode first',
      'checks/tuned.md: no job lists it in "until" or "requires", so it never runs',
      'workflows/w.md: job "a" loops until checks that are all in log mode, so it never repeats',
    ]);
    const examples = compile(await readHub(hub));
    expect(examples.ok && examples.warnings).toEqual([]);
  });

  it('rejects needs cycles', () => {
    const errors = errorsOf([
      workflow('on: {}\njobs:\n  a: { type: script, needs: b, run: x }\n  b: { type: script, needs: [a], run: x }'),
    ]);
    expect(errors).toContain('needs cycle: a -> b -> a');
  });
});

describe('effectiveReturns', () => {
  it('narrows the bot to the job', () => {
    expect(effectiveReturns({ returns: ['reply', 'push', 'ask'] }, { returns: ['push', 'label'] })).toEqual(['push']);
    expect(effectiveReturns({ returns: ['reply'] }, {})).toEqual(['reply']);
  });
});

describe('effective context', () => {
  const bot = { tools: ['read', 'issues_get', 'notes_search'], preload: ['issue' as const] };

  it('splits hub tools from harness tools and lets the job narrow them', () => {
    expect(harnessTools(bot)).toEqual(['read']);
    expect(effectiveTools(bot, {})).toEqual(['issues_get', 'notes_search']);
    expect(effectiveTools(bot, { tools: ['issues_get'] })).toEqual(['issues_get']);
  });

  it('takes the job preload, then the bot preload, then nothing', () => {
    expect(effectivePreload(bot, { preload: ['links'] })).toEqual(['links']);
    expect(effectivePreload(bot, {})).toEqual(['issue']);
    expect(effectivePreload({}, {})).toEqual([]);
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
