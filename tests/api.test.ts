import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api, serve } from '../src/api.ts';
import type { Runner } from '../src/serve.ts';
import { openStore, type EventRecord } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';

const hubDir = join(import.meta.dirname, 'fixtures', 'v1-hub');
const event: BotEvent = {
  id: 'e1',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'cli',
  trigger: 'issue_comment',
  repo: 'acme/app',
  number: 7,
  actor: { login: 'octocat', association: 'OWNER' },
};
const fields = {
  workflow: 'issue',
  job: 'implement',
  bot: 'implementor',
  harness: 'opencode' as const,
  event,
};
const record = (seq: number, text: string): EventRecord => ({
  ts: '2026-10-12T00:00:00.000Z',
  seq,
  event: { type: 'text', text },
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-api-'));
  const store = openStore(dir);
  const handle = api({ hubDir, store });
  const get = (path: string, init?: RequestInit) => handle(new Request(`http://studio${path}`, init));
  return { dir, store, get };
};

describe('api', () => {
  it('serves the compiled example hub', async () => {
    const { get } = setup();
    const body = await (await get('/api/hub')).json();
    expect(Object.keys(body.config.workflows)).toEqual(['issue', 'review']);
    expect(Object.keys(body.config.bots).sort()).toEqual(['implementor', 'reviewer']);
  });

  it('serves config errors for a broken hub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bothub-hub-'));
    mkdirSync(join(dir, 'bots'));
    writeFileSync(join(dir, 'bots', 'bad.md'), '---\nharness: nope\n---\nhi\n');
    const body = await (await api({ hubDir: dir, store: openStore(dir) })(new Request('http://studio/api/hub'))).json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].path).toBe('bots/bad.md');
  });

  it('serves a run with its outcome', async () => {
    const { store, get } = setup();
    const run = await store.create(fields);
    expect(await (await get(`/api/runs/${run.id}`)).json()).toEqual({ run, outcome: null });
    const outcome = { proposals: [], errors: [], accepted: [], rejected: [], results: [], applied: false };
    await store.saveOutcome(run.id, outcome);
    expect((await (await get(`/api/runs/${run.id}`)).json()).outcome).toEqual(outcome);
  });

  it('answers a health probe and serves ops only with a runner, from localhost, validated', async () => {
    const { store, get } = setup();
    expect(await (await get('/healthz')).json()).toEqual({ ok: true });
    const json = { method: 'POST', headers: { 'content-type': 'application/json' } };
    expect((await get('/rpc/status', { ...json, body: '{}' })).status).toBe(404);

    const stopped: string[] = [];
    const runner = { stops: new Map([['r1', () => stopped.push('r1')]]) } as unknown as Runner;
    const handle = api({ hubDir, store, runner });
    const call = (op: string, body: unknown, host = '127.0.0.1') =>
      handle(new Request(`http://${host}/rpc/${op}`, { ...json, body: JSON.stringify(body) }));
    expect(await (await call('runs_stop', { id: 'r1' })).json()).toEqual({ stopped: 'r1' });
    expect(stopped).toEqual(['r1']);
    const missing = await call('runs_stop', { id: 'r2' });
    expect([missing.status, (await missing.json()).error]).toEqual([409, 'run "r2" is not running here']);
    expect((await call('runs_stop', { id: 3 })).status).toBe(400);
    expect((await call('nope', {})).status).toBe(404);
    expect((await call('runs_stop', { id: 'r1' }, 'example.com')).status).toBe(403);
  });

  it('serves events from an offset', async () => {
    const { store, get } = setup();
    const { id } = await store.create(fields);
    for (const [i, text] of ['a', 'b', 'c'].entries()) await store.append(id, record(i, text));
    expect((await (await get(`/api/runs/${id}/events?from=1`)).json()).map((r: EventRecord) => r.seq)).toEqual([1, 2]);
    expect((await get(`/api/runs/${id}/events?from=x`)).status).toBe(400);
  });

  it('answers 404 for unknown runs and routes, 405 for writes', async () => {
    const { get } = setup();
    for (const path of ['/api/runs/nope', '/api/runs/nope/events', '/api/other'])
      expect((await get(path)).status).toBe(404);
    expect((await get('/api/runs', { method: 'POST' })).status).toBe(405);
  });
});

describe('serve', () => {
  it('adapts node:http to the handler', async () => {
    const { store } = setup();
    const run = await store.create(fields);
    const server = await serve(api({ hubDir, store }), 0);
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/events`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect((await fetch(`http://127.0.0.1:${port}/api/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
