import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Redacted } from 'effect';
import { expect, it } from 'vitest';
import type { Run } from '../src/workflow.ts';
import { readInstallationReach } from '../src/github.ts';
import { findRunsWaitingOnPeople, formatNextSteps, formatRunnerError } from '../src/status.ts';
import { fileStore, Store } from '../src/store.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const app = { repo: 'o/r', id: '42', key: Redacted.make(privateKey) };

/** A run.json as an older version wrote it: `thread` for the issue, `asking` for a run waiting on an answer. */
const run = (id: string, thread: number, status: string) =>
  JSON.stringify({
    id,
    workflow: 'fix',
    thread,
    step: 's',
    status,
    ...(status === 'asking' && { reason: 'which one?' }),
    tries: 0,
    rounds: {},
    sessions: {},
    started: 'x',
  });

const answers: Record<string, unknown> = {
  'GET /repos/o/r/installation': { id: 9 },
  'POST /app/installations/9/access_tokens': {
    token: 'tok',
    expires_at: '2999-01-01T00:00:00Z',
  },
};

const check = async (repositories: string[]) => {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    const body =
      u.pathname === '/installation/repositories'
        ? { repositories: repositories.map(full_name => ({ full_name })) }
        : answers[`${init.method ?? 'GET'} ${u.pathname}`];
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  };
  const data = mkdtempSync(join(tmpdir(), 'agentgraph-status-'));
  for (const [id, issue, status] of [
    ['a', 3, 'asking'],
    ['b', 4, 'waiting'],
    ['c', 5, 'done'],
  ] as const) {
    mkdirSync(join(data, id));
    writeFileSync(join(data, id, 'run.json'), run(id, issue, status));
  }
  const runs = await Effect.runPromise(Effect.flatMap(Store, s => s.list()).pipe(Effect.provide(fileStore(data))));
  const lines = [
    ...(await Effect.runPromise(readInstallationReach(app, fetch))),
    ...findRunsWaitingOnPeople(runs).flatMap(r => formatNextSteps(r, 'o/r')),
  ];
  return { lines, calls, bodies };
};

it('warns about extra repos and lists waiting runs', async () => {
  const { lines, calls, bodies } = await check(['o/r', 'o/other']);
  expect(bodies).toEqual([{ permissions: { metadata: 'read' } }]);
  expect(lines[0]).toContain('o/other');
  expect(lines.filter(l => l.includes('is waiting'))).toHaveLength(2);
  expect(lines.join('\n')).toContain('Answer at https://github.com/o/r/issues/3');
  expect(lines.join('\n')).toContain('Review the PR linked from https://github.com/o/r/issues/4');
  expect(lines.join('\n')).not.toContain('#5');
  expect(calls.filter(c => c.startsWith('POST'))).toEqual(['POST /app/installations/9/access_tokens']);
});

it('stays quiet about a single repo', async () => {
  const { lines } = await check(['o/r']);
  expect(lines.some(l => l.includes('besides'))).toBe(false);
});

it('says how to continue on the local forge, and leaves out a run that waits on its child', () => {
  const base = { workflow: 'issue', step: 'merge', tries: 0, rounds: {}, started: 'x' } as const;
  const runs = [
    { ...base, id: 'a', issue: 3, status: 'waiting', reason: 'which one?' },
    { ...base, id: 'b', issue: 4, status: 'waiting' },
    { ...base, id: 'p', issue: 5, status: 'waiting', reason: 'waiting on c' },
    { ...base, id: 'c', issue: 5, status: 'running', by: 'p' },
  ] as Run[];
  const lines = findRunsWaitingOnPeople(runs).flatMap(r => formatNextSteps(r));
  expect(lines.join('\n')).toContain(`agi say 3 "<answer>"`);
  expect(lines.join('\n')).toContain(`agi merge 4`);
  expect(lines.join('\n')).toContain(`agi review 4 changes "<why>"`);
  expect(lines.join('\n')).not.toContain('#5');
});

const askedRunnerError = (question: string) => ({
  at: 'x',
  step: 'implement',
  outcome: { kind: 'ask' as const, question },
  run: { step: 'implement', status: 'waiting' as const, tries: 0, rounds: {} },
});

it('names the last question a runner error asked and the trace file', () => {
  expect(
    formatRunnerError(
      [
        askedRunnerError('SessionStop: first'),
        { at: 'x', step: 'implement', setup: { ms: 1, exit: 0 } },
        askedRunnerError('SandboxError: root'),
      ],
      '/d/r/trace.jsonl'
    )
  ).toEqual(['cause    SandboxError: root', 'trace    /d/r/trace.jsonl']);
});
