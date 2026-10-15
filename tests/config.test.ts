import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compile,
  effectiveReturns,
  effectiveRun,
  harnessTools,
  hubTools,
  limitsOf,
  nextOf,
  stepOrder,
  triesOf,
  type SourceFile,
} from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { parseMarkdown } from '../src/markdown.ts';

const hub = join(import.meta.dirname, '../examples/hub');

const file = (path: string, frontmatter: string, body = '') => ({ path, source: `---\n${frontmatter}\n---\n${body}` });
const bot = (name: string, returns = '[reply]') =>
  file(`bots/${name}.md`, `harness: opencode\ntools: []\nreturns: ${returns}`, 'role');
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
    expect(flow?.steps.implement).toMatchObject({ bot: 'implementor', checks: ['types', 'review'], tries: 3 });
    expect(flow?.steps.review).toMatchObject({ wait: 'human' });
    expect(workflows.review?.steps.review).toMatchObject({ bot: 'reviewer', over: 'event' });
    expect(flow?.body).toContain('/bothub');
  });

  it('rejects unknown keys and old names', () => {
    expect(errorsOf([workflow('on: {}\nsteps: { a: { run: x } }\npermissions: {}')]).join()).toMatch(/permissions/);
    expect(errorsOf([file('bots/b.md', 'harness: codex\ntools: []\nreturns: []')]).join()).toMatch(/harness/);
    expect(errorsOf([bot('b', '[push-branch]')]).join()).toMatch(/returns/);
    const old = (line: string) => file('bots/b.md', `harness: opencode\ntools: []\n${line}`, 'role');
    expect(errorsOf([old('can: [reply]')]).join()).toMatch(/Unrecognized key: "can"/);
    expect(errorsOf([old('returns: []\nnotes: [caveat]')]).join()).toMatch(/Unrecognized key: "notes"/);
    expect(errorsOf([old('returns: []\npreload: [notes]')])).not.toEqual([]);
    expect(errorsOf([file('notes/pattern/a.md', 'title: A')]).join()).toMatch(/unknown note kind "pattern"/);
  });

  it('rewrites an old session in its error, and keeps context: resume to harnesses that can', () => {
    const of = (harness: string, lines: string) =>
      file('bots/b.md', `harness: ${harness}\ntools: []\nreturns: []\n${lines}`, 'role');
    expect(errorsOf([of('opencode', 'session: { resume: attempts, share: hub }')]).join()).toMatch(
      /session is replaced by context and history; write context: summary and history: hub/
    );
    expect(errorsOf([of('opencode', 'session: {}\ncan: [reply]')]).join()).toMatch(
      /session is replaced by context and history; remove it; Unrecognized keys: "can"/
    );
    expect(errorsOf([of('pi', 'context: resume')]).join()).toMatch(/sets context "resume", which pi cannot honor/);
    expect(errorsOf([of('opencode', 'resume: summary')]).join()).toMatch(/resume is replaced by context/);
    expect(errorsOf([of('opencode', 'context: session')]).join()).toMatch(/session is now named resume/);
    const result = compile([of('opencode', 'context: resume\nhistory: issue')]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.config.bots.b).toMatchObject({ context: 'resume', history: 'issue' });
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

  it('says what to write in place of the old bot, check and job keys', () => {
    const botErrors = (lines: string) =>
      errorsOf([file('bots/b.md', `harness: opencode\ntools: []\nreturns: []\n${lines}`, 'role')]).join();
    expect(botErrors('max-turns: 5')).toMatch(/drop "max-turns"/);
    expect(botErrors('concurrency: 2')).toMatch(/limits: \{ bots: \{ <bot>: \{ sessions: 2 \} \} \}/);
    expect(botErrors('budget: { runs-per-day: 9, minutes: 5 }')).toMatch(/limits/);
    expect(botErrors('budget: { runs-per-day: 9, minutes: 5 }')).toMatch(/minutes/);
    const checkErrors = (lines: string) =>
      errorsOf([file('checks/c.md', `type: bot\nbot: b\n${lines}`, 'Judge.')]).join();
    expect(checkErrors('max-turns: 3')).toMatch(/drop "max-turns"/);
    expect(checkErrors('concurrency: 3')).toMatch(/concurrency/);
    expect(checkErrors('over: { each: ls, max: 4 }')).toMatch(/items: 4/);
    expect(checkErrors('over: { each-hunk: { max: 20 } }')).toMatch(/write "over: each-hunk" and "items: 20"/);
    const stepErrors = (step: string) => errorsOf([workflow(`on: { push: {} }\nsteps:\n  a: ${step}`)]).join();
    expect(stepErrors('{ type: bot, bot: b }')).toMatch(/drop "type"/);
    expect(stepErrors('{ bot: b, until: { checks: [x, y], max: 2 } }')).toMatch(
      /write "checks: \[x, y\]" and "tries: 3" in place of "until"/
    );
    expect(stepErrors('{ bot: b, needs: [z] }')).toMatch(/drop "needs"/);
    expect(stepErrors('{ bot: b, timeout-minutes: 9 }')).toMatch(/write "minutes: 9" in place of "timeout-minutes"/);
    expect(stepErrors('{ bot: b, environment: prod }')).toMatch(/wait: human/);
    expect(stepErrors('{ bot: b, tools: [read] }')).toMatch(/set "tools" on the bot/);
    expect(stepErrors('{ bot: b, mode: warn }')).toMatch(/drop "mode"/);
    expect(errorsOf([workflow('on: { push: {} }\njobs:\n  a: { type: bot, bot: b }')]).join()).toMatch(
      /jobs are now steps: write "steps:"/
    );
    expect(errorsOf([workflow('name: w\non: { push: {} }\nsteps: { a: { run: x } }')]).join()).toMatch(/drop "name"/);
  });

  it('lets a step narrow hub globs only to globs the bot returns', () => {
    const errors = errorsOf([
      bot('p', '[reply, hub(notes/**)]'),
      skill('s'),
      workflow(
        [
          'on: { push: {} }',
          'steps:',
          '  same: { bot: p, skill: s, returns: [hub(notes/**)] }',
          '  inner: { bot: p, skill: s, returns: [hub(notes/caveat/*.md)] }',
          '  wider: { bot: p, skill: s, returns: [hub(skills/**)] }',
          '  kind: { bot: p, skill: s, returns: [note] }',
        ].join('\n')
      ),
    ]);
    expect(errors).toEqual([
      'step "wider" returns "hub(skills/**)", which bot "p" does not return',
      'step "kind" returns "note", which bot "p" does not return',
    ]);
  });

  it('checks references between steps, bots, skills and checks', () => {
    const errors = errorsOf([
      bot('p'),
      skill('s'),
      workflow(
        [
          'on: { pull_request: }',
          'steps:',
          '  w: { wait: human }',
          '  a: { next: missing, bot: p, skill: s, returns: [merge-request], checks: [ghost] }',
          '  b: { bot: ghost, skill: s }',
          '  e: { bot: p, skill: nope }',
          '  f: { bot: p, skill: s, branch: "main-{x}" }',
          '  g: { run: echo, over: { run: ls } }',
          '  h: { run: echo, returns: [merge] }',
          '  i: { run: echo, branch: bothub/5/x, into: bothub/5 }',
          '  j: { run: echo, into: "bothub/{nope}", requires: [ghost] }',
          '  k: { wait: human, back: ghost }',
        ].join('\n')
      ),
    ]);
    expect(errors).toEqual([
      'step "w" waits first, so there is no step to go back to',
      'step "a" goes next to unknown step "missing"',
      'step "a" checks unknown check "ghost"',
      'step "a" returns "merge-request", which bot "p" does not return',
      'step "b" uses unknown bot "ghost"',
      'step "e" uses unknown skill "nope"',
      'step "f" branch "main-{x}" must start with "bothub/"',
      'step "f" branch uses unknown placeholder "{x}"',
      'step "g" runs its own command, so "over: { run }" needs a bot step',
      'step "h" returns "merge" without "into", so it would merge into the default branch, which only a human does',
      'step "i" branch "bothub/5/x" sits inside "bothub/5", and git cannot hold both; try "bothub/5-…"',
      'step "j" into uses unknown placeholder "{nope}"',
      'step "j" requires unknown check "ghost"',
      'step "k" goes back to unknown step "ghost"',
      'step "b" is never reached: no step\'s "next" leads to it',
      'step "e" is never reached: no step\'s "next" leads to it',
      'step "f" is never reached: no step\'s "next" leads to it',
      'step "g" is never reached: no step\'s "next" leads to it',
      'step "h" is never reached: no step\'s "next" leads to it',
      'step "i" is never reached: no step\'s "next" leads to it',
      'step "j" is never reached: no step\'s "next" leads to it',
      'step "k" is never reached: no step\'s "next" leads to it',
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
    expect(errorsOf([workflow('on: { push: {} }\nsteps:\n  a: { skill: s }')]).join()).toMatch(
      /a step takes exactly one of "bot", "run" or "wait"/
    );
    expect(errorsOf([workflow('on: { push: {} }\nsteps:\n  a: { bot: p, run: x }')]).join()).toMatch(
      /a step takes exactly one of "bot", "run" or "wait"/
    );
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
    expect(errorsOf([workflow('on: { push: {} }\nsteps:\n  b: { run: x, skill: s, checks: [c] }')])).toEqual([
      expect.stringContaining('a "run" step does not take "skill", "checks"'),
    ]);
    expect(errorsOf([workflow('on: { push: {} }\nsteps:\n  b: { wait: human, minutes: 3 }')])).toEqual([
      expect.stringContaining('a "wait" step does not take "minutes"'),
    ]);
    expect(errorsOf([file('checks/c.md', 'type: script\nrun: x\nover: { each: ls }\nitems: 0')])).toHaveLength(1);
    expect(errorsOf([file('checks/c.md', 'type: script\nrun: x\nover: chunk')])).toHaveLength(1);
  });

  it('checks checks, bot skills and notes', () => {
    const result = compile([
      { ...bot('p'), source: bot('p').source.replace('returns:', 'skills: [gone]\nreturns:') },
      file('checks/gone.md', 'type: bot\nbot: p\nskill: gone'),
      file('notes/decision/a.md', 'title: A\ncheck: nope'),
      file('notes/rumor/b.md', 'title: B'),
    ]);
    expect(result.ok ? [] : result.errors.map(e => `${e.path}: ${e.message}`)).toEqual([
      'notes/rumor/b.md: unknown note kind "rumor", expected one of "decision", "style", "caveat"',
    ]);
    const errors = errorsOf([
      { ...bot('p'), source: bot('p').source.replace('returns:', 'skills: [gone]\nreturns:') },
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

  it('reads hub.yaml and its limits', () => {
    const tooled = file('bots/t.md', 'harness: opencode\ntools: [read, issues_get]\nreturns: [reply]');
    const result = compile([{ path: 'hub.yaml', source: 'issues: local\n' }, tooled]);
    expect(result.ok && result.config.hub).toEqual({
      issues: 'local',
      merge: { 'default-branch': 'human' },
      'merge-request': { sections: ['closes', 'checks', 'gaps'] },
      'time-kinds': {},
      limits: { minutes: 30, bots: {} },
    });
    const sectioned = compile([{ path: 'hub.yaml', source: 'merge-request: { sections: [closes] }\n' }]);
    expect(sectioned.ok && sectioned.config.hub['merge-request']).toEqual({ sections: ['closes'] });
    expect(errorsOf([{ path: 'hub.yaml', source: 'merge-request: { sections: [intro] }\n' }])[0]).toMatch(/sections/);
    const empty = compile([]);
    expect(empty.ok && empty.config.hub).toEqual({
      issues: 'github',
      merge: { 'default-branch': 'human' },
      'merge-request': { sections: ['closes', 'checks', 'gaps'] },
      'time-kinds': {},
      limits: { minutes: 30, bots: {} },
    });
    expect(errorsOf([{ path: 'hub.yaml', source: 'issues: jira\n' }])[0]).toMatch(/issues/);
    const limited = compile([
      { path: 'hub.yaml', source: 'limits: { minutes: 20, usd-per-run: 2, bots: { t: { sessions: 2 } } }\n' },
    ]);
    if (!limited.ok) throw new Error(JSON.stringify(limited.errors));
    expect(limitsOf(limited.config.hub, 't')).toEqual({ minutes: 20, 'usd-per-run': 2, sessions: 2 });
    expect(limitsOf(limited.config.hub, 'other')).toEqual({ minutes: 20, 'usd-per-run': 2 });
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

  it('warns that pi gets no hub tools or decider', () => {
    const result = compile([
      file(
        'bots/p.md',
        'harness: pi\ntools: [read, notes_search]\nreturns: [reply]\ndecider: [{ on: stop, ask: Done? }]'
      ),
    ]);
    expect(result.ok && result.warnings.map(w => w.message)).toEqual([
      'lists hub tools (notes_search) that pi runs do not get',
      'asks decider questions, which pi runs do not get',
    ]);
    const quiet = compile([file('bots/p.md', 'harness: pi\ntools: [read]\nreturns: [reply]')]);
    expect(quiet.ok && quiet.warnings).toEqual([]);
  });

  it('takes patterns on claude bots and warns that they get no hub tools', () => {
    const result = compile([
      file('bots/c.md', 'harness: claude\ntools: [read, bash(git diff*), issues_get]\nreturns: [reply]'),
    ]);
    expect(result.ok && result.warnings.map(w => w.message)).toEqual([
      'lists hub tools (issues_get) that claude runs do not get',
    ]);
  });

  it('warns about checks that never run and steps that never repeat', async () => {
    const result = compile([
      bot('b'),
      skill('s'),
      file('checks/quiet.md', 'type: script\nrun: x'),
      file('checks/judge.md', 'type: decide\nmode: block', 'Is it fine?'),
      file('checks/tuned.md', 'type: decide\nthreshold: 0.7\nmode: block', 'Is it fine?'),
      workflow(
        [
          'on: { issues: {} }',
          'steps:',
          '  a: { bot: b, skill: s, over: each-file, checks: [quiet] }',
          '  c: { bot: b, skill: s, checks: [quiet, judge] }',
        ].join('\n')
      ),
    ]);
    expect(result.ok && result.warnings.map(w => `${w.path}: ${w.message}`)).toEqual([
      'checks/judge.md: decides in block mode without a "threshold"; tune one in log mode first',
      'checks/tuned.md: no step lists it in "checks" or "requires", so it never runs',
      'workflows/w.md: step "a" has only checks in log mode, so a failing check never sends it back',
    ]);
    const examples = ['hub', 'bothub', 'acme-app', 'clarinet'];
    const compiled = await Promise.all(examples.map(async name => compile(await readHub(join(hub, '..', name)))));
    expect(compiled.flatMap(example => (example.ok ? example.warnings : example.errors))).toEqual([]);
  });

  it('rejects a loop through next and steps nothing reaches', () => {
    const errors = errorsOf([workflow('on: {}\nsteps:\n  a: { run: x, next: b }\n  b: { run: x, next: a }')]);
    expect(errors).toContain('steps loop back to "a" through "next"; a step repeats only by "tries"');
    expect(errorsOf([workflow('on: {}\nsteps:\n  a: { run: x, next: end }\n  b: { run: x }')])).toEqual([
      'step "b" is never reached: no step\'s "next" leads to it',
    ]);
  });
});

describe('effectiveReturns', () => {
  it('narrows the bot to the step', () => {
    expect(effectiveReturns({ returns: ['reply', 'push', 'ask'] }, { returns: ['push', 'label'] })).toEqual(['push']);
    expect(effectiveReturns({ returns: ['reply'] }, {})).toEqual(['reply']);
  });
});

describe('effective context', () => {
  const bot = { tools: ['read', 'issues_get', 'notes_search'], preload: ['issue' as const] };

  it('splits hub tools from harness tools', () => {
    expect(harnessTools(bot)).toEqual(['read']);
    expect(hubTools(bot)).toEqual(['issues_get', 'notes_search']);
  });

  it('loads instructions and skills from the repo, and takes context and history, bot over hub', () => {
    const hub = { loads: ['skills' as const], history: 'hub' as const };
    expect(effectiveRun({}, {})).toEqual({ loads: ['instructions', 'skills'] });
    expect(effectiveRun(hub, {})).toEqual({ loads: ['skills'], history: 'hub' });
    expect(effectiveRun(hub, { loads: [], context: 'summary' })).toEqual({
      loads: [],
      history: 'hub',
      context: 'summary',
    });
  });

  it('fails a load the bot harness cannot honor, naming both', () => {
    const bot = (harness: string, lines: string, hubSource = 'issues: local') =>
      compile([
        { path: 'hub.yaml', source: hubSource },
        file('bots/p.md', `harness: ${harness}\ntools: [read]\nreturns: [reply]\n${lines}`),
      ]);
    expect(bot('opencode', 'loads: [instructions, skills/lint]\ncontext: resume').ok).toBe(true);
    const tools = bot('opencode', 'loads: [tools/fmt]');
    expect(!tools.ok && tools.errors[0]?.message).toBe('loads "tools/fmt", which opencode cannot honor');
    const pi = bot('pi', 'loads: [skills]');
    expect(!pi.ok && pi.errors[0]?.message).toBe('loads "skills", which pi cannot honor');
    expect(bot('pi', '', 'loads: [mcp]').ok).toBe(false);
  });
});

describe('stepOrder', () => {
  it('walks the steps in written order, or along next', () => {
    const steps = { triage: { bot: 'a' }, implement: { bot: 'b', next: 'ship' }, review: { wait: 'human' }, ship: {} };
    expect(stepOrder({ steps } as never)).toEqual({ order: ['triage', 'implement', 'ship'] });
    expect(nextOf({ steps } as never, 'ship')).toBeUndefined();
    expect(triesOf({})).toBe(3);
    expect(triesOf({ tries: 1 })).toBe(1);
  });
});
