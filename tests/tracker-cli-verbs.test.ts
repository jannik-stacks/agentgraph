import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/proposal.ts';
import { loadGraph } from '../src/folder.ts';
import { writeTriggeringIssue } from '../src/main.ts';
import { folderTracker } from '../src/tracker.ts';
import type { SessionEvent } from '../src/trace.ts';
import { harnesses, reply, start, wrote } from './fixtures.ts';
import { git, issuePath, writeIssueAt } from './kit.ts';

import { makeTrackerWorld as world } from './tracker-cli-fixtures.ts';
const sandboxGraph = join(import.meta.dirname, '..', 'examples', 'sandbox');

describe('the human verbs on a tracker folder', () => {
  it('files an issue, runs it to a pull request, sends it back from the pull request, and merges', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    writeFileSync(join(w.root, 'body.md'), 'Add hello.txt.\n');
    expect(await w.tracker('issue', 'Add a greeting', '--body', join(w.root, 'body.md'))).toBe('#1');
    await w.tracker('label', '1', 'agent:ready');

    const push = (message: string): Proposal => ({ kind: 'push', branch: 'agentgraph/1', message });
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/1',
      base: 'main',
      title: 'Add hello',
      body: 'Adds hello.txt.',
    };
    const first = await w.run([
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(w.seen[0]!.tracker).toBe(w.dir);
    expect(first.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(readFileSync(issuePath(w.dir, 2, 'diff.patch'), 'utf8')).toContain('+hello');
    expect(await w.tracker('show')).toBe(
      '#1 open Add a greeting [agent:ready]\n#2 open Add hello (agentgraph/1 into main)'
    );

    await w.tracker('comment', '2', '/agent say hello world');
    const routed = await w.run([[start('o'), reply({ kind: 'tell', issue: 1, text: 'say hello world' })]]);
    expect(routed.map(r => [r.workflow, r.status])).toEqual([['router', 'done']]);
    const second = await w.run([
      [start('a'), reply({ kind: 'comment', body: 'On it.' }, { kind: 'back', why: 'say hello world' })],
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(second.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(await w.tracker('show', '2')).toContain('+hello world');

    expect(await w.tracker('merge', '2')).toMatch(/^main at [0-9a-f]{40}$/);
    expect(git(w.origin, 'show', 'main:hello.txt')).toBe('hello world');
    expect(await w.tracker('show')).toBe(
      '#1 closed Add a greeting [agent:ready]\n#2 merged Add hello (agentgraph/1 into main)'
    );
    const last = await w.run([]);
    expect(last.map(r => [r.issue, r.step, r.status])).toEqual([[1, 'merge', 'done']]);
    expect(await w.tracker('show')).toBe(
      '#1 closed Add a greeting [agent:ready]\n#2 merged Add hello (agentgraph/1 into main)'
    );
  });

  it('starts a run on a dropped issue file once, and reads one without frontmatter', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    writeIssueAt(issuePath(w.dir, 1), '# Fix the typo\n\nIn the readme.\n');
    writeIssueAt(
      issuePath(w.dir, 2),
      '---\ntitle: Add a greeting\nauthor: morgan\nlabels: [agent:ready]\n---\n\nAdd hello.txt.\n'
    );
    expect(await w.tracker('show')).toBe('#1 open Fix the typo\n#2 open Add a greeting [agent:ready]');
    expect(await w.tracker('show', '2')).toMatch(/morgan label agent:ready/);
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/2',
      base: 'main',
      title: 'Add hello',
      body: 'Adds it.',
    };
    const first = await w.run([
      [
        start('i'),
        wrote('hello.txt', 'hello\n'),
        reply({ kind: 'push', branch: 'agentgraph/2', message: 'feat: add hello' }, pull),
      ],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(first.map(r => [r.issue, r.step, r.status])).toEqual([[2, 'merge', 'waiting']]);
    expect(await w.tracker('show', '3')).toContain('+hello');
    expect(await w.run([])).toEqual([]);
    expect(readdirSync(w.data).filter(d => d.startsWith('issue-'))).toHaveLength(1);
    await w.tracker('close', '1');
    expect(await w.tracker('show')).toMatch(/^#1 closed Fix the typo\n/);
    expect(await w.tracker('show', '1')).toContain('In the readme.');
  });

  it('goes from text to a run to a diff with no GitHub', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    const graph = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    await expect(
      writeTriggeringIssue(graph, folderTracker(w.dir, 'morgan'), 'Add a greeting', 'morgan', 'router')
    ).rejects.toThrow('name one workflow with a label: --workflow <name>');
    await expect(
      writeTriggeringIssue(graph, folderTracker(w.dir, 'morgan'), 'Add a greeting', 'morgan')
    ).rejects.toThrow('issue|triage');
    await expect(
      writeTriggeringIssue(graph, folderTracker(w.dir, 'morgan'), 'Add a greeting', 'x[bot]', 'issue')
    ).rejects.toThrow('x[bot] may not');
    await expect(
      writeTriggeringIssue(
        { ...graph, trust: ['ann'] },
        folderTracker(w.dir, 'morgan'),
        'Add a greeting',
        'morgan',
        'issue'
      )
    ).rejects.toThrow('morgan may not');
    expect(
      await writeTriggeringIssue(
        graph,
        folderTracker(w.dir, 'morgan'),
        'Add a greeting\n\nAdd hello.txt.',
        'morgan',
        'issue'
      )
    ).toBe(1);
    expect(await w.tracker('show', '1')).toMatch(
      /^#1 open Add a greeting by morgan \[agent:ready\]\n\nAdd hello.txt.\n/
    );
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/1',
      base: 'main',
      title: 'Add hello',
      body: 'Adds it.',
    };
    const runs = await w.run(
      [
        [
          start('i'),
          wrote('hello.txt', 'hello\n'),
          reply({ kind: 'push', branch: 'agentgraph/1', message: 'feat: add hello' }, pull),
        ],
        [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
      ],
      1,
      undefined,
      0,
      true
    );
    expect(runs.map(r => [r.workflow, r.step, r.status])).toEqual([['issue', 'merge', 'waiting']]);
    expect(await w.tracker('show', '2')).toContain('+hello');
    expect(await w.tracker('show', '1')).toMatch(
      / comment\nOpened a pull request\.\n\nPull request: \S+tracker\/2\/issue\.md$/
    );
  });

  it('sends a pull request back with the line comments posted just before the review in its reason', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    await w.tracker('label', '1', 'agent:ready');
    const push = (message: string): Proposal => ({ kind: 'push', branch: 'agentgraph/1', message });
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'agentgraph/1',
      base: 'main',
      title: 'Add hello',
      body: 'Adds it.',
    };
    const [waiting] = await w.run([
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    await w.tracker('comment', '2', 'say hello world', '--line', 'hello.txt:1');
    await w.tracker('review', '2', 'changes', 'see the line note');
    await w.run([
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    const backs = readFileSync(join(w.data, waiting!.id, 'trace.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { outcome?: { kind: string; why?: string } })
      .flatMap(l => (l.outcome?.kind === 'back' ? [l.outcome.why] : []));
    expect(backs).toEqual([expect.stringMatching(/^see the line note\nhello.txt:1, id \S+: say hello world$/)]);
  });

  it('runs a stacked issue on the pull request of the one it stacks on', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    writeFileSync(join(w.root, 'body.md'), 'Add bye.txt.\n\nStacks on #1\n');
    await w.tracker('issue', 'Say bye', '--body', join(w.root, 'body.md'));
    await w.tracker('label', '1', 'agent:ready');
    await w.tracker('label', '2', 'agent:ready');
    const turn = (n: number, file: string): SessionEvent[][] => [
      [
        start(`i${n}`),
        wrote(file, `${file}\n`),
        reply(
          { kind: 'push', branch: `agentgraph/${n}`, message: `feat: add ${file}` },
          { kind: 'pull_request', branch: `agentgraph/${n}`, base: 'main', title: `Add ${file}`, body: `Adds ${file}.` }
        ),
      ],
      [start(`r${n}`), reply({ kind: 'comment', body: 'Looks right.' })],
    ];
    await w.run([...turn(1, 'hello.txt'), ...turn(2, 'bye.txt')]);
    expect(await w.tracker('show')).toContain('#3 open Add hello.txt (agentgraph/1 into main)');
    expect(await w.tracker('show')).toContain('#4 open Add bye.txt (agentgraph/2 into agentgraph/1)');

    await w.tracker('merge', '3');
    expect(await w.tracker('show')).toContain('#4 open Add bye.txt (agentgraph/2 into main)');
    await w.tracker('merge', '4');
    expect(git(w.origin, 'show', 'main:bye.txt')).toBe('bye.txt');
    expect(existsSync(issuePath(w.dir, 2))).toBe(true);
  });

  it('starts the router on a bare mention, stops a waiting run on a mention with stop, and ignores stop with no run', async () => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    await w.tracker('comment', '1', '/agent:stop');
    expect(await w.run([])).toEqual([]);

    await w.tracker('comment', '1', '/agent');
    const asked = await w.run([[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(asked.map(r => [r.step, r.status])).toEqual([['router', 'waiting']]);

    await w.tracker('comment', '1', '/agent:stop wrong issue');
    const stopped = await w.run([]);
    expect(stopped.map(r => [r.step, r.status, r.reason])).toEqual([['router', 'stopped', 'wrong issue']]);
  });

  it.each([0, 1])('routes review say with %i checkout failures', async failures => {
    const w = world();
    await w.tracker('init', w.seed);
    await w.tracker('issue', 'Add a greeting');
    await w.tracker('label', '1', 'agent:ready');
    const [waiting] = await w.run([
      [
        start('i'),
        wrote('hello.txt', 'hello\n'),
        reply(
          { kind: 'push', branch: 'agentgraph/1', message: 'feat: hello' },
          { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Hello', body: 'Hello' }
        ),
      ],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    await w.tracker('comment', '2', 'This line?', '--line', 'hello.txt:1');
    const event = readFileSync(issuePath(w.dir, 2, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
      .at(-1);
    const routed = await w.run(
      [
        [
          start('cli-router'),
          reply({ kind: 'comment', body: 'Answer in thread.' }, { kind: 'tell', issue: 1, text: 'Please revise it' }),
        ],
      ],
      2,
      { kind: 'say', issue: 2, comment: event.comment.id, text: 'Please explain this line' },
      failures
    );
    const router = routed.find(r => r.workflow === 'router')!;
    expect(router.status).toBe('done');
    const trace = readFileSync(join(w.data, router.id, 'trace.jsonl'), 'utf8');
    expect(trace).toContain('"source":"cli"');
    expect(
      JSON.parse(
        trace
          .trim()
          .split('\n')
          .find(l => JSON.parse(l).prompt)!
      ).prompt.prompt
    ).toContain('hello.txt:1');
    expect(
      trace
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
        .some(t => t.prompt?.prompt.includes('Please explain this line'))
    ).toBe(true);
    const timeline = readFileSync(issuePath(w.dir, 2, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    expect(
      timeline.some(m => m.comment?.body.includes('Answer in thread.') && m.comment.under === event.comment.id)
    ).toBe(true);
    expect(readFileSync(join(w.data, waiting!.id, 'trace.jsonl'), 'utf8')).toContain('"text":"Please revise it"');
  });
});
