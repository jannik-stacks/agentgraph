import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { claude } from '../src/executors/claude.ts';
import type { GitHub } from '../src/github-app.ts';
import { buildSpec, runPlan, runPlanned, secretsFor, type Pipeline } from '../src/pipeline.ts';
import { limiter } from '../src/runner.ts';
import { openStore } from '../src/store.ts';
import type { BotEvent, ExecutorAdapter, RunSpec } from '../src/types.ts';
import { workspaces } from '../src/workspace.ts';
import { sourceRepo, temp } from './git.ts';

const compiled = (mode: string) =>
  compile([
    {
      path: 'personas/bot.md',
      source: `---
executor: claude-code
model: sonnet
tools: [Read, Grep]
can-write: [reply, label, open-pr]
max-turns: 7
timeout-minutes: 30
---

You are a careful bot.`,
    },
    {
      path: 'workflows/triage.md',
      source: `---
name: triage
on: { issue_comment: {} }
jobs:
  triage:
    mode: ${mode}
    persona: bot
    timeout-minutes: 5
    safe-outputs:
      reply: { max: 1 }
  summarize:
    needs: triage
    persona: bot
  notify:
    needs: [plain]
    persona: bot
  plain:
    steps: [{ run: echo hi }]
---

## triage

Triage the issue.

## summarize

Summarize the thread.

## notify

Notify someone.`,
    },
  ]);

const configFor = (mode = 'shadow'): Config => {
  const result = compiled(mode);
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

const finalMessage = [
  'Done.',
  '```bothub',
  JSON.stringify([
    { kind: 'reply', body: 'Looks like a bug.' },
    { kind: 'reply', body: 'Second reply.' },
    { kind: 'label', add: ['bug'] },
  ]),
  '```',
].join('\n');

const lines = (ok: boolean) =>
  [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'sonnet' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    {
      type: 'result',
      subtype: ok ? 'success' : 'error',
      is_error: !ok,
      num_turns: 2,
      result: finalMessage,
      total_cost_usd: 0.5,
    },
  ]
    .map(line => JSON.stringify(line))
    .join('\n');

/** A claude-shaped adapter that runs `node -e` in the worktree, checks its secrets and records each spec. */
const fake = (ok = true) => {
  const seen: RunSpec[] = [];
  const adapter: ExecutorAdapter = {
    name: 'claude-code',
    command: spec => {
      seen.push(spec);
      const script = `require('fs').accessSync('README.md'); if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'oauth' || process.env.OTHER) process.exit(9); console.log(${JSON.stringify(lines(ok))}); process.exit(${ok ? 0 : 1})`;
      return { cmd: 'node', args: ['-e', script], env: {} };
    },
    parseLine: claude.parseLine,
  };
  return { seen, adapters: { 'claude-code': adapter, codex: adapter } };
};

const fakeGitHub = () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const gh = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return { html_url: `https://github.com/acme/app/issues/7#c${calls.length}` };
  }) as GitHub;
  return { calls, gh };
};

const pipeline = async (overrides: Partial<Pipeline> & { config: Config }): Promise<Pipeline> => {
  const origin = sourceRepo();
  const dataDir = temp('pipeline');
  return {
    event,
    store: openStore(dataDir),
    workspaces: workspaces({ dataDir, cloneUrl: () => origin.dir }),
    limit: await Effect.runPromise(limiter(1)),
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth', OTHER: 'nope' },
    adapters: fake().adapters,
    ...overrides,
  };
};

const triage = { workflow: 'triage', job: 'triage', persona: 'bot' };

describe('buildSpec', () => {
  const config = configFor();
  const persona = config.personas.bot!;
  const workflow = config.workflows.triage!;

  it('adds the proposal format for allowed kinds and the event to the prompt', () => {
    const { spec, timeoutMinutes } = buildSpec({ persona, workflow, job: 'triage', event, args: 'go', cwd: '/w' });
    expect(timeoutMinutes).toBe(5);
    expect(spec).toMatchObject({ cwd: '/w', model: 'sonnet', tools: ['Read', 'Grep'], maxTurns: 7 });
    expect(spec.system.startsWith('You are a careful bot.\n\n## Proposing changes\n')).toBe(true);
    expect(spec.system).toContain(
      '```bothub\n[\n  { "kind": "reply", "body": "Markdown comment on the issue or pull request" }\n]\n```'
    );
    expect(spec.system).not.toMatch(/"kind": "(label|open-pr)"/);
    expect(spec.system).not.toContain('Branches must start');
    expect(spec.system.endsWith('\n\nInclude only the proposals you need.')).toBe(true);
    expect(spec.prompt).toBe(
      [
        'Triage the issue.',
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

  it('quotes the event text with a fence longer than any it contains and falls back to the persona timeout', () => {
    const { spec, timeoutMinutes } = buildSpec({ persona, workflow, job: 'summarize', event, cwd: '/w' });
    expect(timeoutMinutes).toBe(30);
    expect(spec.prompt.endsWith('Text:\n\n````text\nplease look at ```this```\n````')).toBe(true);
    expect(spec.system).toBe('You are a careful bot.');
  });
});

describe('secretsFor', () => {
  it('picks only what the executor needs', () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 't', OPENAI_API_KEY: 'k' };
    expect(secretsFor('claude-code', env)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
    expect(secretsFor('codex', env)).toEqual({});
  });
});

describe('runPlanned', () => {
  it('records proposals in shadow mode without applying them and removes the worktree', async () => {
    const { calls, gh } = fakeGitHub();
    const { seen, adapters } = fake();
    const p = await pipeline({ config: configFor('shadow'), gh, adapters });
    const result = await Effect.runPromise(runPlanned(triage, p));
    if (!('run' in result)) throw new Error('skipped');
    expect(result.run).toMatchObject({ status: 'succeeded', costUsd: 0.5, turns: 2, persona: 'bot' });
    expect(result.outcome).toMatchObject({
      errors: [],
      accepted: [{ kind: 'reply', body: 'Looks like a bug.' }],
      rejected: [
        { proposal: { kind: 'reply' }, reason: 'more than 1 "reply" proposals' },
        { proposal: { kind: 'label' }, reason: '"label" is not allowed for this job' },
      ],
      results: [],
      applied: false,
    });
    expect(result.outcome?.proposals).toHaveLength(3);
    expect(calls).toEqual([]);
    const runDir = join(seen[0]!.cwd, '../../runs', result.run.id);
    expect(JSON.parse(readFileSync(join(runDir, 'outcome.json'), 'utf8'))).toEqual(result.outcome);
    expect(await p.store.outcome(result.run.id)).toEqual(result.outcome);
    expect(seen[0]!.cwd).toMatch(new RegExp(`work/${result.run.id}$`));
    expect(existsSync(seen[0]!.cwd)).toBe(false);
  });

  it('applies accepted proposals when the mode allows it and a client is given', async () => {
    const { calls, gh } = fakeGitHub();
    const p = await pipeline({ config: configFor('warn'), gh });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect('run' in result && result.outcome).toMatchObject({
      applied: true,
      results: [{ kind: 'reply', status: 'applied', url: 'https://github.com/acme/app/issues/7#c1' }],
    });
    expect(calls).toEqual([
      { method: 'POST', path: '/repos/acme/app/issues/7/comments', body: { body: 'Looks like a bug.' } },
    ]);
  });

  it('never applies without a client or after a failed run', async () => {
    const p = await pipeline({ config: configFor('warn') });
    const result = await Effect.runPromise(runPlanned(triage, p));
    expect('run' in result && result.outcome?.applied).toBe(false);

    const { calls, gh } = fakeGitHub();
    const failing = await pipeline({ config: configFor('warn'), gh, adapters: fake(false).adapters });
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

  it('skips jobs without a persona', async () => {
    const p = await pipeline({ config: configFor() });
    expect(await Effect.runPromise(runPlanned({ workflow: 'triage', job: 'plain' }, p))).toEqual({
      workflow: 'triage',
      job: 'plain',
      skipped: 'the job has no persona',
    });
  });
});

describe('runPlan', () => {
  const planned = [
    { workflow: 'triage', job: 'notify', persona: 'bot' },
    { workflow: 'triage', job: 'plain' },
    { workflow: 'triage', job: 'summarize', persona: 'bot' },
    triage,
  ];

  it('runs jobs in needs order and skips dependents of jobs that did not succeed', async () => {
    const p = await pipeline({ config: configFor() });
    const results = await Effect.runPromise(runPlan(planned, p));
    expect(results.map(r => [r.job, 'skipped' in r ? r.skipped : r.run.status])).toEqual([
      ['triage', 'succeeded'],
      ['summarize', 'succeeded'],
      ['plain', 'the job has no persona'],
      ['notify', 'needs "plain", which did not succeed'],
    ]);
  });

  it('skips a dependent when the job it needs fails', async () => {
    const p = await pipeline({ config: configFor(), adapters: fake(false).adapters });
    const results = await Effect.runPromise(runPlan([triage, planned[2]!], p));
    expect(results.map(r => [r.job, 'skipped' in r ? r.skipped : r.run.status])).toEqual([
      ['triage', 'failed'],
      ['summarize', 'needs "triage", which did not succeed'],
    ]);
  });
});
