import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import type { GitHub } from '../src/github-app.ts';
import { localIssues } from '../src/issues-local.ts';
import type { ApplyResult } from '../src/apply.ts';
import type { Proposal } from '../src/outputs.ts';
import {
  approvals,
  buildSpec,
  closureOf as closure,
  failingChecks,
  handoffEnv,
  renderBranch,
  runPlan,
  runPlanned,
  secretsFor,
  verdictOf,
  type JobResult,
  type Pipeline,
} from '../src/pipeline.ts';
import { limiter, unsandboxed, type Launcher } from '../src/runner.ts';
import { SandboxError } from '../src/sandbox.ts';
import { openStore, type Outcome, type Run, type Verdict } from '../src/store.ts';
import type { AgentEvent, BotEvent, HarnessAdapter, RunSpec } from '../src/types.ts';
import { workspaces } from '../src/workspace.ts';
import { git, sourceRepo, temp } from './git.ts';

const md = (path: string, frontmatter: string, body = '') => ({ path, source: `---\n${frontmatter}\n---\n\n${body}` });

const configFor = (mode = 'shadow'): Config => {
  const result = compile([
    md(
      'bots/bot.md',
      'harness: opencode\nmodel: sonnet\ntools: [read, grep]\ncan: [reply, label, push, open-pr, ask]\nskills: [triage, notify]\nnotes: [convention]\nmax-turns: 7\nbudget: { minutes: 30 }',
      'You are a careful bot.'
    ),
    md('bots/judge.md', 'harness: opencode\ntools: [read]\ncan: [reply]\nmax-turns: 3', 'You judge.'),
    md('skills/triage.md', 'description: Sort an issue.\nnotes: [caveat]', 'Triage the issue.'),
    md('skills/summarize.md', 'description: Summarize a thread.', 'Summarize the thread.'),
    md('skills/notify.md', 'description: Tell someone.', 'Notify someone.'),
    md('skills/implement.md', 'description: Change code.', 'Implement it.'),
    md('skills/judge.md', 'description: Judge a file.', 'Judge this file.'),
    md('checks/exists.md', 'run: test -f src/a.ts\nmode: block'),
    md('checks/shadowed.md', 'run: echo never mind; exit 1'),
    md('checks/judged.md', 'bot: judge\nskill: judge\nfor-each: file\nmode: block', 'Be strict.'),
    md('notes/convention/small.md', 'title: Small changes\nstatus: accepted', 'Keep changes small.'),
    md('notes/convention/old.md', 'title: Old rule\nstatus: retired', 'Forget this.'),
    md('notes/caveat/limits.md', 'title: Limits', 'Keep job budgets short.'),
    md('notes/decision/bigint.md', 'title: Bigint', 'Use bigint.'),
    md(
      'workflows/triage.md',
      `on: { issue_comment: {} }
jobs:
  triage: { mode: ${mode}, bot: bot, skill: triage, timeout-minutes: 5, can: [reply] }
  summarize: { needs: triage, bot: bot, skill: summarize, can: [] }
  notify: { needs: [plain], bot: bot, skill: notify }
  plain: { run: echo plain output; exit 3 }
  implement:
    mode: warn
    bot: bot
    skill: implement
    branch: bothub/{issue}-{slug}
    paths: ['src/**']
    can: [push, open-pr]
  loop:
    mode: warn
    bot: bot
    skill: implement
    can: [reply, ask]
    until: { checks: [exists, shadowed], max: 1 }
  judged:
    mode: warn
    bot: bot
    skill: implement
    can: [reply]
    until: { checks: [judged], max: 1 }`
    ),
  ]);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
};

const event: BotEvent = {
  id: 'd1',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'github',
  trigger: 'issue_comment',
  action: 'created',
  repo: 'acme/app',
  number: 7,
  actor: { login: 'octocat', association: 'OWNER' },
  body: 'please look at ```this```',
  url: 'https://github.com/acme/app/issues/7#issuecomment-1',
};

const bothub = (proposals: unknown[]) => ['Done.', '```bothub', JSON.stringify(proposals), '```'].join('\n');

const finalMessage = bothub([
  { kind: 'reply', body: 'Looks like a bug.' },
  { kind: 'reply', body: 'Second reply.' },
  { kind: 'label', add: ['bug'] },
]);

const lines = (ok: boolean, message: string) =>
  (
    [
      { type: 'start', session: 's1', model: 'resolved/sonnet' },
      { type: 'text', text: 'working' },
      { type: 'end', ok, turns: 2, result: message, costUsd: 0.5 },
    ] satisfies AgentEvent[]
  )
    .map(line => JSON.stringify(line))
    .join('\n');

type Behaviour = { ok?: boolean; message?: string; work?: string };

/** An adapter that runs `node -e` in the worktree, checks its secrets, prints agent events and records each spec. */
const fake = (behave: Behaviour | ((spec: RunSpec, call: number) => Behaviour) = {}) => {
  const seen: RunSpec[] = [];
  const adapter: HarnessAdapter = {
    name: 'opencode',
    command: spec => {
      seen.push(spec);
      const {
        ok = true,
        message = finalMessage,
        work = '',
      } = typeof behave === 'function' ? behave(spec, seen.length) : behave;
      const script = `const fs = require('fs'); fs.accessSync('README.md'); ${work}; if (process.env.BOTHUB_LLM_API_KEY !== 'key' || process.env.OTHER) process.exit(9); console.log(${JSON.stringify(lines(ok, message))}); process.exit(${ok ? 0 : 1})`;
      return { cmd: 'node', args: ['-e', script], env: {} };
    },
    parseLine: line => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
  };
  return { seen, adapters: { opencode: adapter, pi: { ...adapter, name: 'pi' as const } } };
};

/** GitHub with nothing written yet; `calls` holds the writes. */
const fakeGitHub = () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const gh = (async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') {
      if (path.includes('?')) return [];
      if (path === '/repos/acme/app') return { default_branch: 'main' };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
    calls.push({ method, path, body });
    if (path.endsWith('/pulls')) return { html_url: `https://github.com/acme/app/pull/${calls.length}` };
    return { html_url: `https://github.com/acme/app/issues/7#c${calls.length}` };
  }) as GitHub;
  return { calls, gh };
};

const unmarked = (body: string) => body.replace(/\n\n<!-- bothub:\S+ -->$/, '');

/** A local tracker holding the event's issue #7. */
const trackedIssues = () => {
  const dir = temp('issues');
  writeFileSync(join(dir, '7-task.md'), '---\ntitle: Task\n---\n\nDo it.\n');
  return localIssues(dir, { repo: 'acme/app' });
};

const pipeline = async (
  overrides: Partial<Pipeline> & { config: Config },
  origin = sourceRepo()
): Promise<Pipeline> => {
  const dataDir = temp('pipeline');
  return {
    event,
    store: openStore(dataDir),
    workspaces: workspaces({ dataDir, cloneUrl: () => origin.dir }),
    limit: await Effect.runPromise(limiter(1)),
    env: { BOTHUB_LLM_API_KEY: 'key', OTHER: 'nope' },
    adapters: fake().adapters,
    launch: unsandboxed,
    ...overrides,
  };
};

const planned = (job: string) => ({ workflow: 'triage', job, ...(job !== 'plain' && { bot: 'bot' }) });
const triage = planned('triage');

describe('buildSpec', () => {
  const config = configFor();
  const workflow = config.workflows.triage!;

  it('pins role, notes, the forced skill, offered skills and the allowed proposals in order, and prompts with the event', () => {
    const { spec, timeoutMinutes, can } = buildSpec({ config, workflow, job: 'triage', event, args: 'go', cwd: '/w' });
    expect(timeoutMinutes).toBe(5);
    expect(can).toEqual(['reply']);
    expect(spec).toMatchObject({ cwd: '/w', model: 'sonnet', tools: ['read', 'grep'], maxTurns: 7 });
    expect(spec.system.split('\n\n## ')[0]).toBe('You are a careful bot.');
    expect(spec.system.match(/^## .+$/gm)).toEqual([
      '## Notes',
      '## Skill: triage',
      '## Skills',
      '## Proposing changes',
    ]);
    expect(spec.system).toContain(
      '### caveat\n\n#### Limits\n\nKeep job budgets short.\n\n## Skill: triage\n\nTriage the issue.\n\n## Skills'
    );
    expect(spec.system).toContain(
      '## Skills\n\nUse one of these when it fits the task:\n\n- triage: Sort an issue.\n- notify: Tell someone.\n\n## Proposing changes'
    );
    expect(spec.system).toContain(
      '## Notes\n\nWhat this hub knows. Read-only; follow them.\n\n### decision\n\n#### Bigint'
    );
    expect(spec.system).not.toContain('Old rule');
    expect(spec.system).toContain(
      '```bothub\n[\n  { "kind": "reply", "body": "Markdown comment on the issue or pull request" }\n]\n```'
    );
    expect(spec.system).not.toMatch(/"kind": "(label|open-pr)"/);
    expect(spec.system).toMatch(
      /\n\nWhen you stop without finishing, add .*no-op\. Include only the proposals you need\.$/
    );
    expect(spec.prompt).toBe(
      [
        '## Event',
        [
          'Repository: acme/app',
          'Number: #7',
          'Actor: @octocat (OWNER)',
          'URL: https://github.com/acme/app/issues/7#issuecomment-1',
          'Trigger: issue_comment (created)',
        ].join('\n'),
        'Command arguments:',
        '```text\ngo\n```',
      ].join('\n\n')
    );
  });

  it('quotes the event text with a longer fence, drops proposals for an empty can and falls back to the bot budget', () => {
    const { spec, timeoutMinutes } = buildSpec({ config, workflow, job: 'summarize', event, cwd: '/w' });
    expect(timeoutMinutes).toBe(30);
    expect(spec.prompt.endsWith('Text:\n\n````text\nplease look at ```this```\n````')).toBe(true);
    expect(spec.system).not.toContain('## Proposing changes');
  });

  it('renders the job branch into the event and the proposal examples', () => {
    const { spec, branch, can } = buildSpec({ config, workflow, job: 'implement', event, cwd: '/w' });
    expect(branch).toBe('bothub/7-please-look-at-this');
    expect(can).toEqual(['push', 'open-pr']);
    expect(spec.prompt).toContain('Branch: bothub/7-please-look-at-this');
    expect(spec.system).toContain('"head": "bothub/7-please-look-at-this"');
    expect(spec.system).toContain('Use the branch `bothub/7-please-look-at-this`.');
  });
});

describe('renderBranch', () => {
  it('fills placeholders from the event', () => {
    const at = { event, args: 'Add /health, quickly!', job: 'j', workflow: 'w' };
    expect(renderBranch('bothub/{issue}-{slug}', at)).toBe('bothub/7-add-health-quickly');
    expect(renderBranch('bothub/{workflow}/{job}', at)).toBe('bothub/w/j');
    const { number: _, body: __, ...bare } = event;
    expect(renderBranch('bothub/{issue}-{slug}', { ...at, event: bare, args: undefined })).toBe('bothub/new-j');
  });
});

describe('secretsFor', () => {
  it('gives every harness the proxy base URL and a per-bot key, falling back to the shared key', () => {
    const env = {
      BOTHUB_LLM_BASE_URL: 'http://proxy',
      BOTHUB_LLM_API_KEY: 'shared',
      BOTHUB_LLM_API_KEY_CODE_REVIEWER: 'mine',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
    };
    expect(secretsFor({ name: 'code-reviewer' }, env)).toEqual({
      BOTHUB_LLM_BASE_URL: 'http://proxy',
      BOTHUB_LLM_API_KEY: 'mine',
    });
    expect(secretsFor({ name: 'implementor' }, env)).toEqual({
      BOTHUB_LLM_BASE_URL: 'http://proxy',
      BOTHUB_LLM_API_KEY: 'shared',
    });
    expect(secretsFor({ name: 'implementor' }, {})).toEqual({});
  });
});

describe('context', () => {
  it('mounts granted hub tools and pins the preloaded issue context after the skill', () => {
    const result = compile([
      md(
        'bots/b.md',
        'harness: opencode\ntools: [read, issues_get, notes_search]\ncan: [reply]\npreload: [issue]\nmax-turns: 3',
        'Role.'
      ),
      md('skills/s.md', 'description: Do it.', 'Do it.'),
      md('workflows/w.md', 'on: { issue_comment: {} }\njobs:\n  a: { bot: b, skill: s, tools: [issues_get] }'),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const config = result.config;
    const workflow = config.workflows.w!;
    const mcp = (tools: string[]) => ({ command: 'node', args: tools, env: {} });
    const { spec } = buildSpec({ config, workflow, job: 'a', event, cwd: '/w', preloaded: '## Issue #7: Task', mcp });
    expect(spec.tools).toEqual(['read', 'bothub_issues_get']);
    expect(spec.mcp).toEqual({ command: 'node', args: ['issues_get'], env: {} });
    expect(spec.system).toContain(
      '## Hub tools\n\nRead-only tools from the `bothub` server. Writes still go through proposals.\n\n- issues_get:'
    );
    expect(spec.system).toContain('## Skill: s\n\nDo it.\n\n## Issue #7: Task\n\n## Hub tools');
    expect(spec.prompt).not.toContain('## Issue #7');

    const bare = buildSpec({ config, workflow, job: 'a', event, cwd: '/w' }).spec;
    expect(bare.tools).toEqual(['read']);
    expect(bare.mcp).toBeUndefined();
    expect(bare.system).not.toContain('## Hub tools');
  });

  it('preloads the issue from the tracker before the run', async () => {
    const issues = trackedIssues();
    const { seen, adapters } = fake();
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, preload: ['issue', 'notes'] };
    const p = await pipeline({ config, issues, adapters });
    await Effect.runPromise(runPlanned(triage, p));
    expect(seen[0]!.system).toContain('## Issue #7: Task\n\nState: open\n\nDo it.');
  });
});

describe('runPlanned', () => {
  it('records proposals in shadow mode without applying them and removes the worktree', async () => {
    const { calls, gh } = fakeGitHub();
    const { seen, adapters } = fake();
    const p = await pipeline({ config: configFor('shadow'), gh, adapters });
    const result = await Effect.runPromise(runPlanned(triage, p));
    if (!('run' in result)) throw new Error('skipped');
    expect(result.run).toMatchObject({
      status: 'succeeded',
      costUsd: 0.5,
      turns: 2,
      bot: 'bot',
      harness: 'opencode',
      model: 'resolved/sonnet',
      closure: 'done',
    });
    expect(result.outcome).toMatchObject({
      errors: [],
      accepted: [
        { kind: 'reply', body: 'Looks like a bug.' },
        { kind: 'reply', body: 'Second reply.' },
      ],
      rejected: [{ proposal: { kind: 'label' }, reason: '"label" is not allowed for this job' }],
      results: [],
      applied: false,
    });
    expect(calls).toEqual([]);
    const runDir = join(seen[0]!.cwd, '../../runs', result.run.id);
    expect(JSON.parse(readFileSync(join(runDir, 'outcome.json'), 'utf8'))).toEqual(result.outcome);
    expect(seen[0]!.cwd).toMatch(new RegExp(`work/${result.run.id}$`));
    expect(existsSync(seen[0]!.cwd)).toBe(false);
  });

  it('applies accepted proposals when the mode allows it and a client is given', async () => {
    const { calls, gh } = fakeGitHub();
    const p = await pipeline({ config: configFor('warn'), gh });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect('run' in result && result.outcome).toMatchObject({
      applied: true,
      results: [
        {
          kind: 'reply',
          key: 'd1/triage/triage/reply-1',
          status: 'applied',
          url: 'https://github.com/acme/app/issues/7#c1',
        },
        {
          kind: 'reply',
          key: 'd1/triage/triage/reply-2',
          status: 'applied',
          url: 'https://github.com/acme/app/issues/7#c2',
        },
      ],
    });
    expect(calls.map(c => c.body)).toEqual([
      { body: 'Looks like a bug.\n\n<!-- bothub:d1/triage/triage/reply-1 -->' },
      { body: 'Second reply.\n\n<!-- bothub:d1/triage/triage/reply-2 -->' },
    ]);
  });

  it('never applies without a client or after a failed run', async () => {
    const p = await pipeline({ config: configFor('warn') });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect('run' in result && result.outcome?.applied).toBe(false);

    const { calls, gh } = fakeGitHub();
    const failing = await pipeline({ config: configFor('warn'), gh, adapters: fake({ ok: false }).adapters });
    const failed = await Effect.runPromise(runPlanned(triage, failing));
    expect('run' in failed && failed.run.status).toBe('failed');
    expect('run' in failed && failed.outcome?.applied).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fails the run when the workspace cannot be created', async () => {
    const p = await pipeline({
      config: configFor(),
      workspaces: workspaces({ dataDir: temp('x'), cloneUrl: () => '/nope' }),
    });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect('run' in result && result.run).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('git clone'),
    });
    expect('run' in result && result.outcome).toBeUndefined();
  });

  it('pushes the job branch before opening the pull request and rejects other branches', async () => {
    const { calls, gh } = fakeGitHub();
    const origin = sourceRepo();
    const branch = 'bothub/7-please-look-at-this';
    const message = bothub([
      { kind: 'open-pr', title: 'Add a', body: 'Closes #7', head: branch, base: 'main' },
      { kind: 'push', branch, files: ['src/a.ts'] },
      { kind: 'push', branch: 'bothub/other' },
    ]);
    const work = "fs.mkdirSync('src'); fs.writeFileSync('src/a.ts', 'a')";
    const p = await pipeline({ config: configFor(), gh, adapters: fake({ message, work }).adapters }, origin);
    const result = await Effect.runPromise(runPlanned(planned('implement'), p));
    expect('run' in result && result.outcome?.results).toEqual([
      {
        kind: 'push',
        key: 'd1/triage/implement/push-1',
        status: 'applied',
        url: `${origin.dir}#${branch}`,
        sha: git(origin.dir, 'rev-parse', branch),
      },
      {
        kind: 'open-pr',
        key: 'd1/triage/implement/open-pr-1',
        status: 'applied',
        url: 'https://github.com/acme/app/pull/1',
      },
    ]);
    expect('run' in result && result.run).toMatchObject({ closure: 'handed-off' });
    expect('run' in result && result.outcome).toMatchObject({ branch, pr: 1 });
    expect('run' in result && result.outcome?.rejected[0]?.reason).toBe(
      `branch "bothub/other" is not the job's branch "${branch}"`
    );
    expect(git(origin.dir, 'show', `${branch}:src/a.ts`)).toBe('a');
    expect(git(origin.dir, 'log', '-1', '--format=%an %s', branch)).toBe('bothub[bot] bothub: implement');
    expect(calls.map(c => c.path)).toEqual(['/repos/acme/app/pulls']);
  });

  it('runs script jobs in a worktree and records their output', async () => {
    const p = await pipeline({ config: configFor() });
    const result = await Effect.runPromise(runPlanned(planned('plain'), p));
    if (!('run' in result)) throw new Error('skipped');
    expect(result.run).toMatchObject({ status: 'failed', error: 'the script exited non-zero', job: 'plain' });
    expect(result.run.bot).toBeUndefined();
    expect((await p.store.events(result.run.id)).map(r => r.event)).toEqual([
      { type: 'text', text: 'plain output' },
      { type: 'end', ok: false },
    ]);
  });
});

describe('until', () => {
  const replyAndAsk = bothub([
    { kind: 'reply', body: 'Done.' },
    { kind: 'ask', question: 'Is the name right?' },
  ]);

  it('sends failing findings back to the same bot in the same worktree until the checks pass', async () => {
    const issues = trackedIssues();
    const { seen, adapters } = fake((_spec, call) => ({
      message: replyAndAsk,
      work: call === 2 ? "fs.mkdirSync('src'); fs.writeFileSync('src/a.ts', 'a')" : '',
    }));
    const p = await pipeline({ config: configFor(), issues, adapters });
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));
    if (!('run' in result)) throw new Error('skipped');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.cwd).toBe(seen[0]!.cwd);
    expect(seen[1]!.prompt.startsWith(seen[0]!.prompt)).toBe(true);
    expect(seen[1]!.prompt).toContain('## Check findings\n\nAttempt 2 of 2.');
    expect(seen[1]!.prompt).toContain('### exists\n\n```text\nexited non-zero\n```');
    expect(seen[1]!.prompt).not.toContain('### shadowed');

    const runs = (await p.store.list()).reverse();
    expect(runs.map(r => [r.attempt, r.parent, r.status])).toEqual([
      [1, undefined, 'succeeded'],
      [2, runs[0]!.id, 'succeeded'],
    ]);
    expect(result.run.id).toBe(runs[1]!.id);
    expect((await p.store.outcome(runs[0]!.id))?.applied).toBe(false);
    expect(result.outcome?.checks).toEqual([
      { check: 'exists', gating: true, pass: true },
      { check: 'shadowed', gating: false, pass: false, findings: 'never mind' },
    ]);
    expect(result.outcome?.applied).toBe(true);
    expect((await issues.get(7))?.comments.map(c => unmarked(c.body))).toEqual(['Done.', '@octocat needs a human: #8']);
    expect(await issues.list({ label: 'unsure' })).toMatchObject([
      { number: 8, title: 'Is the name right?', parent: 7 },
    ]);
  });

  it('turns checks that still fail after max follow-ups into an ask and applies nothing else', async () => {
    const issues = trackedIssues();
    const { seen, adapters } = fake({ message: replyAndAsk });
    const p = await pipeline({ config: configFor(), issues, adapters });
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));
    if (!('run' in result)) throw new Error('skipped');
    expect(seen).toHaveLength(2);
    const reason = 'checks still failing after 2 attempts';
    expect(result.run).toMatchObject({ status: 'failed', error: reason, attempt: 2 });
    const question = `${reason}: exists. The findings are in run ${result.run.id}.`;
    expect(result.outcome).toMatchObject({
      accepted: [
        { kind: 'ask', question: 'Is the name right?' },
        { kind: 'ask', question },
      ],
      rejected: [{ proposal: { kind: 'reply', body: 'Done.' }, reason }],
      applied: true,
    });
    expect(result.outcome?.proposals.at(-1)).toEqual({ kind: 'ask', question });
    expect((await issues.list({ label: 'unsure' })).map(i => [i.number, i.parent, i.title])).toEqual([
      [8, 7, 'Is the name right?'],
      [9, 7, question.length > 80 ? `${question.slice(0, 79)}…` : question],
    ]);
    expect((await issues.get(7))?.comments.map(c => unmarked(c.body))).toEqual([
      '@octocat needs a human: #8',
      '@octocat needs a human: #9',
    ]);
  });

  it('fans a bot check out over changed files and reads PASS or FAIL from its reply', async () => {
    const write =
      "fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/a.ts', 'a'); fs.writeFileSync('src/b.ts', 'b')";
    const verdicts: string[] = [];
    const { seen, adapters } = fake((spec, call) => {
      if (!spec.prompt.startsWith('Judge this file.'))
        return { message: bothub([{ kind: 'reply', body: 'ok' }]), work: write };
      const failing = call === 3 && spec.prompt.includes('- src/b.ts');
      verdicts.push(failing ? 'FAIL' : 'PASS');
      return { message: bothub([{ kind: 'reply', body: failing ? 'FAIL\nsrc/b.ts:1 is wrong' : 'PASS' }]) };
    });
    const p = await pipeline({ config: configFor(), adapters });
    const result = await Effect.runPromise(runPlanned(planned('judged'), p));
    if (!('run' in result)) throw new Error('skipped');
    expect(verdicts).toEqual(['PASS', 'FAIL', 'PASS', 'PASS']);
    const judge = seen[1]!;
    expect(judge.system.startsWith('You judge.')).toBe(true);
    expect(judge.prompt).toContain(
      'Judge this file.\n\nBe strict.\n\n## Changes\n\n- src/a.ts\n\n```text\ndiff --git a/src/a.ts'
    );
    expect(judge.prompt).not.toContain('src/b.ts');
    expect(judge.prompt).toContain('## Verdict');
    expect(seen[3]!.prompt).toContain('### judged\n\n```text\nsrc/b.ts:\nsrc/b.ts:1 is wrong\n```');
    expect(result.run).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(result.outcome?.checks).toEqual([
      { check: 'judged', gating: true, pass: true, runs: [expect.any(String), expect.any(String)] },
    ]);
    const checkRuns = (await p.store.list()).filter(r => r.check === 'judged');
    expect(checkRuns).toHaveLength(4);
    expect(checkRuns.every(r => r.bot === 'judge' && r.parent !== undefined)).toBe(true);
  });
});

const closureOf = (r: JobResult) => ('skipped' in r ? r.closure : r.run.closure);

describe('runPlan', () => {
  const jobs = [planned('notify'), planned('plain'), planned('summarize'), triage];

  it('runs jobs in needs order and skips dependents of jobs that did not succeed', async () => {
    const p = await pipeline({ config: configFor() });
    const results = await Effect.runPromise(runPlan(jobs, p));
    expect(results.map(r => [r.job, 'skipped' in r ? r.skipped : r.run.status, closureOf(r)])).toEqual([
      ['triage', 'succeeded', 'done'],
      ['summarize', 'succeeded', 'no-op'],
      ['plain', 'failed', 'blocked'],
      ['notify', 'needs "plain" (blocked) to be done', 'deferred'],
    ]);
    const stored = await p.store.list();
    expect(stored.filter(r => r.status === 'skipped').map(r => [r.job, r.reason])).toEqual([
      ['notify', 'needs "plain" (blocked) to be done'],
    ]);
    expect(stored).toHaveLength(4);
  });

  it('skips a dependent when the job it needs fails', async () => {
    const p = await pipeline({ config: configFor(), adapters: fake({ ok: false }).adapters });
    const results = await Effect.runPromise(runPlan([triage, planned('summarize')], p));
    expect(results.map(r => [r.job, 'skipped' in r ? r.skipped : r.run.status])).toEqual([
      ['triage', 'failed'],
      ['summarize', 'needs "triage" (blocked) to be done'],
    ]);
  });
});

describe('closure', () => {
  const run = (fields: Partial<Run> = {}): Run => ({
    id: 'r',
    workflow: 'w',
    job: 'j',
    event,
    status: 'succeeded',
    ...fields,
  });
  const outcome = (accepted: Proposal[], results: ApplyResult[] = []): Outcome => ({
    proposals: accepted,
    errors: [],
    accepted,
    rejected: [],
    results,
    applied: results.length > 0,
  });
  const push: Proposal = { kind: 'push', branch: 'bothub/x', files: ['a.ts'] };
  const pr: Proposal = { kind: 'open-pr', title: 't', body: '', head: 'bothub/x' };

  it('says what happened to the work, not how the process ended', () => {
    expect(closure(run({ status: 'skipped', reason: 'later' }), undefined, [])).toEqual({
      closure: 'deferred',
      reason: 'later',
    });
    expect(closure(run({ status: 'failed', error: 'HTTP 429: rate limit' }), undefined, []).closure).toBe('deferred');
    expect(closure(run({ status: 'failed', error: 'boom' }), undefined, [])).toEqual({
      closure: 'blocked',
      reason: 'boom',
    });
    expect(closure(run(), outcome([{ kind: 'close', as: 'no-op', reason: 'already done' }]), ['reply'])).toEqual({
      closure: 'no-op',
      reason: 'already done',
    });
    expect(closure(run(), outcome([{ kind: 'ask', question: 'q' }]), ['ask']).closure).toBe('blocked');
    expect(closure(run(), outcome([{ kind: 'reply', body: 'b' }]), ['reply']).closure).toBe('done');
    expect(closure(run(), outcome([{ kind: 'reply', body: 'b' }]), ['reply', 'push'])).toEqual({
      closure: 'no-op',
      reason: 'proposed no change',
    });
    expect(closure(run(), outcome([push, pr]), ['push', 'open-pr']).closure).toBe('handed-off');
  });

  it('hands off a pushed branch without a pull request only to a job that takes it', () => {
    expect(closure(run(), outcome([push]), ['push'], true).closure).toBe('handed-off');
    expect(closure(run(), outcome([push]), ['push'])).toEqual({
      closure: 'blocked',
      reason: 'pushed a branch without opening a pull request',
    });
    const failed = outcome([push], [{ kind: 'push', status: 'failed', reason: 'rejected' }]);
    expect(closure(run(), failed, ['push'], true)).toEqual({ closure: 'blocked', reason: 'push failed: rejected' });
  });
});

describe('checks fail closed', () => {
  const ok = (fields: Partial<Run>): Run => ({
    id: 'r',
    workflow: 'w',
    job: 'j',
    event,
    status: 'succeeded',
    ...fields,
  });

  it('fails a check that cannot decide', () => {
    expect(verdictOf(ok({ status: 'failed', error: 'model error' }), '').findings).toBe('run r failed: model error');
    expect(verdictOf(ok({}), 'All good.')).toEqual({ pass: false, findings: 'run r gave no verdict' });
    expect(verdictOf(ok({}), bothub([{ kind: 'reply', body: 'Looks fine\nPASS' }])).findings).toMatch(
      /neither PASS nor FAIL/
    );
    expect(verdictOf(ok({}), bothub([{ kind: 'reply', body: 'pass' }]))).toEqual({ pass: true });
  });

  it('lets a skipped check pass a gate only when it allows skipping', () => {
    const config = configFor();
    const checks = {
      ...config.checks,
      exists: { ...config.checks.exists!, 'allow-skip': true },
    };
    const skipped = (check: string): Verdict => ({ check, gating: true, pass: false, skipped: true });
    expect(failingChecks([skipped('exists')], checks)).toEqual([]);
    expect(failingChecks([skipped('judged')], checks)).toEqual([skipped('judged')]);
    expect(failingChecks([{ ...skipped('shadowed'), gating: false }], checks)).toEqual([]);
  });
});

describe('proposals', () => {
  it('sends a reply without usable proposals back as a failed attempt, then blocks', async () => {
    const { seen, adapters } = fake({ message: 'I looked around and everything seems fine.' });
    const p = await pipeline({ config: configFor('warn'), adapters });
    const result = await Effect.runPromise(runPlanned(triage, p));
    if (!('run' in result)) throw new Error('skipped');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain('## Proposal errors\n\nAttempt 2 of 2.');
    expect(seen[1]!.prompt).toContain('- the reply has no bothub block');
    expect(result.run).toMatchObject({
      status: 'failed',
      closure: 'blocked',
      error: expect.stringMatching(/^no usable proposals after 2 attempts: the reply has no bothub block/),
    });
    const runs = (await p.store.list()).reverse();
    expect(runs.map(r => [r.attempt, r.status])).toEqual([
      [undefined, 'failed'],
      [2, 'failed'],
    ]);
  });

  it('retries with the parse errors and goes on once the block parses', async () => {
    const { seen, adapters } = fake((_spec, call) => ({
      message: call === 1 ? 'Done.\n```bothub\n[{ "kind": "reply" }]\n```' : finalMessage,
    }));
    const p = await pipeline({ config: configFor('warn'), adapters });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect(seen[1]!.prompt).toMatch(/## Proposal errors[\s\S]*- proposal 1:/);
    expect('run' in result && result.run).toMatchObject({ status: 'succeeded', closure: 'done', attempt: 2 });
  });
});

describe('budgets', () => {
  it('defers a bot that used its runs for the day', async () => {
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, budget: { 'runs-per-day': 1 } };
    const { seen, adapters } = fake();
    const p = await pipeline({ config, adapters });
    await Effect.runPromise(runPlanned(triage, p));
    const second = await Effect.runPromise(runPlanned(triage, p));
    expect(seen).toHaveLength(1);
    expect('run' in second && second.run).toMatchObject({
      status: 'skipped',
      closure: 'deferred',
      reason: 'bot "bot" used its 1 runs for the last 24 hours',
    });
  });

  it('defers a run whose sandbox never started and does not count it against the day', async () => {
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, budget: { 'runs-per-day': 1 } };
    const { seen, adapters } = fake();
    const down: Launcher = {
      ...unsandboxed,
      agent: async () => {
        throw new SandboxError('the bothub-sandbox network is missing');
      },
    };
    const p = await pipeline({ config, adapters, launch: down });
    const failed = await Effect.runPromise(runPlanned(triage, p));
    expect('run' in failed && failed.run).toMatchObject({
      status: 'failed',
      closure: 'deferred',
      error: 'sandbox-failed: the bothub-sandbox network is missing',
    });
    expect(seen).toHaveLength(0);
    const retried = await Effect.runPromise(runPlanned(triage, { ...p, launch: unsandboxed }));
    expect(seen).toHaveLength(1);
    expect('run' in retried && retried.run).toMatchObject({ status: 'succeeded', closure: 'done' });
  });

  it('stops looping once the attempts spent the run budget', async () => {
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, budget: { 'usd-per-run': 0.5 } };
    const { seen, adapters } = fake({ message: bothub([{ kind: 'reply', body: 'Done.' }]) });
    const p = await pipeline({ config, issues: trackedIssues(), adapters });
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));
    expect(seen).toHaveLength(1);
    expect('run' in result && result.run).toMatchObject({
      status: 'failed',
      closure: 'blocked',
      error: 'spent $0.50 of the $0.5 budget in 1 attempts with checks still failing',
    });
  });
});

describe('handoff', () => {
  const flow = () => {
    const result = compile([
      md(
        'bots/bot.md',
        'harness: opencode\ntools: [read]\ncan: [reply, push, open-pr]\nmax-turns: 5',
        'You are a careful bot.'
      ),
      md('skills/implement.md', 'description: Change code.', 'Implement it.'),
      md('skills/deploy.md', 'description: Ship it.', 'Deploy it.'),
      md(
        'workflows/flow.md',
        `on: { issue_comment: {} }
jobs:
  implement: { mode: warn, bot: bot, skill: implement, branch: 'bothub/{issue}-{slug}', paths: ['src/**'], can: [push, open-pr] }
  verify:
    needs: implement
    run: test "$BOTHUB_BRANCH" = bothub/7-please-look-at-this && test "$BOTHUB_PR" = 1 && test -f src/a.ts
  deploy: { needs: verify, mode: warn, bot: bot, skill: deploy, environment: production, can: [reply] }`
      ),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.config;
  };
  const branch = 'bothub/7-please-look-at-this';
  const jobs = ['implement', 'verify', 'deploy'].map(job => ({
    workflow: 'flow',
    job,
    ...(job !== 'verify' && { bot: 'bot' }),
  }));
  const behave = (spec: RunSpec) =>
    spec.system.includes('## Skill: implement\n\nImplement it.')
      ? {
          message: bothub([
            { kind: 'push', branch, files: ['src/a.ts'] },
            { kind: 'open-pr', title: 'Add a', body: 'Closes #7', head: branch },
          ]),
          work: "fs.mkdirSync('src'); fs.writeFileSync('src/a.ts', 'a')",
        }
      : { message: bothub([{ kind: 'reply', body: 'Shipped.' }]) };

  it('passes the branch and pull request down, waits for approval, then resumes without redoing work', async () => {
    const { seen, adapters } = fake(behave);
    const issues = trackedIssues();
    const { gh } = fakeGitHub();
    const p = await pipeline({ config: flow(), adapters, issues, gh });

    const first = await Effect.runPromise(runPlan(jobs, p));
    expect(first.map(r => [r.job, closureOf(r)])).toEqual([
      ['implement', 'handed-off'],
      ['verify', 'done'],
      ['deploy', 'blocked'],
    ]);
    expect(first[2]).toMatchObject({ skipped: 'waiting for approval in #8' });
    expect(await issues.get(8)).toMatchObject({ title: 'Approve flow/deploy for #7 in production', parent: 7 });
    expect(seen).toHaveLength(1);

    const labeled: BotEvent = { ...event, id: 'd2', trigger: 'issues', action: 'labeled', number: 8 };
    expect(await approvals(labeled, p.store, issues)).toEqual([]);
    await issues.label(8, { add: ['approved'] });
    expect(await approvals(labeled, p.store, issues)).toEqual([event]);
    expect(await approvals({ ...labeled, actor: { login: 'x', association: 'NONE' } }, p.store, issues)).toEqual([]);

    const second = await Effect.runPromise(runPlan(jobs, p));
    expect(second.map(r => [r.job, closureOf(r)])).toEqual([
      ['implement', 'handed-off'],
      ['verify', 'done'],
      ['deploy', 'done'],
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain(`Branch: ${branch}`);
    expect(seen[1]!.prompt).toContain('Pull request: #1');
    const waited = (await p.store.list()).find(r => r.approval === 8);
    expect(waited).toMatchObject({ closure: 'done', reason: 'approved in #8' });
  });

  it('exports the handoff to scripts', () => {
    expect(handoffEnv({ branch, pr: 4 })).toEqual({ BOTHUB_BRANCH: branch, BOTHUB_PR: '4' });
    expect(handoffEnv()).toEqual({});
  });

  it('defers a job whose branch another live run holds', async () => {
    const { seen, adapters } = fake(behave);
    const p = await pipeline({ config: flow(), adapters });
    const held = await p.store.lock(`acme/app:${branch}`, 'other');
    expect('release' in held).toBe(true);
    const result = await Effect.runPromise(runPlanned(jobs[0]!, p));
    expect(seen).toHaveLength(0);
    expect('run' in result && result.run).toMatchObject({
      status: 'skipped',
      closure: 'deferred',
      reason: `branch "${branch}" is in use by run other`,
    });
  });
});
