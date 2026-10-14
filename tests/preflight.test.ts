import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { authFailure, preflight } from '../src/preflight.ts';

const bot = (model: string, harness = 'opencode') =>
  `---\nharness: ${harness}\nmodel: ${model}\ntools: []\nreturns: []\n---\nRole.`;
const compiled = compile([
  { path: 'bots/triage.md', source: bot('small') },
  { path: 'bots/review.md', source: bot('big') },
  { path: 'bots/native.md', source: bot('opus', 'claude') },
]);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

const stub = async (good: string) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    res.statusCode = req.headers.authorization === `Bearer ${good}` ? 200 : 401;
    res.end('{"error":{"message":"Authentication Error, Malformed API Key passed in."}}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, seen, close: () => server.close() };
};

describe('preflight', () => {
  it('names the bot and variable of a refused key, once per endpoint and key, without the key', async () => {
    const s = await stub('good');
    const lines = await preflight(compiled.config, {
      BOTHUB_LLM_BASE_URL: s.url,
      BOTHUB_LLM_API_KEY: 'good',
      BOTHUB_LLM_API_KEY_REVIEW: 'sk-secret-bad',
    });
    s.close();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('review (big)');
    expect(lines[0]).toContain('BOTHUB_LLM_API_KEY_REVIEW');
    expect(lines[0]).not.toContain('sk-secret-bad');
    expect(s.seen).toHaveLength(2);
  });

  it('passes with good keys and skips bots without an endpoint', async () => {
    const s = await stub('good');
    expect(await preflight(compiled.config, { BOTHUB_LLM_BASE_URL: s.url, BOTHUB_LLM_API_KEY: 'good' })).toEqual([]);
    s.close();
    expect(await preflight(compiled.config, {})).toEqual([]);
  });

  it('recognises auth failures', () => {
    expect(authFailure('Authentication Error, Malformed API Key passed in.')).toBe(true);
    expect(authFailure('HTTP 429 rate limited')).toBe(false);
  });
});
