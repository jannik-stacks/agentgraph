import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Redacted } from 'effect';
import { expect, it } from 'vitest';
import { needsYou } from '../src/status.ts';
import { fileStore } from '../src/store.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const app = { repo: 'o/r', id: '42', key: Redacted.make(privateKey) };

const run = (id: string, thread: number, status: string) =>
  JSON.stringify({
    id,
    workflow: 'fix',
    thread,
    step: 's',
    status,
    tries: 0,
    rounds: {},
    sessions: {},
    started: 'x',
    usd: 0,
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
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    const body =
      u.pathname === '/installation/repositories'
        ? { repositories: repositories.map(full_name => ({ full_name })) }
        : answers[`${init.method ?? 'GET'} ${u.pathname}`];
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  };
  const data = mkdtempSync(join(tmpdir(), 'core-status-'));
  for (const [id, thread, status] of [
    ['a', 3, 'asking'],
    ['b', 4, 'waiting'],
    ['c', 5, 'done'],
  ] as const) {
    mkdirSync(join(data, id));
    writeFileSync(join(data, id, 'run.json'), run(id, thread, status));
  }
  const lines = await Effect.runPromise(
    needsYou(app, { hub: 'hub', data }, fetch).pipe(Effect.provide(fileStore(data)))
  );
  return { lines, calls };
};

it('warns about extra repos and lists parked runs', async () => {
  const { lines, calls } = await check(['o/r', 'o/other']);
  expect(lines[0]).toContain('o/other');
  expect(lines.filter(l => l.includes('--issue'))).toHaveLength(2);
  expect(lines.join('\n')).toContain('Answer at https://github.com/o/r/issues/3');
  expect(lines.join('\n')).toContain('Review the PR linked from https://github.com/o/r/issues/4');
  expect(lines.join('\n')).not.toContain('#5');
  expect(calls.filter(c => c.startsWith('POST'))).toEqual(['POST /app/installations/9/access_tokens']);
});

it('stays quiet about a single repo', async () => {
  const { lines } = await check(['o/r']);
  expect(lines.some(l => l.includes('besides'))).toBe(false);
});
