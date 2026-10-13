import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { readSummaries } from '../src/summaries.ts';
import { tally } from '../src/usage.ts';
import type { AgentEvent, BotEvent, RunSpec } from '../src/types.ts';
import { workspaces } from '../src/workspace.ts';
import { commit, fakeHarness, git, sourceRepo, temp } from './kit.ts';

const md = (path: string, frontmatter: string, body = '') => ({ path, source: `---\n${frontmatter}\n---\n\n${body}` });

const untimed = (verdicts: Verdict[] | undefined) =>
  verdicts?.map(({ startedAt, endedAt, durationMs, ...verdict }) => {
    if (startedAt) expect(Date.parse(endedAt!) - Date.parse(startedAt)).toBe(durationMs);
    return verdict;
  });

const configFor = (mode = 'log'): Config => {
  const result = compile([
    md(
      'bots/bot.md',
      'harness: opencode\nmodel: sonnet\ntools: [read, grep]\nreturns: [reply, label, push, merge-request, ask]\nskills: [triage, notify]\nmax-turns: 7\nbudget: { minutes: 30 }',
      'You are a careful bot.'
    ),
    md('bots/judge.md', 'harness: opencode\ntools: [read]\nreturns: [reply]\nmax-turns: 3', 'You judge.'),
    md('skills/triage.md', 'description: Sort an issue.', 'Triage the issue.'),
    md('skills/summarize.md', 'description: Summarize a thread.', 'Summarize the thread.'),
    md('skills/notify.md', 'description: Tell someone.', 'Notify someone.'),
    md('skills/implement.md', 'description: Change code.', 'Implement it.'),
    md('skills/judge.md', 'description: Judge a file.', 'Judge this file.'),
    md('checks/exists.md', 'type: script\nrun: test -f src/a.ts && seq 12\nmode: block'),
    md('checks/logged.md', 'type: script\nrun: printf "\\033[33mnever mind\\033[0m\\n"; exit 1'),
    md('checks/judged.md', 'type: bot\nbot: judge\nskill: judge\nover: each-file\nmode: block', 'Be strict.'),
    md('notes/style/small.md', 'title: Small changes\nstatus: accepted', 'Keep changes small.'),
    md('notes/style/old.md', 'title: Old rule\nstatus: retired', 'Forget this.'),
    md('notes/caveat/limits.md', 'title: Limits', 'Keep job budgets short.'),
    md('notes/decision/bigint.md', 'title: Bigint', 'Use bigint.'),
    md(
      'workflows/triage.md',
      `on: { issue_comment: {} }
jobs:
  triage: { type: bot, mode: ${mode}, bot: bot, skill: triage, timeout-minutes: 5, returns: [reply] }
  summarize: { type: bot, needs: triage, bot: bot, skill: summarize, returns: [] }
  notify: { type: bot, needs: [plain], bot: bot, skill: notify }
  plain: { type: script, run: echo plain output; exit 3 }
  implement:
    type: bot
    mode: warn
    bot: bot
    skill: implement
    branch: bothub/{issue}-{slug}
    paths: ['src/**']
    returns: [push, merge-request]
  loop:
    type: bot
    mode: warn
    bot: bot
    skill: implement
    returns: [reply, ask]
    until: { checks: [exists, logged], max: 1 }
  judged:
    type: bot
    mode: warn
    bot: bot
    skill: implement
    returns: [reply]
    until: { checks: [judged], max: 1 }
  parking:
    type: bot
    mode: warn
    bot: bot
    skill: implement
    branch: bothub/{issue}
    paths: ['src/**']
    returns: [push, ask]
    until: { checks: [exists], max: 1 }`
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

const events = (ok: boolean, message: string): AgentEvent[] => [
  { type: 'start', session: 's1', model: 'resolved/sonnet' },
  { type: 'text', text: 'working' },
  { type: 'end', ok, turns: 2, result: message, costUsd: 0.5 },
];

type Behaviour = { ok?: boolean; message?: string; work?: string };

/** A harness that checks its worktree and secrets, then reports `message`; `ok: false` fails the run. */
const fake = (behave: Behaviour | ((spec: RunSpec, call: number) => Behaviour) = {}) =>
  fakeHarness((spec, call) => {
    const { ok = true, message = finalMessage, work = '' } = typeof behave === 'function' ? behave(spec, call) : behave;
    const secrets = `if (process.env.BOTHUB_LLM_API_KEY !== 'key' || process.env.OTHER) process.exit(9)`;
    return { events: events(ok, message), work: `fs.accessSync('README.md'); ${work}; ${secrets}`, exit: ok ? 0 : 1 };
  });

/** GitHub with nothing written yet; `calls` holds the writes. */
const fakeGitHub = () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const gh = (async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') {
      if (path.includes('?')) return [];
      if (path === '/repos/acme/app') return { default_branch: 'main' };
      if (path.includes('/git/ref/heads/')) return { object: { sha: 'm' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
    calls.push({ method, path, body });
    if (path.endsWith('/pulls'))
      return {
        number: calls.length,
        html_url: `https://github.com/acme/app/pull/${calls.length}`,
        title: 't',
        state: 'open',
        head: { ref: 'bothub/7', sha: 'h', repo: { full_name: 'acme/app' } },
        base: { ref: 'main', sha: 'm' },
      };
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

  it('pins role, the forced skill, offered skills and what the run returns in order, and prompts with the event', () => {
    const { spec, timeoutMinutes, returns } = buildSpec({
      config,
      workflow,
      job: 'triage',
      event,
      args: 'go',
      cwd: '/w',
    });
    expect(timeoutMinutes).toBe(5);
    expect(returns).toEqual(['reply']);
    expect(spec).toMatchObject({ cwd: '/w', model: 'sonnet', tools: ['read', 'grep'], maxTurns: 7 });
    expect(spec.system.split('\n\n## ')[0]).toBe('You are a careful bot.');
    expect(spec.system.match(/^## .+$/gm)).toEqual(['## Skill: triage', '## Skills', '## What you return']);
    expect(spec.system).toContain(
      '## Skills\n\nUse one of these when it fits the task:\n\n- triage: Sort an issue.\n- notify: Tell someone.\n\n## What you return'
    );
    expect(spec.system).not.toMatch(/Keep job budgets short|Keep changes small|Use bigint/);
    expect(spec.surfacer).toBeUndefined();
    expect(spec.system).toContain(
      '```bothub\n[\n  { "kind": "reply", "body": "Markdown comment on the issue or pull request" }\n]\n```'
    );
    expect(spec.system).not.toMatch(/"kind": "(label|merge-request)"/);
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

  it('quotes the event text with a longer fence, drops the return block for empty returns and falls back to the bot budget', () => {
    const { spec, timeoutMinutes } = buildSpec({ config, workflow, job: 'summarize', event, cwd: '/w' });
    expect(timeoutMinutes).toBe(30);
    expect(spec.prompt.endsWith('Text:\n\n````text\nplease look at ```this```\n````')).toBe(true);
    expect(spec.system).not.toContain('## What you return');
  });

  it('leaves out empty command arguments', () => {
    const { spec } = buildSpec({ config, workflow, job: 'summarize', args: ' ', event, cwd: '/w' });
    expect(spec.prompt).not.toContain('Command arguments');
    expect(spec.prompt).not.toContain('Text:');
  });

  it('recalls on opencode with the brief of the job it needs, and serves the notes tools the block names', () => {
    const bot = { ...config.bots.bot!, harness: 'opencode' as const, preload: ['issue' as const, 'recall' as const] };
    const recalling = { ...config, bots: { ...config.bots, bot } };
    const marker = '<!-- bothub:e1/triage/triage/reply-1 -->';
    const preloaded = `## Issue #7: Task\n\nDo it.\n\n### @bot at 2026-01-01\n\nTouch src/fees.ts only.\n\n${marker}`;
    const access = {
      hub: '/hub',
      data: '/data',
      mcp: (tools: string[]) => ({ command: 'node', args: tools, env: {} }),
    };
    const build = (job: string, text?: string) =>
      buildSpec({ config: recalling, workflow, job, event, cwd: '/w', ...access, ...(text && { preloaded: text }) })
        .spec;
    expect(build('triage', preloaded).surfacer?.recall?.query).toBe('## Issue #7: Task\n\nDo it.');
    const summarize = build('summarize', preloaded);
    expect(summarize.surfacer?.recall?.query).toBe('Touch src/fees.ts only.');
    expect(summarize.tools).toEqual(expect.arrayContaining(['bothub_notes_get', 'bothub_notes_search']));
    expect(build('summarize').surfacer?.recall?.query).toBe(event.body);
  });

  it('renders the job branch into the event and the proposal examples', () => {
    const { spec, branch, returns } = buildSpec({ config, workflow, job: 'implement', event, cwd: '/w' });
    expect(branch).toBe('bothub/7-please-look-at-this');
    expect(returns).toEqual(['push', 'merge-request']);
    expect(spec.prompt).toContain('Branch: bothub/7-please-look-at-this');
    expect(spec.system).toContain('"branch": "bothub/7-please-look-at-this"');
    expect(spec.system).toContain('Use the branch `bothub/7-please-look-at-this`.');
  });
});

describe('renderBranch', () => {
  it('fills placeholders from the event', () => {
    const at = { event, args: 'Add /health, quickly!', job: 'j', workflow: 'w' };
    expect(renderBranch('bothub/{issue}-{slug}', at)).toBe('bothub/7-add-health-quickly');
    expect(renderBranch('bothub/{workflow}/{job}', at)).toBe('bothub/w/j');
    const pr = { ...at, event: { ...event, parent: 5, branch: 'bothub/5' } };
    expect(renderBranch('bothub/{parent}-{issue}', pr)).toBe('bothub/5-7');
    expect(renderBranch('{base}', pr)).toBe('bothub/5');
    expect(renderBranch('bothub/{parent}', at)).toBe('bothub/{parent}');
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
        'harness: opencode\ntools: [read, issues_get, notes_search]\nreturns: [reply]\npreload: [issue]\nmax-turns: 3',
        'Role.'
      ),
      md('skills/s.md', 'description: Do it.', 'Do it.'),
      md(
        'workflows/w.md',
        'on: { issue_comment: {} }\njobs:\n  a: { type: bot, bot: b, skill: s, tools: [issues_get] }'
      ),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const config = result.config;
    const workflow = config.workflows.w!;
    const mcp = (tools: string[]) => ({ command: 'node', args: tools, env: {} });
    const { spec } = buildSpec({ config, workflow, job: 'a', event, cwd: '/w', preloaded: '## Issue #7: Task', mcp });
    expect(spec.tools).toEqual(['read', 'bothub_issues_get']);
    expect(spec.mcp).toEqual({ command: 'node', args: ['issues_get'], env: {} });
    expect(spec.system).toContain(
      '## Hub tools\n\nTools over the hub and earlier runs. Changes still go through what you return.\n\n- issues_get:'
    );
    expect(spec.system).toContain('## Skill: s\n\nDo it.\n\n## Issue #7: Task\n\n## Hub tools');
    expect(spec.prompt).not.toContain('## Issue #7');

    const bare = buildSpec({ config, workflow, job: 'a', event, cwd: '/w' }).spec;
    expect(bare.tools).toEqual(['read']);
    expect(bare.mcp).toBeUndefined();
    expect(bare.system).not.toContain('## Hub tools');
  });

  it("asks the job's decider questions, else the bot's, against the issue context, and none in a pi run", () => {
    const ask = (q: string) => `\ndecider:\n  - { on: tool_call, tools: [edit], ask: "${q}" }`;
    const files = (harness: string) => [
      md('bots/b.md', `harness: ${harness}\ntools: [read, edit]\nreturns: [reply]${ask('Bot question?')}`, 'Role.'),
      md('skills/s.md', 'description: Do it.', 'Do it.'),
      md(
        'workflows/w.md',
        'on: { issue_comment: {} }\njobs:\n  a: { type: bot, bot: b, skill: s }\n  j: { type: bot, bot: b, skill: s, decider: [{ on: stop, ask: "Job question?" }] }'
      ),
    ];
    const specOf = (harness: string, job: string, preloaded?: string) => {
      const result = compile(files(harness));
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      const { config } = result;
      return buildSpec({ config, workflow: config.workflows.w!, job, event, cwd: '/w', preloaded }).spec;
    };
    expect(specOf('opencode', 'a', '## Issue #7: Brief').decider).toEqual({
      questions: [{ on: 'tool_call', tools: ['edit'], ask: 'Bot question?', mode: 'log' }],
      task: '## Issue #7: Brief',
    });
    expect(specOf('opencode', 'j').decider).toEqual({
      questions: [{ on: 'stop', ask: 'Job question?', mode: 'log' }],
      task: specOf('opencode', 'j').prompt,
    });
    expect(specOf('pi', 'a').decider).toBeUndefined();
    const acting = compile([
      md(
        'bots/b.md',
        'harness: opencode\ntools: [read]\nreturns: [reply]\ndecider: [{ on: stop, ask: "Ok?", mode: act }]',
        ''
      ),
    ]);
    expect(acting.ok ? [] : acting.errors.map(e => e.message)).toEqual([
      expect.stringContaining('mode act needs a "threshold" and a "say"'),
    ]);
  });

  it('preloads the issue from the tracker before the run', async () => {
    const issues = trackedIssues();
    const { seen, adapters } = fake();
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, preload: ['issue', 'recall'] };
    const p = await pipeline({ config, issues, adapters });
    await Effect.runPromise(runPlanned(triage, p));
    expect(seen[0]!.system).toContain('## Issue #7: Task\n\nState: open\n\nDo it.');
  });
});

describe('runPlanned', () => {
  it('records proposals in log mode without applying them and removes the worktree', async () => {
    const { calls, gh } = fakeGitHub();
    const { seen, adapters } = fake();
    const p = await pipeline({ config: configFor('log'), gh, adapters });
    const result = await Effect.runPromise(runPlanned(triage, p));

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
    expect(result.outcome).toMatchObject({
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
    expect(result.outcome?.applied).toBe(false);

    const { calls, gh } = fakeGitHub();
    const failing = await pipeline({ config: configFor('warn'), gh, adapters: fake({ ok: false }).adapters });
    const failed = await Effect.runPromise(runPlanned(triage, failing));
    expect(failed.run.status).toBe('failed');
    expect(failed.outcome?.applied).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fails the run when the workspace cannot be created', async () => {
    const p = await pipeline({
      config: configFor(),
      workspaces: workspaces({ dataDir: temp('x'), cloneUrl: () => '/nope' }),
    });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect(result.run).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('git clone'),
    });
    expect(result.outcome).toBeUndefined();
  });

  it('pushes the job branch before opening the pull request and rejects other branches', async () => {
    const { calls, gh } = fakeGitHub();
    const origin = sourceRepo();
    const branch = 'bothub/7-please-look-at-this';
    const message = bothub([
      { kind: 'merge-request', title: 'Add a', body: 'Closes #7', branch, into: 'main' },
      { kind: 'push', branch, files: ['src/a.ts'] },
      { kind: 'push', branch: 'bothub/other' },
    ]);
    const work = "fs.mkdirSync('src'); fs.writeFileSync('src/a.ts', 'a')";
    const p = await pipeline({ config: configFor(), gh, adapters: fake({ message, work }).adapters }, origin);
    const result = await Effect.runPromise(runPlanned(planned('implement'), p));
    expect(result.outcome?.results).toEqual([
      {
        kind: 'push',
        key: 'd1/triage/implement/push-1',
        status: 'applied',
        url: `${origin.dir}#${branch}`,
        sha: git(origin.dir, 'rev-parse', branch),
      },
      {
        kind: 'merge-request',
        key: 'd1/triage/implement/merge-request-1',
        status: 'applied',
        url: 'https://github.com/acme/app/pull/1',
      },
    ]);
    expect(result.run).toMatchObject({ closure: 'handed-off' });
    expect(result.outcome).toMatchObject({ branch, pr: 1 });
    expect(result.outcome?.rejected[0]?.reason).toBe(`branch "bothub/other" is not the job's branch "${branch}"`);
    expect(git(origin.dir, 'show', `${branch}:src/a.ts`)).toBe('a');
    expect(git(origin.dir, 'log', '-1', '--format=%an %s', branch)).toBe('bothub[bot] bothub: implement');
    expect(calls.map(c => c.path)).toEqual(['/repos/acme/app/pulls']);
  });

  it('runs script jobs in a worktree and records their output', async () => {
    const p = await pipeline({ config: configFor() });
    const result = await Effect.runPromise(runPlanned(planned('plain'), p));

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

    expect(seen).toHaveLength(2);
    expect(seen[1]!.cwd).toBe(seen[0]!.cwd);
    expect(seen[1]!.prompt.startsWith(seen[0]!.prompt)).toBe(true);
    expect(seen[1]!.prompt).toContain('## Check findings\n\nAttempt 2 of 2.');
    expect(seen[1]!.prompt).toContain('### exists\n\n```text\nexited non-zero\n```');
    expect(seen[1]!.prompt).not.toContain('### logged');

    const runs = (await p.store.list()).reverse();
    expect(runs.map(r => [r.attempt, r.parent, r.status])).toEqual([
      [1, undefined, 'succeeded'],
      [2, runs[0]!.id, 'succeeded'],
    ]);
    expect(result.run.id).toBe(runs[1]!.id);
    expect((await p.store.outcome(runs[0]!.id))?.applied).toBe(false);
    expect(untimed(result.outcome?.checks)).toEqual([
      { check: 'exists', gating: true, pass: true, findings: '3\n4\n5\n6\n7\n8\n9\n10\n11\n12' },
      { check: 'logged', gating: false, pass: false, findings: 'never mind' },
    ]);
    expect(result.outcome?.applied).toBe(true);
    expect((await issues.get(7))?.comments.map(c => unmarked(c.body))).toEqual(['Done.', '@octocat needs a human: #8']);
    expect(await issues.list({ label: 'unsure' })).toMatchObject([
      { number: 8, title: 'Is the name right?', parent: 7 },
    ]);
  });

  it('withdraws a run whose issue is closed while it runs, and applies nothing', async () => {
    const issues = trackedIssues();
    const sleep = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)';
    const { adapters } = fake({ work: sleep });
    const p = await pipeline({ config: configFor(), issues, adapters, pollMs: 50 });
    const running = Effect.runPromise(runPlanned(triage, p));
    await vi.waitFor(async () => expect((await p.store.list())[0]?.status).toBe('running'));
    await issues.close(7);
    const result = await running;
    expect(result.run).toMatchObject({
      status: 'cancelled',
      stopped: 'withdrawn',
      closure: 'no-op',
      error: 'withdrawn: #7 was closed',
    });
    expect((await issues.get(7))?.comments).toEqual([]);
  });

  it('turns checks that still fail after max follow-ups into an ask and applies nothing else', async () => {
    const issues = trackedIssues();
    const { seen, adapters } = fake({ message: replyAndAsk });
    const p = await pipeline({ config: configFor(), issues, adapters });
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));

    expect(seen).toHaveLength(2);
    const reason = 'checks still failing after 2 attempts';
    expect(result.run).toMatchObject({ status: 'failed', error: reason, attempt: 2 });
    const question = `${reason}: exists. The findings are in run ${result.run.id}.\n\n### exists\n\n\`\`\`text\nexited non-zero\n\`\`\``;
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

  it('stops when the bot closes without finishing, runs no checks and asks once', async () => {
    const issues = trackedIssues();
    const stop = bothub([
      { kind: 'reply', body: 'Partly done.' },
      { kind: 'ask', question: 'May the change touch studio?' },
      { kind: 'close', as: 'blocked', reason: 'the gates forbid studio' },
    ]);
    const { seen, adapters } = fake({ message: stop });
    const p = await pipeline({ config: configFor(), issues, adapters });
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));

    expect(seen).toHaveLength(1);
    expect(result.outcome?.checks).toBeUndefined();
    expect(result.run).toMatchObject({ status: 'succeeded', closure: 'blocked', reason: 'the gates forbid studio' });
    expect(result.outcome?.rejected).toEqual([
      { proposal: { kind: 'reply', body: 'Partly done.' }, reason: 'the bot stopped: the gates forbid studio' },
    ]);
    expect((await issues.list({ label: 'unsure' })).map(i => i.title)).toEqual(['May the change touch studio?']);
  });

  it('fans a bot check out over changed files, reads PASS or FAIL and judges again only what did not pass', async () => {
    const write =
      "fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/a.ts', 'a'); fs.writeFileSync('src/b.ts', 'b')";
    const verdicts: string[] = [];
    let failed = false;
    const { seen, adapters } = fake(spec => {
      if (!spec.prompt.startsWith('Judge this file.'))
        return { message: bothub([{ kind: 'reply', body: 'ok' }]), work: write };
      const failing = !failed && spec.prompt.includes('## Changes to src/b.ts');
      failed ||= failing;
      verdicts.push(`${failing ? 'FAIL' : 'PASS'} ${spec.prompt.includes('## Changes to src/b.ts') ? 'b' : 'a'}`);
      return { message: bothub([{ kind: 'reply', body: failing ? 'FAIL\nsrc/b.ts:1 is wrong' : 'PASS' }]) };
    });
    const p = await pipeline({ config: configFor(), adapters });
    const result = await Effect.runPromise(runPlanned(planned('judged'), p));

    expect(verdicts.slice(0, 2).sort()).toEqual(['FAIL b', 'PASS a']);
    expect(verdicts.slice(2)).toEqual(['PASS b']);
    const judge = seen.find(s => s.prompt.includes('## Changes to src/a.ts'))!;
    expect(judge.system.startsWith('You judge.')).toBe(true);
    expect(judge.prompt.startsWith('Judge this file.\n\nBe strict.\n\n## Event\n')).toBe(true);
    expect(judge.prompt.indexOf('## Verdict')).toBeLessThan(judge.prompt.indexOf('## Changes to src/a.ts'));
    expect(judge.prompt).toMatch(/## Changes to src\/a\.ts\n\n```text\ndiff --git a\/src\/a\.ts[^]*```$/);
    expect(judge.prompt).not.toContain('src/b.ts');
    expect(seen[3]!.prompt).toContain('### judged\n\n```text\nsrc/b.ts:\nsrc/b.ts:1 is wrong\n```');
    expect(result.run).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(untimed(result.outcome?.checks)).toEqual([
      {
        check: 'judged',
        gating: true,
        pass: true,
        runs: [expect.any(String)],
        findings: expect.stringMatching(/^src\/a\.ts:\nunchanged since run \S+, which passed it$/),
      },
    ]);
    const checkRuns = (await p.store.list()).filter(r => r.check === 'judged');
    expect(checkRuns).toHaveLength(3);
    expect(checkRuns.filter(r => r.passed)).toHaveLength(2);
    expect(checkRuns.every(r => r.bot === 'judge' && r.parent !== undefined)).toBe(true);
  });
});

describe('parking', { timeout: 20_000 }, () => {
  const asks = bothub([
    { kind: 'ask', question: 'Which name should it get?' },
    { kind: 'close', as: 'blocked', reason: 'the name is unclear' },
  ]);
  const writeA = "fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/a.ts', 'a')";
  const continueB =
    "if (fs.readFileSync('src/a.ts', 'utf8') !== 'a') process.exit(5); fs.writeFileSync('src/b.ts', 'b')";
  const pushB = bothub([{ kind: 'push', branch: 'bothub/7', files: ['src/b.ts'] }]);
  const answer: BotEvent = { ...event, id: 'd2', body: 'Call it short.' };

  const blockedRun = async (issues = trackedIssues()) => {
    const origin = sourceRepo();
    const { seen, adapters } = fake(spec =>
      spec.prompt.includes('## Resuming') ? { message: pushB, work: continueB } : { message: asks, work: writeA }
    );
    const p = await pipeline({ config: configFor(), issues, adapters }, origin);
    const result = await Effect.runPromise(runPlanned(planned('parking'), p));

    return { issues, origin, seen, p, result };
  };

  it('parks a blocked job beside its branch, leaving the branch alone', async () => {
    const { origin, result } = await blockedRun();
    expect(result.run).toMatchObject({ closure: 'blocked', reason: 'the name is unclear', parked: 'bothub/7-parked' });
    expect(git(origin.dir, 'show', 'bothub/7-parked:src/a.ts')).toBe('a');
    expect(git(origin.dir, 'rev-parse', 'bothub/7-parked^')).toBe(origin.main);
    expect(git(origin.dir, 'branch', '--list', 'bothub/7')).toBe('');
  });

  it('parks the work of a job deferred by its budget and says so on the issue', async () => {
    const origin = sourceRepo();
    const issues = trackedIssues();
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, budget: { 'runs-per-day': 1 } };
    const writeB = "fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/b.ts', 'b')";
    const { adapters } = fake({ message: pushB, work: writeB });
    const p = await pipeline({ config, issues, adapters }, origin);
    const result = await Effect.runPromise(runPlanned(planned('parking'), p));

    expect(result.run).toMatchObject({ status: 'skipped', closure: 'deferred', parked: 'bothub/7-parked' });
    expect(git(origin.dir, 'show', 'bothub/7-parked:src/b.ts')).toBe('b');
    const [said] = (await issues.get(7))!.comments;
    expect(said!.body).toMatch(
      /^triage\/parking was deferred: bot "bot" used its 1 runs .*, the next one frees up at \S+\. Its work so far is parked on `bothub\/7-parked`\./
    );
  });

  it('resumes from the parked branch with the question and the answer', async () => {
    const { issues, origin, seen, p, result } = await blockedRun();
    const [asked] = await issues.list({ label: 'unsure' });
    await issues.comment(asked!.number, 'Short, like the others.');
    const next = await Effect.runPromise(runPlanned(planned('parking'), { ...p, event: answer }));

    expect(seen).toHaveLength(2);
    const resume = seen[1]!.prompt.slice(seen[1]!.prompt.indexOf('## Resuming'));
    expect(resume).toContain(`Your earlier run ${result.run.id} stopped before finishing.`);
    expect(resume).toContain('parked on `bothub/7-parked`');
    expect(resume).toContain('```text\nWhich name should it get?\n```');
    expect(resume).toContain('```text\nCall it short.\n```');
    expect(resume).toContain(`In #${asked!.number}: Short, like the others.`);
    expect(next.run.base).toBe(origin.main);
    expect(git(origin.dir, 'show', 'bothub/7:src/b.ts')).toBe('b');
    expect(git(origin.dir, 'show', 'bothub/7:src/a.ts')).toBe('a');
  });

  it('resumes a crashed attempt with the findings of the attempt before it', async () => {
    const { seen, adapters } = fake((_spec, call) => (call === 2 ? { ok: false } : {}));
    const p = await pipeline({ config: configFor(), issues: trackedIssues(), adapters });
    const crashed = await Effect.runPromise(runPlanned(planned('loop'), p));
    expect(crashed.run).toMatchObject({ status: 'failed', closure: 'blocked', attempt: 2 });
    await Effect.runPromise(runPlanned(planned('loop'), p));
    expect(seen[2]!.prompt).toContain('Its checks last found:\n\n### exists\n\n```text\nexited non-zero\n```');
  });

  it('resumes in the blocked run session with resume: session', async () => {
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, resume: 'session' };
    const keep = "fs.mkdirSync(process.env.HOME + '/.sessions', { recursive: true })";
    const { seen, adapters } = fake(spec =>
      spec.prompt.includes('## Resuming')
        ? { message: pushB, work: continueB }
        : { message: asks, work: `${writeA}; ${keep}` }
    );
    const kept = { ...adapters, opencode: { ...adapters.opencode, sessions: '.sessions' } };
    const p = await pipeline({ config, issues: trackedIssues(), adapters: kept }, sourceRepo());
    await Effect.runPromise(runPlanned(planned('parking'), p));
    await Effect.runPromise(runPlanned(planned('parking'), { ...p, event: answer }));

    expect(seen[1]!.prompt).toContain('## Resuming');
    expect(seen[1]!.session?.id).toBe('s1');
  });

  it('finds an answer given in an earlier comment on the issue when a bare command resumes', async () => {
    const dir = temp('issues');
    writeFileSync(join(dir, '7-task.md'), '---\ntitle: Task\n---\n\nDo it.\n');
    const { seen, p } = await blockedRun(localIssues(dir, { repo: 'acme/app', as: 'octocat' }));
    await localIssues(dir, { repo: 'acme/app', as: 'octocat' }).comment(7, '/bothub Call it short.');
    await localIssues(dir, { repo: 'acme/app' }).comment(7, 'A bot status line.');
    const bare: BotEvent = { ...event, id: 'd3', body: '/bothub' };
    await Effect.runPromise(runPlanned({ ...planned('parking'), args: '' }, { ...p, event: bare }));
    const resume = seen[1]!.prompt.slice(seen[1]!.prompt.indexOf('## Resuming'));
    expect(resume).toContain('```text\nOn #7: /bothub Call it short.\n```');
    expect(resume).not.toContain('A bot status line.');
    expect(resume).not.toContain('No answer was found');
  });

  it('leaves work outside the job paths unparked and says why', async () => {
    const origin = sourceRepo();
    const { adapters } = fake({ message: asks, work: "fs.writeFileSync('notes.md', 'n')" });
    const p = await pipeline({ config: configFor(), issues: trackedIssues(), adapters }, origin);
    const result = await Effect.runPromise(runPlanned(planned('parking'), p));

    expect(result.run.parked).toBeUndefined();
    expect(result.run.reason).toMatch(/^the name is unclear; not parked: .*notes\.md/);
    expect(git(origin.dir, 'branch', '--list', 'bothub/7')).toBe('');
  });

  it('starts clean when nothing is parked', async () => {
    const origin = sourceRepo();
    const { seen, adapters } = fake({ message: asks });
    const p = await pipeline({ config: configFor(), issues: trackedIssues(), adapters }, origin);
    const first = await Effect.runPromise(runPlanned(planned('parking'), p));

    expect(first.run.parked).toBeUndefined();
    expect(seen[0]!.prompt).not.toContain('## Resuming');
    expect(git(origin.dir, 'branch', '--list', 'bothub/7')).toBe('');
    const next = await Effect.runPromise(runPlanned(planned('parking'), { ...p, event: answer }));

    expect(seen[1]!.prompt).toContain('## Resuming');
    expect(seen[1]!.prompt).not.toContain('parked on');
    expect(next.run.base).toBe(origin.main);
  });
});

const closureOf = (r: JobResult) => r.run.closure;

describe('runPlan', () => {
  const jobs = [planned('notify'), planned('plain'), planned('summarize'), triage];

  it('runs jobs in needs order and skips dependents of jobs that did not succeed', async () => {
    const p = await pipeline({ config: configFor() });
    const results = await Effect.runPromise(runPlan(jobs, p));
    expect(results.map(r => [r.job, r.run.status === 'skipped' ? r.run.reason : r.run.status, closureOf(r)])).toEqual([
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
    expect(results.map(r => [r.job, r.run.status === 'skipped' ? r.run.reason : r.run.status])).toEqual([
      ['triage', 'failed'],
      ['summarize', 'needs "triage" (blocked) to be done'],
    ]);
  });

  it('reuses a done job on the same issue until the issue changes', async () => {
    const { seen, adapters } = fake((spec, call) => ({
      ok: !(spec.system.includes('Summarize the thread.') && call < 3),
    }));
    const dir = temp('issues');
    writeFileSync(join(dir, '7-task.md'), '---\ntitle: Task\n---\n\nDo it.\n');
    const p = await pipeline({ config: configFor(), adapters, issues: localIssues(dir, { repo: 'acme/app' }) });
    const jobs = [triage, planned('summarize')];
    const first = await Effect.runPromise(runPlan(jobs, p));
    expect(first.map(r => [r.job, r.run.status])).toEqual([
      ['triage', 'succeeded'],
      ['summarize', 'failed'],
    ]);

    const second = await Effect.runPromise(runPlan(jobs, { ...p, event: { ...event, id: 'd2' } }));
    expect(second[0]!.run.id).toBe(first[0]!.run.id);
    expect(second[1]!.run.status).toBe('succeeded');
    expect(seen).toHaveLength(3);

    const third = await Effect.runPromise(runPlan(jobs, { ...p, event: { ...event, id: 'd3' } }));
    expect(third[0]!.run.id).toBe(first[0]!.run.id);
    expect(seen).toHaveLength(4);

    writeFileSync(join(dir, '7-task.md'), '---\ntitle: Task\n---\n\nDo it differently.\n');
    const fourth = await Effect.runPromise(runPlan(jobs, { ...p, event: { ...event, id: 'd4' } }));
    expect(fourth[0]!.run.id).not.toBe(first[0]!.run.id);
    expect(seen).toHaveLength(6);
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
  const pr: Proposal = { kind: 'merge-request', title: 't', body: '', branch: 'bothub/x' };

  it('says what happened to the work, not how the process ended', () => {
    expect(closure(run({ status: 'skipped', reason: 'later' }), undefined, [])).toEqual({
      closure: 'deferred',
      reason: 'later',
    });
    expect(
      closure(run({ status: 'failed', stopped: 'provider', error: 'HTTP 429: rate limit' }), undefined, []).closure
    ).toBe('deferred');
    expect(closure(run({ status: 'failed', stopped: 'stalled', error: 'stalled' }), undefined, []).closure).toBe(
      'blocked'
    );
    expect(
      closure(run({ status: 'cancelled', stopped: 'withdrawn', error: 'withdrawn: #1 was closed' }), undefined, [])
    ).toEqual({
      closure: 'no-op',
      reason: 'withdrawn: #1 was closed',
    });
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
    expect(closure(run(), outcome([push, pr]), ['push', 'merge-request']).closure).toBe('handed-off');
  });

  it('hands off a pushed branch without a pull request only to a job that takes it', () => {
    expect(closure(run(), outcome([push]), ['push'], true).closure).toBe('handed-off');
    expect(closure(run(), outcome([push]), ['push'])).toEqual({
      closure: 'blocked',
      reason: 'pushed a branch without opening a merge request',
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
      /does not start with PASS or FAIL/
    );
    expect(verdictOf(ok({}), bothub([{ kind: 'reply', body: 'pass' }]))).toEqual({ pass: true });
    expect(verdictOf(ok({}), bothub([{ kind: 'reply', body: '**FAIL**\na.ts:3 is wrong' }]))).toEqual({
      pass: false,
      findings: 'a.ts:3 is wrong',
    });
  });

  const VERDICT_FIRST_LINES = [
    { first: 'FAIL /work/docs/config.mdx:35', pass: false, findings: '/work/docs/config.mdx:35' },
    { first: 'FAIL - runs.mdx:29-31', pass: false, findings: 'runs.mdx:29-31' },
    { first: 'pass — a.ts:26 describes the digest', pass: true, findings: 'a.ts:26 describes the digest' },
    { first: '**PASS**: nothing found', pass: true, findings: 'nothing found' },
  ];

  it.each(VERDICT_FIRST_LINES)('reads the verdict that leads "$first"', ({ first, pass, findings }) => {
    expect(verdictOf(ok({}), bothub([{ kind: 'reply', body: first }]))).toEqual({ pass, findings });
  });

  it('does not read a word that only starts with pass', () => {
    expect(verdictOf(ok({}), 'Passing tests cover it.').findings).toBe('run r gave no verdict');
  });

  it('reads a final message without a bothub block as the reply', () => {
    expect(verdictOf(ok({}), 'PASS')).toEqual({ pass: true });
    expect(verdictOf(ok({}), 'FAIL\n/docs/a.mdx:96\n\nThe example omits a field.')).toEqual({
      pass: false,
      findings: '/docs/a.mdx:96\n\nThe example omits a field.',
    });
    expect(verdictOf(ok({}), bothub([{ kind: 'ask', question: 'Which file?' }]))).toEqual({
      pass: false,
      findings: 'run r gave no verdict',
    });
  });

  it('blocks a check whose run ended for a reason outside its work', () => {
    expect(verdictOf(ok({ status: 'timed-out', stopped: 'timeout' }), '')).toEqual({
      pass: false,
      findings: 'run r timed-out',
      blocked: true,
    });
    expect(verdictOf(ok({ status: 'skipped', reason: 'over budget' }), '')).toMatchObject({ blocked: true });
    expect(verdictOf(ok({ status: 'failed', stopped: 'sandbox', error: 'no network' }), '')).toMatchObject({
      blocked: true,
    });
    expect(verdictOf(ok({ status: 'failed', error: 'model error' }), '').blocked).toBe(true);
    expect(verdictOf(ok({ status: 'failed', stopped: 'stuck', error: 'stuck: a loop' }), '').blocked).toBeUndefined();
  });

  it('does not gate on a check the change does not touch, unless no gating check ran', () => {
    const skipped = (check: string): Verdict => ({ check, gating: true, pass: false, skipped: true });
    const passed: Verdict = { check: 'tests', gating: true, pass: true };
    const failed: Verdict = { check: 'types', gating: true, pass: false, findings: 'error' };
    expect(failingChecks([skipped('docs'), passed])).toEqual([]);
    expect(failingChecks([skipped('docs'), passed, failed])).toEqual([failed]);
    expect(failingChecks([skipped('docs'), skipped('kit')])).toEqual([skipped('docs'), skipped('kit')]);
    expect(failingChecks([{ ...skipped('logged'), gating: false }, passed])).toEqual([]);
    expect(failingChecks([])).toEqual([]);
  });
});

const BRIEF = 'The staking flow double-counts rewards; see `stake.ts:42`.';

const REFORMATS = [
  {
    case: 'a reply without a block, in the same session',
    message: BRIEF,
    sessions: true,
    prompt: /^Your last message has no ```bothub block\. Reply with only the block for what you wrote, nothing else\.$/,
    session: 's1',
  },
  {
    case: 'a reply without a block, with the reply when the harness keeps no session',
    message: BRIEF,
    sessions: false,
    prompt: /no ```bothub block[\s\S]*Your last message:\n\n```text\nThe staking flow/,
    session: undefined,
  },
  {
    case: 'an unreadable block, with its errors',
    message: 'Done.\n```bothub\n[{ "kind": "reply" }]\n```',
    sessions: true,
    prompt: /^The ```bothub block in your last message could not be read:\n\n- proposal 1:[\s\S]*corrected block/,
    session: 's1',
  },
] as const;

describe('proposals', () => {
  it.each(REFORMATS)('asks only for the block after $case', async ({ message, sessions, prompt, session }) => {
    const { seen, adapters } = fake((_spec, call) =>
      call === 1 ? { message, work: "fs.mkdirSync(process.env.HOME + '/.sessions', { recursive: true })" } : {}
    );
    const kept = sessions ? { ...adapters, opencode: { ...adapters.opencode, sessions: '.sessions' } } : adapters;
    const p = await pipeline({ config: configFor('warn'), adapters: kept });
    const result = await Effect.runPromise(runPlanned(triage, p));

    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toMatch(prompt);
    expect(seen[1]!.session?.id).toBe(session);
    expect(result.run).toMatchObject({ status: 'succeeded', closure: 'done', attempt: 2 });
    const runs = (await p.store.list()).reverse();
    expect(runs.map(r => [r.attempt, r.status])).toEqual([
      [undefined, 'failed'],
      [2, 'succeeded'],
    ]);
  });

  it('asks for the block once per attempt, then retries the task as before and blocks', async () => {
    const { seen, adapters } = fake({ message: BRIEF });
    const p = await pipeline({ config: configFor('warn'), adapters });
    const result = await Effect.runPromise(runPlanned(triage, p));

    expect(seen).toHaveLength(4);
    expect(seen[1]!.prompt).toMatch(/^Your last message has no ```bothub block/);
    expect(seen[2]!.prompt).toContain('## Proposal errors\n\nAttempt 2 of 2.');
    expect(seen[2]!.prompt).toContain('- the reply has no bothub block');
    expect(seen[3]!.prompt).toMatch(/^Your last message has no ```bothub block/);
    expect(result.run).toMatchObject({
      status: 'failed',
      closure: 'blocked',
      error: expect.stringMatching(/^no usable proposals after 4 attempts: the reply has no bothub block/),
    });
    const runs = (await p.store.list()).reverse();
    expect(runs.map(r => [r.attempt, r.status])).toEqual([
      [undefined, 'failed'],
      [2, 'failed'],
      [3, 'failed'],
      [4, 'failed'],
    ]);
  });

  it('retries the task straight away after a reply with no text', async () => {
    const { seen, adapters } = fake((_spec, call) => (call === 1 ? { message: '' } : {}));
    const p = await pipeline({ config: configFor('warn'), adapters });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.prompt).toContain('## Proposal errors\n\nAttempt 2 of 2.');
    expect(result.run).toMatchObject({ status: 'succeeded', closure: 'done', attempt: 2 });
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
    expect(second.run).toMatchObject({
      status: 'skipped',
      closure: 'deferred',
      reason: expect.stringMatching(
        /^bot "bot" used its 1 runs for the last 24 hours, the next one frees up at \d{4}-/
      ),
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
    expect(failed.run).toMatchObject({
      status: 'failed',
      closure: 'deferred',
      stopped: 'sandbox',
      error: 'sandbox-failed: the bothub-sandbox network is missing',
    });
    expect(seen).toHaveLength(0);
    const retried = await Effect.runPromise(runPlanned(triage, { ...p, launch: unsandboxed }));
    expect(seen).toHaveLength(1);
    expect(retried.run).toMatchObject({ status: 'succeeded', closure: 'done' });
  });

  it('stops looping once the attempts spent the run budget', async () => {
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, budget: { 'usd-per-run': 0.5 } };
    const { seen, adapters } = fake({ message: bothub([{ kind: 'reply', body: 'Done.' }]) });
    const p = await pipeline({ config, issues: trackedIssues(), adapters });
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));
    expect(seen).toHaveLength(1);
    expect(result.run).toMatchObject({
      status: 'failed',
      closure: 'blocked',
      error: 'spent $0.50 of the $0.5 budget in 1 attempts with checks still failing',
    });
  });

  it('stops retrying an unusable reply once the run budget is spent', async () => {
    const config = configFor('warn');
    config.bots.bot = { ...config.bots.bot!, budget: { 'usd-per-run': 0.5 } };
    const { seen, adapters } = fake({ message: '' });
    const result = await Effect.runPromise(runPlanned(triage, await pipeline({ config, adapters })));
    expect(seen).toHaveLength(1);
    expect(result.run.error).toMatch(/^spent \$0\.50 of the \$0\.5 budget in 1 attempts with no usable proposals/);
  });

  it('prices a run its harness reports at no cost, so the run budget still stops the loop', async () => {
    const config = configFor();
    config.bots.bot = { ...config.bots.bot!, budget: { 'usd-per-run': 0.5 } };
    const { seen, adapters } = fakeHarness(() => ({
      events: [
        { type: 'start', model: 'writer' },
        { type: 'usage', inputTokens: 1_000_000, outputTokens: 0 },
        { type: 'end', ok: true, result: bothub([{ kind: 'reply', body: 'Done.' }]), costUsd: 0 },
      ],
    }));
    const prices = async () => ({ writer: { model: 'w', input: 1, output: 1 } });
    const p = await pipeline({ config, issues: trackedIssues(), adapters, env: {}, prices });
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));
    expect(seen).toHaveLength(1);
    expect(result.run).toMatchObject({
      costUsd: 1,
      error: 'spent $1.00 of the $0.5 budget in 1 attempts with checks still failing',
    });
  });
});

describe('memory', () => {
  const memory = () => {
    const result = compile([
      md(
        'bots/mem.md',
        [
          'harness: opencode',
          'tools: [read, notes_search, history]',
          'returns: [reply, note, hub(notes/**)]',
          'preload: [{ recall: { cutoff: 0.4, budget: 900 } }]',
          'resume: summary',
          'history: hub',
          'summarizer: extractive',
        ].join('\n'),
        'You learn.'
      ),
      md('bots/quiet.md', 'harness: pi\ntools: [read]\nreturns: [reply]', 'You stay quiet.'),
      md('skills/s.md', 'description: Do it.', 'Do it.'),
      md('checks/done.md', 'type: script\nrun: test -f done.txt\nmode: block'),
      md(
        'workflows/w.md',
        `on: { issue_comment: {} }
jobs:
  learn: { type: bot, mode: warn, bot: mem, skill: s, until: { checks: [done], max: 1 } }
  history: { type: bot, bot: mem, skill: s, preload: [], returns: [reply] }
  bare: { type: bot, bot: mem, skill: s, preload: [], tools: [notes_search], returns: [reply] }
  quiet: { type: bot, bot: quiet, skill: s }`
      ),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.config;
  };

  it("wires the surfacer from preload recall, the history tool and how far the bot's history reaches", () => {
    const config = memory();
    const workflow = config.workflows.w!;
    const mcp = (tools: string[]) => ({ command: 'node', args: tools, env: {} });
    const spec = (job: string, access: object = { hub: '/hub', data: '/data', mcp }) =>
      buildSpec({ config, workflow, job, event, cwd: '/w', ...access }).spec;
    const learn = spec('learn');
    expect(learn.surfacer).toEqual({
      run: '',
      bot: 'mem',
      hub: '/hub',
      data: '/data',
      scope: 'hub',
      history: true,
      recall: { cutoff: 0.4, budget: 900, query: event.body },
    });
    expect(learn.tools).toEqual(['read', 'bothub_notes_search', 'bothub_notes_get', 'bothub_notes_add']);
    expect(learn.mcp?.args).toEqual(['notes_search', 'notes_get', 'notes_add']);
    expect(learn.system).toContain('The `notes_add` tool proposes one as well.');
    expect(learn.system).toContain(
      'A `hub` change proposes whole files of the hub, under `notes/**`; a human merges it.'
    );
    expect(learn.system).toContain('"files": [{ "path": "notes/**"');
    expect(spec('learn', {}).surfacer).toBeUndefined();
    expect(spec('history').surfacer).toMatchObject({ history: true });
    expect(spec('history').surfacer?.recall).toBeUndefined();
    expect(spec('history').tools).toEqual(['read', 'bothub_notes_search']);
    expect(spec('bare').surfacer).toBeUndefined();
    expect(spec('quiet').surfacer).toBeUndefined();
  });

  it('lands notes a run adds with notes_add, summarizes each run and resumes from the earlier attempt', async () => {
    const dataDir = temp('memory');
    const hub = temp('hub');
    const note = { kind: 'note', note: 'caveat', slug: 'fees', title: 'Fees', body: 'Fees retry once.' };
    const add = `const f = require('path').join(process.env.HOME, '.bothub', 'proposals.jsonl'); fs.mkdirSync(require('path').dirname(f), { recursive: true }); fs.appendFileSync(f, ${JSON.stringify(JSON.stringify(note) + '\n')})`;
    const { seen, adapters } = fake((_, call) => ({
      message: bothub([{ kind: 'reply', body: `Attempt ${call}.` }]),
      work: call === 2 ? `${add}; fs.writeFileSync('done.txt', '')` : add,
    }));
    const store = openStore(dataDir);
    const p = await pipeline({ config: memory(), adapters, store, data: dataDir, hub, issues: trackedIssues() });
    const result = await Effect.runPromise(runPlanned({ workflow: 'w', job: 'learn', bot: 'mem' }, p));

    const runs = (await p.store.list()).reverse();
    expect(seen.map(s => s.surfacer?.run)).toEqual(runs.map(r => r.id));
    expect(seen[0]!.prompt).not.toContain('## Your earlier attempt');
    expect(seen[1]!.prompt).toContain('## Your earlier attempt\n\n- text: working');
    expect(result.outcome?.accepted).toEqual([note, { kind: 'reply', body: 'Attempt 2.' }]);
    expect(result.outcome?.results?.find(r => r.kind === 'note')).toMatchObject({
      status: 'skipped',
      reason: 'the hub has no repository to land it in',
    });
    for (const run of runs) expect((await readSummaries(dataDir, run.id)).length).toBeGreaterThan(0);
    expect((await readSummaries(dataDir, runs.at(-1)!.id)).at(-1)).toMatchObject({
      kind: 'outcome',
      line: expect.stringMatching(
        /^outcome: succeeded, done; proposed note caveat fees Fees Fees retry once\.; reply Attempt 2\./
      ),
    });
  });
});

describe('handoff', () => {
  const flow = () => {
    const result = compile([
      md(
        'bots/bot.md',
        'harness: opencode\ntools: [read]\nreturns: [reply, push, merge-request]\nmax-turns: 5',
        'You are a careful bot.'
      ),
      md('skills/implement.md', 'description: Change code.', 'Implement it.'),
      md('skills/deploy.md', 'description: Ship it.', 'Deploy it.'),
      md(
        'workflows/flow.md',
        `on: { issue_comment: {} }
jobs:
  implement: { type: bot, mode: warn, bot: bot, skill: implement, branch: 'bothub/{issue}-{slug}', paths: ['src/**'], returns: [push, merge-request] }
  verify:
    type: script
    needs: implement
    run: test "$BOTHUB_BRANCH" = bothub/7-please-look-at-this && test "$BOTHUB_PR" = 1 && test -f src/a.ts
  deploy: { type: bot, needs: verify, mode: warn, bot: bot, skill: deploy, environment: production, returns: [reply] }`
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
            { kind: 'merge-request', title: 'Add a', body: 'Closes #7', branch },
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
    expect(first[2]?.run).toMatchObject({ status: 'skipped', reason: 'waiting for approval in #8' });
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

  it('waits for a branch another live run holds and goes on once it is released', async () => {
    const { seen, adapters } = fake(behave);
    const p = await pipeline({ config: flow(), adapters });
    const held = await p.store.lock(`acme/app:${branch}`, 'other');
    if (!('release' in held)) throw new Error('not locked');
    setTimeout(() => void held.release(), 300);
    const result = await Effect.runPromise(runPlanned(jobs[0]!, p));
    expect(seen).toHaveLength(1);
    expect(result.run.status).toBe('succeeded');
  });

  it('defers a job whose branch another live run holds past its timeout', async () => {
    const { seen, adapters } = fake(behave);
    const p = await pipeline({ config: flow(), adapters });
    const held = await p.store.lock(`acme/app:${branch}`, 'other');
    expect('release' in held).toBe(true);
    const now = Date.now();
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now + calls++ * 600_000);
    const result = await Effect.runPromise(runPlanned(jobs[0]!, p)).finally(() => vi.restoreAllMocks());
    expect(seen).toHaveLength(0);
    expect(result.run).toMatchObject({
      status: 'skipped',
      closure: 'deferred',
      reason: `branch "${branch}" is in use by run other`,
    });
  });
});

describe('over', () => {
  afterEach(() => vi.unstubAllGlobals());

  const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  /** Two files and three hunks: lines 1 and 19 of long.txt, and a new src/a.ts. */
  const work =
    "fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('src/a.ts', 'a\\n'); const l = fs.readFileSync('long.txt', 'utf8').split('\\n'); l[0] = 'first'; l[18] = 'nineteenth'; fs.writeFileSync('long.txt', l.join('\\n'))";
  const origin = () => {
    const repo = sourceRepo();
    commit(repo.dir, { 'long.txt': long });
    return repo;
  };

  type Def = { name: string; data: Record<string, unknown>; body?: string };
  const hubWith = (checks: Def[], job: Record<string, unknown> = {}) => {
    const result = compile([
      md('bots/bot.md', 'harness: opencode\ntools: [read]\nreturns: [reply]\nmax-turns: 3', 'You work.'),
      md('bots/judge.md', 'harness: opencode\ntools: [read]\nreturns: [reply]\nmax-turns: 3', 'You judge.'),
      md('skills/implement.md', 'description: Change code.', 'Implement it.'),
      ...checks.map(c => md(`checks/${c.name}.md`, JSON.stringify({ mode: 'log', ...c.data }), c.body)),
      md(
        'workflows/triage.md',
        JSON.stringify({
          on: { issue_comment: {} },
          jobs: {
            loop: {
              type: 'bot',
              bot: 'bot',
              skill: 'implement',
              returns: ['reply'],
              until: { checks: checks.map(c => c.name), max: 1 },
              ...job,
            },
          },
        })
      ),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.config;
  };

  const run = async (
    config: Config,
    behave: Parameters<typeof fake>[0] = { work },
    env = {},
    extra: Partial<Pipeline> = {}
  ) => {
    const { seen, adapters } = fake(behave);
    const p = await pipeline({ config, adapters, env: { BOTHUB_LLM_API_KEY: 'key', ...env }, ...extra }, origin());
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));

    return { result, seen, p };
  };

  const logFile = () => join(temp('over-log'), 'log');

  it('runs a script once per hunk with the hunk in BOTHUB_ITEM and on stdin', async () => {
    const log = logFile();
    const script = `echo "$(printf '%s' "$BOTHUB_ITEM" | sed -n 1p)|$(grep -c '^@@')" >> ${log}`;
    const { result } = await run(
      hubWith([{ name: 'hunks', data: { type: 'script', over: 'each-hunk', run: script } }])
    );
    expect(readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual([
      'diff --git a/long.txt b/long.txt|1',
      'diff --git a/long.txt b/long.txt|1',
      'diff --git a/src/a.ts b/src/a.ts|1',
    ]);
    expect(untimed(result.outcome?.checks)).toEqual([{ check: 'hunks', gating: false, pass: true }]);
  });

  it('stops at more hunks than each-hunk takes, and widens hunks by their context', async () => {
    const log = logFile();
    const script = `printf '%s' "$BOTHUB_ITEM" | sed -n 1p >> ${log}`;
    const { result } = await run(
      hubWith([{ name: 'few', data: { type: 'script', over: { 'each-hunk': { max: 2 } }, run: script } }])
    );
    expect(result.outcome?.checks?.[0]).toMatchObject({
      pass: false,
      findings: 'the change has 3 hunks, more than the 2 "each-hunk" takes; make a smaller change or split it',
    });
    await run(
      hubWith([{ name: 'wide', data: { type: 'script', over: { 'each-hunk': { context: 10 } }, run: script } }])
    );
    expect(readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual([
      'diff --git a/long.txt b/long.txt',
      'diff --git a/src/a.ts b/src/a.ts',
    ]);
  });

  it('judges items at once unless its concurrency says otherwise', async () => {
    const order = async (data: Record<string, unknown>) => {
      const log = logFile();
      const script = `echo start >> ${log}; sleep 0.2; echo end >> ${log}`;
      await run(hubWith([{ name: 'slow', data: { type: 'script', over: 'each-hunk', run: script, ...data } }]));
      return readFileSync(log, 'utf8').trim().split('\n');
    };
    expect(await order({ concurrency: 1 })).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
    expect((await order({})).slice(0, 3)).toEqual(['start', 'start', 'start']);
  });

  const recording = (down = '') => {
    const calls: string[] = [];
    const launch: Launcher = {
      ...unsandboxed,
      agent: (adapter, spec, secrets, home, readonly) => {
        calls.push(`agent ${spec.system.split('\n')[0]} ${readonly ? 'ro' : 'rw'}`);
        return unsandboxed.agent(adapter, spec, secrets, home, readonly);
      },
      script: (script, cwd, env, access) => {
        calls.push(`script ${script} ${access?.readonly ? 'ro' : 'rw'}`);
        if (script === down || (down && env.BOTHUB_ITEM === down))
          return Promise.reject(new SandboxError('the sandbox is down'));
        return unsandboxed.script(script, cwd, env, access);
      },
    };
    return { calls, launch };
  };
  const judged = (spec: RunSpec) =>
    spec.system.startsWith('You judge.') ? { message: bothub([{ kind: 'reply', body: 'PASS' }]) } : { work };

  it('gives checks a read-only worktree and the job a writable one', async () => {
    const { calls, launch } = recording();
    await run(
      hubWith([
        { name: 'small', data: { type: 'bot', bot: 'judge', over: 'diff' }, body: 'Is the change small?' },
        { name: 'lint', data: { type: 'script', run: 'true' } },
      ]),
      judged,
      {},
      { launch }
    );
    expect(calls).toEqual(['agent You work. rw', 'script true ro', 'agent You judge. ro']);
  });

  it('runs bot checks only once every gating script check passed, and keeps the verdicts in order', async () => {
    const { seen, result } = await run(
      hubWith([
        { name: 'small', data: { type: 'bot', bot: 'judge', over: 'diff', mode: 'block' }, body: 'Small?' },
        { name: 'lint', data: { type: 'script', run: 'echo bad; exit 1', mode: 'block' } },
      ]),
      judged
    );
    expect(seen.filter(spec => spec.system.startsWith('You judge.'))).toEqual([]);
    expect(untimed(result.outcome?.checks)).toEqual([
      { check: 'small', gating: true, pass: false, skipped: true, findings: 'not run: a script check failed' },
      { check: 'lint', gating: true, pass: false, findings: 'bad' },
    ]);
  });

  it('asks a human once when a check could not run, without sending it back to the bot', async () => {
    const { calls, launch } = recording('down');
    const issues = trackedIssues();
    const { seen, result } = await run(
      hubWith([{ name: 'tests', data: { type: 'script', run: 'down', mode: 'block' } }]),
      { work, message: bothub([{ kind: 'reply', body: 'Done.' }]) },
      {},
      { launch, issues }
    );
    expect(seen).toHaveLength(1);
    expect(calls).toEqual(['agent You work. rw', 'script down ro']);
    expect(result.outcome?.checks?.[0]).toMatchObject({ pass: false, blocked: true });
    const question = `checks could not run: tests (sandbox-failed: the sandbox is down). The change waits in run ${result.run.id}; nothing went back to the bot.`;
    expect(result.outcome?.accepted).toEqual([{ kind: 'ask', question }]);
    expect(result.run).toMatchObject({ status: 'succeeded', closure: 'blocked' });
  });

  it('retries a crashed check run once, then asks a human instead of handing off', async () => {
    const { seen, result } = await run(
      hubWith([{ name: 'small', data: { type: 'bot', bot: 'judge', over: 'diff', mode: 'warn' }, body: 'Small?' }]),
      spec => (spec.system.startsWith('You judge.') ? { ok: false, message: '' } : { work }),
      {},
      { issues: trackedIssues() }
    );
    expect(seen.filter(spec => spec.system.startsWith('You judge.'))).toHaveLength(2);
    expect(result.outcome?.checks?.[0]).toMatchObject({
      blocked: true,
      runs: [expect.any(String), expect.any(String)],
    });
    expect(result.run).toMatchObject({ closure: 'blocked' });
  });

  it('names the items that could not run first, even after other items found something', async () => {
    const { launch } = recording('c');
    const { result } = await run(
      hubWith([
        {
          name: 'items',
          data: {
            type: 'script',
            over: { each: "printf 'a\\nb\\nc\\n'" },
            run: 'echo "bad $BOTHUB_ITEM"; exit 1',
            mode: 'block',
          },
        },
      ]),
      { work, message: bothub([{ kind: 'reply', body: 'Done.' }]) },
      {},
      { launch, issues: trackedIssues() }
    );
    const question = `checks could not run: items (1 of 3 items could not run, the first: sandbox-failed: the sandbox is down). The change waits in run ${result.run.id}; nothing went back to the bot.`;
    expect(result.outcome?.accepted).toEqual([{ kind: 'ask', question }]);
    expect(result.outcome?.checks?.[0]?.findings).toContain('item 1:\nbad a');
  });

  it('settles with its warn findings once every check that holds the change passes', async () => {
    const { seen, result } = await run(
      hubWith([
        { name: 'style', data: { type: 'script', run: 'echo nit; exit 1', mode: 'warn' } },
        { name: 'small', data: { type: 'bot', bot: 'judge', over: 'diff', mode: 'block' }, body: 'Small?' },
      ]),
      spec =>
        spec.system.startsWith('You judge.')
          ? { message: bothub([{ kind: 'reply', body: 'PASS' }]) }
          : { work, message: bothub([{ kind: 'reply', body: 'Done.' }]) }
    );
    expect(seen.filter(spec => spec.system.startsWith('You work.'))).toHaveLength(1);
    expect(result.run).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(result.outcome?.accepted).toEqual([{ kind: 'reply', body: 'Done.' }]);
    expect(result.outcome?.checks?.map(v => [v.check, v.pass, v.findings])).toEqual([
      ['style', false, 'nit'],
      ['small', true, undefined],
    ]);
  });

  it('sends warn findings back alongside a failing check that holds the change', async () => {
    let judged = 0;
    const { seen, result } = await run(
      hubWith([
        { name: 'style', data: { type: 'script', run: 'echo nit; exit 1', mode: 'warn' } },
        { name: 'small', data: { type: 'bot', bot: 'judge', over: 'diff', mode: 'block' }, body: 'Small?' },
      ]),
      spec =>
        spec.system.startsWith('You judge.')
          ? { message: bothub([{ kind: 'reply', body: ++judged === 1 ? 'FAIL\ntoo big' : 'PASS' }]) }
          : { work, message: bothub([{ kind: 'reply', body: 'Done.' }]) }
    );
    const attempts = seen.filter(spec => spec.system.startsWith('You work.'));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.prompt).toContain('### style\n\n```text\nnit\n```');
    expect(attempts[1]!.prompt).toContain('### small\n\n```text\ntoo big\n```');
    expect(result.run).toMatchObject({ status: 'succeeded', attempt: 2 });
  });

  it('runs log checks only once no check that holds the change failed', async () => {
    const checks = (lint: string) =>
      hubWith([
        { name: 'lint', data: { type: 'script', run: lint, mode: 'block' } },
        { name: 'tone', data: { type: 'bot', bot: 'judge', over: 'diff' }, body: 'Calm?' },
      ]);
    const failing = await run(checks('echo bad; exit 1'), judged);
    expect(failing.seen.filter(spec => spec.system.startsWith('You judge.'))).toEqual([]);
    expect(untimed(failing.result.outcome?.checks)?.[1]).toEqual({
      check: 'tone',
      gating: false,
      pass: false,
      skipped: true,
      findings: 'not run: a check that holds the change failed',
    });
    const passing = await run(checks('true'), judged);
    expect(passing.seen.filter(spec => spec.system.startsWith('You judge.'))).toHaveLength(1);
    expect(untimed(passing.result.outcome?.checks)?.[1]).toMatchObject({ check: 'tone', pass: true });
  });

  it('tells check scripts the issue number and what the attempt replied, merge request bodies included', async () => {
    const log = logFile();
    const request = { kind: 'merge-request', title: 'Labels', body: 'Part of #7', branch: 'bothub/7' } as const;
    await run(
      hubWith([{ name: 'brief', data: { type: 'script', run: `echo "$BOTHUB_ISSUE|$BOTHUB_REPLY" >> ${log}` } }]),
      { work, message: bothub([{ kind: 'reply', body: 'Done.' }, request]) }
    );
    expect(readFileSync(log, 'utf8')).toBe('7|Done.\n\nPart of #7\n');
  });

  it('gives a check bot the issue before the verdict contract and the item last', async () => {
    const issues = trackedIssues();
    const config = hubWith([
      { name: 'small', data: { type: 'bot', bot: 'judge', over: 'diff' }, body: 'Is the change small?' },
    ]);
    config.bots.judge = { ...config.bots.judge!, preload: ['issue'] };
    const { seen } = await run(config, judged, {}, { issues });
    const prompt = seen.find(spec => spec.system.startsWith('You judge.'))!.prompt;
    const at = (text: string) => prompt.indexOf(text);
    expect(at('Is the change small?')).toBe(0);
    expect(at('Do it.')).toBeGreaterThan(0);
    expect(at('Do it.')).toBeLessThan(at('## Verdict'));
    expect(at('## Verdict')).toBeLessThan(at('## Changes'));
  });

  it('runs a script once per file', async () => {
    const log = logFile();
    const script = `printf '%s' "$BOTHUB_ITEM" | sed -n 1p >> ${log}`;
    await run(hubWith([{ name: 'files', data: { type: 'script', over: 'each-file', run: script } }]));
    expect(readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual([
      'diff --git a/long.txt b/long.txt',
      'diff --git a/src/a.ts b/src/a.ts',
    ]);
  });

  it('takes items from a script, as JSON lines or plain lines, and labels findings by item', async () => {
    const each = `test -n "$BOTHUB_BASE" && printf '%s\\n' '{"file":"docs/x.mdx","line":4}' plain`;
    const check = `test "$BOTHUB_ITEM" != plain || { echo "bad $BOTHUB_ITEM"; exit 1; }`;
    const { result } = await run(
      hubWith([{ name: 'items', data: { type: 'script', over: { each, max: 5 }, run: check } }])
    );
    expect(untimed(result.outcome?.checks)).toEqual([
      { check: 'items', gating: false, pass: false, findings: 'item 2:\nbad plain' },
    ]);
  });

  it('fails closed when the script prints more items than max, without judging any', async () => {
    const marker = logFile();
    const { result } = await run(
      hubWith([{ name: 'many', data: { type: 'script', over: { each: 'seq 5', max: 2 }, run: `touch ${marker}` } }])
    );
    expect(untimed(result.outcome?.checks)).toEqual([
      {
        check: 'many',
        gating: false,
        pass: false,
        findings: 'the "over" script printed 5 items, more than "max" allows (2)',
      },
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it('fails closed when the over script fails', async () => {
    const { result } = await run(
      hubWith([{ name: 'broken', data: { type: 'script', over: { each: 'echo nope; exit 3' }, run: 'true' } }])
    );
    expect(result.outcome?.checks?.[0]).toMatchObject({ pass: false, findings: 'the "over" script failed: nope' });
  });

  it('prompts a bot check with its body and what over names', async () => {
    const judged = (spec: RunSpec) =>
      spec.system.startsWith('You judge.') ? { message: bothub([{ kind: 'reply', body: 'PASS' }]) } : { work };
    const { result, seen } = await run(
      hubWith([
        { name: 'small', data: { type: 'bot', bot: 'judge', over: 'diff' }, body: 'Is the change small?' },
        {
          name: 'stat',
          data: { type: 'bot', bot: 'judge', over: { run: 'git diff --stat "$BOTHUB_BASE"' } },
          body: 'Judge the stat.',
        },
      ]),
      judged
    );
    const small = seen.find(s => s.prompt.startsWith('Is the change small?'))!;
    const stat = seen.find(s => s.prompt.startsWith('Judge the stat.'))!;
    expect(small.prompt).toMatch(/## Verdict\n[^]*\n\n## Changes\n\n```text\ndiff --git a\/long.txt[^]*```$/);
    expect(stat.prompt).toMatch(/\n\n## Command output\n\n```text\nlong.txt \| 4[^#]*```$/);
    expect(result.outcome?.checks?.map(c => [c.check, c.pass])).toEqual([
      ['small', true],
      ['stat', true],
    ]);
  });

  it('asks a decide check its body about each item', async () => {
    const answers = [0.9, 0.8, 0.1];
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ answers: { answer: { type: 'noul', noul: answers.shift() } } })
    );
    vi.stubGlobal('fetch', fetch);
    const { result } = await run(
      hubWith([
        {
          name: 'secrets',
          data: { type: 'decide', over: 'each-hunk', threshold: 0.5 },
          body: 'Is this hunk free of secrets?',
        },
      ]),
      { work },
      { BOTHUB_DECIDE_URL: 'http://decide.test' }
    );
    const bodies = fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body))] as const);
    expect(bodies).toHaveLength(3);
    for (const [url, body] of bodies) {
      expect(url).toBe('http://decide.test/v1/systemone');
      expect(body.questions).toEqual({ answer: { type: 'noul', instructions: 'Is this hunk free of secrets?' } });
      expect(body.state).toMatch(/^diff --git [\s\S]*\n@@ /);
    }
    expect(untimed(result.outcome?.checks)).toEqual([
      {
        check: 'secrets',
        gating: false,
        pass: false,
        findings: expect.stringMatching(
          /\nsrc\/a.ts @@ -0,0 \+1 @@:\nProbability of yes 0.100, threshold 0.5. Is this hunk free of secrets\?/
        ),
      },
    ]);
  });

  it('records each decide check call on the attempt it judged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          answers: { answer: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 80, output_tokens: 0 },
        })
      )
    );
    const { result, p } = await run(
      hubWith([{ name: 'secrets', data: { type: 'decide', over: 'each-hunk' }, body: 'Free of secrets?' }]),
      { work },
      { BOTHUB_DECIDE_URL: 'http://decide.test' }
    );
    const events = (await p.store.events(result.run.id)).map(r => r.event);
    expect(tally(events).sources['decide-check']).toMatchObject({ calls: 3, in: 240, model: 'tev1:0.8b' });
  });

  it('records the summarizer calls on the run it summarized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { content: 'text: read the fee module' } }],
          usage: { prompt_tokens: 90, completion_tokens: 4 },
        })
      )
    );
    const compiled = compile([
      md(
        'bots/bot.md',
        'harness: opencode\ntools: [read]\nreturns: [reply]\nsummarizer: { mode: model, model: small, max-bytes: 64 }',
        'You work.'
      ),
      md('skills/implement.md', 'description: Change code.', 'Implement it.'),
      md(
        'workflows/triage.md',
        JSON.stringify({
          on: { issue_comment: {} },
          jobs: { loop: { type: 'bot', bot: 'bot', skill: 'implement', returns: ['reply'] } },
        })
      ),
    ]);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const data = temp('summarized');
    const { adapters } = fakeHarness(() => ({
      events: [
        { type: 'text', text: `Reading the fee module. ${'It rounds fees. '.repeat(10)}` },
        { type: 'end', ok: true, result: bothub([{ kind: 'reply', body: 'Done.' }]) },
      ],
    }));
    const p = await pipeline(
      {
        config: compiled.config,
        adapters,
        env: { BOTHUB_LLM_API_KEY: 'key', BOTHUB_LLM_BASE_URL: 'http://llm.test/v1' },
        store: openStore(data),
        data,
      },
      origin()
    );
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));
    const events = (await p.store.events(result.run.id)).map(r => r.event);
    expect(tally(events).sources.summarizer).toMatchObject({ calls: 1, in: 90, out: 4, model: 'small' });
  });

  it('does not gate on a check whose paths match no changed file', async () => {
    const { result, seen } = await run(
      hubWith([
        { name: 'docs', data: { type: 'script', paths: ['docs/**'], run: 'exit 1', mode: 'block' } },
        { name: 'exists', data: { type: 'script', run: 'test -f src/a.ts', mode: 'block' } },
      ])
    );
    expect(seen).toHaveLength(1);
    expect(result.run).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(untimed(result.outcome?.checks)).toEqual([
      { check: 'docs', gating: true, pass: false, skipped: true, findings: 'no changed file matches its paths' },
      { check: 'exists', gating: true, pass: true },
    ]);
  });

  it('runs a script job once per item, the item in BOTHUB_ITEM and on stdin', async () => {
    const log = logFile();
    const result = compile([
      md(
        'workflows/triage.md',
        JSON.stringify({
          on: { issue_comment: {} },
          jobs: {
            each: {
              type: 'script',
              over: { each: "printf 'one\\ntwo\\n'" },
              run: `printf '%s/%s\\n' "$BOTHUB_ITEM" "$(cat)" >> ${log}`,
            },
          },
        })
      ),
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const p = await pipeline({ config: result.config }, origin());
    const job = await Effect.runPromise(runPlanned({ workflow: 'triage', job: 'each' }, p));
    expect(job.run.status).toBe('succeeded');
    expect(readFileSync(log, 'utf8')).toBe('one/one\ntwo/two\n');
  });

  it('runs a bot job once per item, each prompt with its item', async () => {
    const { seen, p } = await run(hubWith([], { over: { each: "printf 'one\\ntwo\\n'" }, until: undefined }), {});
    expect(seen.map(spec => spec.prompt.match(/## Item: (.*)\n\n```text\n(.*)/)?.slice(1))).toEqual([
      ['item 1', 'one'],
      ['item 2', 'two'],
    ]);
    const runs = await p.store.list();
    expect(runs).toHaveLength(2);
    expect(runs.filter(r => r.parent).map(r => r.parent)).toEqual([runs.find(r => !r.parent)!.id]);
  });

  it('folds the replies of a fan-out into one, findings first and passes counted', async () => {
    const issues = trackedIssues();
    const replies = ['pass\n\nNothing found.', 'findings\n\nlong.txt:19 reads oddly.', '**PASS**: nothing found.'];
    const { adapters } = fake((_spec, call) => ({ message: bothub([{ kind: 'reply', body: replies[call - 1] }]) }));
    const config = hubWith([], {
      over: { each: "printf 'one\\ntwo\\nthree\\n'" },
      until: undefined,
      mode: 'warn',
    });
    const p = await pipeline({ config, adapters, issues, env: { BOTHUB_LLM_API_KEY: 'key' } }, origin());
    const result = await Effect.runPromise(runPlanned(planned('loop'), p));
    expect(result.run.closure).toBe('done');
    expect((await issues.get(7))?.comments.map(c => unmarked(c.body))).toEqual([
      '3 items: 1 with findings, 2 passed.\n\n### item 2\n\nfindings\n\nlong.txt:19 reads oddly.',
    ]);
    const runs = (await p.store.list()).reverse();
    expect((await p.store.outcome(runs[1]!.id))?.results).toEqual([
      { kind: 'reply', status: 'applied', reason: 'folded into the summary reply' },
    ]);
    expect((await p.store.outcome(runs[0]!.id))?.results.map(r => [r.kind, r.status, r.reason])).toEqual([
      ['reply', 'applied', 'folded into the summary reply'],
      ['reply', 'applied', undefined],
    ]);

    await Effect.runPromise(runPlanned(planned('loop'), p));
    expect((await issues.get(7))?.comments).toHaveLength(1);
  });
});
