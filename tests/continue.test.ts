import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { toEvent } from '../src/github.ts';
import { localIssues } from '../src/issues-local.ts';
import { continuation, type Pipeline } from '../src/pipeline.ts';
import { localPulls, type Pulls } from '../src/pulls.ts';
import { limiter, unsandboxed } from '../src/runner.ts';
import { compiledHub, eventQueue, handleEvent, laneOf, type Hub } from '../src/serve.ts';
import { openStore } from '../src/store.ts';
import type { BotEvent, RunSpec } from '../src/types.ts';
import { workspaces } from '../src/workspace.ts';
import { bareOrigin, fakeHarness, git, temp, write } from './kit.ts';

const block = (proposals: unknown[]) => ['Done.', '```bothub', JSON.stringify(proposals), '```'].join('\n');

const hubFiles = {
  'hub.yaml': 'issues: local\n',
  'bots/bot.md':
    '---\nharness: opencode\ntools: [read]\nreturns: [reply, push, merge-request]\nskills: [triage, implement]\n---\nYou work.\n',
  'skills/triage.md': '---\ndescription: Sort it.\n---\nSort the issue.\n',
  'skills/implement.md': '---\ndescription: Change code.\n---\nChange the code.\n',
  'workflows/issue.md': [
    '---',
    'name: issue',
    'on:',
    '  issue_comment:',
    '    types: [created]',
    '    command: /bothub',
    'jobs:',
    '  triage: { type: bot, bot: bot, skill: triage, returns: [reply], mode: warn }',
    '  implement:',
    '    type: bot',
    '    needs: [triage]',
    '    bot: bot',
    '    skill: implement',
    '    branch: bothub/{issue}',
    '    returns: [push, merge-request]',
    '    mode: warn',
    '---',
    'Implements.',
    '',
  ].join('\n'),
  'issues/7-task.md': '---\ntitle: Task\nauthor: morgan\n---\n\nAdd a.\n',
};

const implementing = (spec: RunSpec) => spec.system.includes('Change the code.');

const sessions = '.local/share/opencode';

/**
 * A served-like hub on a local origin whose implementor writes `src/a.ts` and opens a request, then when it continues
 * pushes `src/b.ts` alone. Each run names a session and appends it to a session file in its home.
 */
const setup = async (bot = '', retryTriage = false) => {
  const dir = temp('continue-hub');
  write(dir, { ...hubFiles, 'bots/bot.md': hubFiles['bots/bot.md'].replace('---\nYou work', `${bot}---\nYou work`) });
  const data = temp('continue-data');
  const origin = bareOrigin();
  const issues = localIssues(join(dir, 'issues'), { repo: 'acme/app' });
  const pulls = localPulls({ origin, file: join(data, 'pulls.jsonl'), repo: 'acme/app' });
  const { seen, adapters } = fakeHarness((spec, call) => {
    if (!implementing(spec) && retryTriage && call === 1) return { events: [{ type: 'end', ok: true, result: 'Done.' }] };
    if (!implementing(spec))
      return { events: [{ type: 'end', ok: true, result: block([{ kind: 'reply', body: 'Brief.' }]) }] };
    const file = spec.prompt.includes('## Continuing') ? 'src/b.ts' : 'src/a.ts';
    const home = `require('path').join(process.env.HOME, '${sessions}')`;
    const proposals = [
      { kind: 'push', branch: 'bothub/7', files: [file] },
      ...(file === 'src/a.ts' ? [{ kind: 'merge-request', title: 'Task', body: 'Closes #7', branch: 'bothub/7' }] : []),
    ];
    return {
      work: [
        `fs.mkdirSync('src', { recursive: true }); fs.writeFileSync('${file}', 'x')`,
        `fs.mkdirSync(${home}, { recursive: true }); fs.appendFileSync(${home} + '/db', 'ses_${call}\\n')`,
      ].join('; '),
      events: [
        { type: 'start', session: `ses_${call}` },
        { type: 'end', ok: true, result: block(proposals) },
      ],
    };
  });
  const logs: string[] = [];
  const hub: Hub = {
    dir,
    data,
    store: openStore(data),
    workspaces: workspaces({ dataDir: data, cloneUrl: () => origin }),
    limit: await Effect.runPromise(limiter(2)),
    env: {},
    config: compiledHub(dir, () => {}).config,
    backend: () => ({ issues, pulls }),
    log: line => logs.push(line),
    adapters: { ...adapters, opencode: { ...adapters.opencode, sessions } },
    launch: unsandboxed,
  };
  const comment: BotEvent = {
    id: 'c1',
    ts: new Date().toISOString(),
    source: 'local',
    trigger: 'issue_comment',
    action: 'created',
    repo: 'acme/app',
    number: 7,
    actor: { login: 'morgan', association: 'OWNER' },
    body: '/bothub add a',
  };
  const first = await handleEvent(comment, hub);
  const commentEvent = async (n: number) => (await pulls.events()).find(e => e.id === `local-pull-1-comment-${n}`)!;
  return { hub, origin, pulls, seen, logs, first, commentEvent };
};

describe('continuing from a merge request', { timeout: 30_000 }, () => {
  it('continues the job on its branch with the comment and line comments, reusing the jobs before it', async () => {
    const { hub, origin, pulls, seen, logs, first, commentEvent } = await setup();
    expect(logs).toContain(`issue/implement: succeeded, handed-off ${first[1]!.run.id}`);
    expect(first.map(r => [r.job, r.run.closure])).toEqual([
      ['triage', 'done'],
      ['implement', 'handed-off'],
    ]);
    expect(await pulls.list()).toMatchObject([{ number: 1, branch: 'bothub/7', origin: { job: 'issue/implement' } }]);

    await pulls.comment(1, { author: 'morgan', body: 'Call it b.', path: 'src/a.ts', line: 1 });
    await pulls.comment(1, { author: 'morgan', body: '/bothub fix the naming' });
    const line = await commentEvent(1);
    expect(line).toMatchObject({ trigger: 'pull_request_review_comment', number: 1, pull: 1 });
    expect(await handleEvent(line, hub)).toEqual([]);

    const results = await handleEvent(await commentEvent(2), hub);
    expect(results.map(r => [r.job, r.run.closure])).toEqual([
      ['triage', 'done'],
      ['implement', 'handed-off'],
    ]);
    expect(results[0]!.run.id).toBe(first[0]!.run.id);
    expect(results[1]!.run.event).toMatchObject({ trigger: 'issue_comment', number: 7, pull: 1 });
    expect(seen).toHaveLength(3);
    const prompt = seen[2]!.prompt;
    const section = prompt.slice(prompt.indexOf('## Continuing'));
    expect(section).toContain(`run ${first[1]!.run.id} (handed-off)`);
    expect(section).toContain('Your work is on `bothub/7` and already in this worktree, with merge request #1 open');
    expect(section).toContain('```text\nfix the naming\n```');
    expect(section).toContain('```text\nOn src/a.ts:1: Call it b.\n```');
    expect(section).not.toContain('On merge request #1: /bothub');
    expect(git(origin, 'show', 'bothub/7:src/a.ts')).toBe('x');
    expect(git(origin, 'show', 'bothub/7:src/b.ts')).toBe('x');
    expect(await pulls.list({ state: 'all' })).toHaveLength(1);
  });

  it('reuses a triage that needed a second attempt', async () => {
    const { hub, pulls, seen, first, commentEvent } = await setup('', true);
    expect(seen).toHaveLength(3);
    await pulls.comment(1, { author: 'morgan', body: '/bothub go on' });
    const results = await handleEvent(await commentEvent(1), hub);
    expect(results[0]!.run.id).toBe(first[0]!.run.id);
    expect(seen).toHaveLength(4);
  });

  it('measures a continued change from where the branch forked, starting at the merge request tip', async () => {
    const { hub, origin, pulls, seen, first, commentEvent } = await setup();
    const pushed = git(origin, 'rev-parse', 'bothub/7');
    await pulls.comment(1, { author: 'morgan', body: '/bothub go on' });
    const [, again] = await handleEvent(await commentEvent(1), hub);
    expect(again!.run.base).toBe(git(origin, 'rev-parse', 'main'));
    expect(git(origin, 'rev-parse', 'bothub/7^')).toBe(pushed);
    expect(seen).toHaveLength(3);

    await pulls.comment(1, { author: 'morgan', body: '/bothub all check it all' });
    const results = await handleEvent(await commentEvent(2), hub);
    expect(results.map(r => r.run.id)).not.toContain(first[0]!.run.id);
    expect(seen).toHaveLength(5);
    expect(results[1]!.run.base).toBe(git(origin, 'rev-parse', 'main'));
    expect(seen[4]!.prompt).toContain('```text\ncheck it all\n```');
  });

  it('starts the branch over with `fresh`, keeping the merge request', async () => {
    const { hub, origin, pulls, seen, commentEvent } = await setup();
    await pulls.comment(1, { author: 'morgan', body: '/bothub more' });
    await handleEvent(await commentEvent(1), hub);
    expect(git(origin, 'ls-tree', '--name-only', '-r', 'bothub/7', 'src').split('\n')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);

    await pulls.comment(1, { author: 'morgan', body: '/bothub fresh' });
    const results = await handleEvent(await commentEvent(2), hub);
    expect(results.map(r => r.run.closure)).toEqual(['done', 'handed-off']);
    expect(seen.at(-1)!.prompt).not.toMatch(/## (Continuing|Resuming)/);
    expect(git(origin, 'ls-tree', '--name-only', '-r', 'bothub/7', 'src')).toBe('src/a.ts');
    expect(await pulls.list()).toMatchObject([{ number: 1, branch: 'bothub/7' }]);
  });

  it('starts a later run of a `context: resume` bot fresh, seeded with what the last run did and its change', async () => {
    const { hub, pulls, seen, commentEvent } = await setup('context: resume\n');
    await pulls.comment(1, { author: 'morgan', body: '/bothub go on' });
    const [, again] = await handleEvent(await commentEvent(1), hub);
    expect(seen[1]!.session).toBeUndefined();
    expect(seen[2]!.session).toBeUndefined();
    expect(seen[2]!.prompt).toContain('## Continuing');
    expect(seen[2]!.prompt).toMatch(/What your last run did:\n\n- [\s\S]*Your change so far:/);
    expect(readFileSync(join(hub.store.home(again!.run.id), sessions, 'db'), 'utf8')).toBe('ses_3\n');
  });

  it("queues a comment that continues an issue in the issue's lane, apart from the request's own", async () => {
    const { hub, pulls, commentEvent } = await setup();
    await pulls.comment(1, { author: 'morgan', body: '/bothub go on' });
    const delivered = await commentEvent(1);
    const ran: BotEvent[] = [];
    const queue = await eventQueue(hub, async event => void ran.push(event), {});
    queue.enqueue(delivered);
    await queue.idle();
    await queue.stop();
    expect(laneOf({ id: delivered.id, item: delivered })).toBe('acme/app!1');
    expect(ran).toMatchObject([{ id: delivered.id, trigger: 'issue_comment', number: 7, pull: 1 }]);
    expect(ran.map(item => laneOf({ id: item.id, item }))).toEqual(['acme/app#7']);
  });

  it('says how to answer when a bare comment lands on an unsure issue', async () => {
    const { hub, logs } = await setup();
    const question = await localIssues(join(hub.dir, 'issues'), { repo: 'acme/app' }).create({
      title: 'Which name?',
      labels: ['unsure'],
      parent: 7,
    });
    const answer: BotEvent = {
      id: 'a1',
      ts: new Date().toISOString(),
      source: 'local',
      trigger: 'issue_comment',
      action: 'created',
      repo: 'acme/app',
      number: question.number,
      actor: { login: 'morgan', association: 'OWNER' },
      body: 'call it b',
    };
    expect(await handleEvent(answer, hub)).toEqual([]);
    expect(logs).toContain(
      `#${question.number} is an open question; start the answer with /bothub to continue the work`
    );
  });

  it('starts nothing on a merged request or from a bot', async () => {
    const { hub, origin, pulls, seen, logs, commentEvent } = await setup();
    await pulls.comment(1, { author: 'helper[bot]', body: '/bothub again' });
    expect(await handleEvent(await commentEvent(1), hub)).toEqual([]);

    const pull = (await pulls.get(1))!;
    await pulls.merge(1, { head: pull.head!, into: git(origin, 'rev-parse', 'main') });
    await pulls.comment(1, { author: 'morgan', body: '/bothub again' });
    expect(await handleEvent(await commentEvent(2), hub)).toEqual([]);
    expect(logs).toContain('event local-pull-1-comment-2 continues nothing, merge request #1 is merged');
    expect(seen).toHaveLength(2);
  });

  it("maps a GitHub comment on a pull request to the opening run's issue", async () => {
    const store = openStore(temp('continue-store'));
    const opened: BotEvent = {
      id: 'e1',
      ts: '',
      source: 'github',
      trigger: 'issue_comment',
      repo: 'acme/app',
      number: 7,
      actor: { login: 'j', association: 'OWNER' },
    };
    await store.create({ workflow: 'issue', job: 'implement', event: opened });
    const user = { login: 'morgan' };
    const event = toEvent('issue_comment', 'd9', {
      action: 'created',
      repository: { full_name: 'acme/app' },
      sender: user,
      issue: { number: 12, html_url: 'u', body: '', user, author_association: 'OWNER', pull_request: {} },
      comment: { body: '/bothub again', html_url: 'u', author_association: 'OWNER' },
    })!;
    expect(event).toMatchObject({ number: 12, pull: 12, ref: 'refs/pull/12/head' });
    const pull = {
      number: 12,
      url: 'u',
      title: 't',
      body: '',
      branch: 'bothub/7',
      into: 'main',
      origin: { job: 'issue/implement', event: 'e1' },
    };
    const pulls = (state: 'open' | 'closed') => ({ get: async () => ({ ...pull, state }) }) as unknown as Pulls;
    const p = (state: 'open' | 'closed') => ({ event, store, pulls: pulls(state) }) as unknown as Pipeline;

    const continued = await continuation(p('open'));
    expect(continued).toEqual({
      workflow: 'issue',
      event: expect.objectContaining({ trigger: 'issue_comment', number: 7, pull: 12 }),
    });
    expect(continued && 'event' in continued && continued.event).not.toHaveProperty('ref');
    const again = continued && 'event' in continued ? continued.event : event;
    expect(await continuation({ ...p('open'), event: again })).toEqual(continued);
    expect(await continuation(p('closed'))).toEqual({ reason: 'merge request #12 is closed' });
    const { pull: _, ...onIssue } = event;
    expect(await continuation({ ...p('open'), event: onIssue })).toBeUndefined();
  });
});
