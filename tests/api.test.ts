import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api, readFiles, serve } from '../src/api.ts';
import { openStore, type EventRecord } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';

const hubDir = join(import.meta.dirname, '..', 'examples', 'hub');
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
  harness: 'claude-code' as const,
  event,
};
const record = (seq: number, text: string): EventRecord => ({
  ts: '2026-10-12T00:00:00.000Z',
  seq,
  event: { type: 'text', text },
});

const setup = () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'bothub-api-')));
  const handle = api({ hubDir, store, pollMs: 10 });
  const get = (path: string, init?: RequestInit) => handle(new Request(`http://studio${path}`, init));
  return { store, get };
};

const readSse = async (response: Response) => {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map(block =>
      Object.fromEntries(
        block.split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)])
      )
    );
};

describe('api', () => {
  it('serves the compiled example hub', async () => {
    const { get } = setup();
    const body = await (await get('/api/hub')).json();
    expect(Object.keys(body.config.workflows)).toEqual(['issue']);
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

  it('lists runs and serves one with its outcome', async () => {
    const { store, get } = setup();
    const run = await store.create(fields);
    expect(await (await get('/api/runs')).json()).toEqual([run]);
    expect(await (await get(`/api/runs/${run.id}`)).json()).toEqual({ run, outcome: null });
    const outcome = { proposals: [], errors: [], accepted: [], rejected: [], results: [], applied: false };
    await store.saveOutcome(run.id, outcome);
    expect((await (await get(`/api/runs/${run.id}`)).json()).outcome).toEqual(outcome);
  });

  it('lists runs that need a human', async () => {
    const { store, get } = setup();
    const asked = await store.create(fields);
    await store.saveOutcome(asked.id, {
      proposals: [{ kind: 'ask', question: 'Which port?' }],
      errors: [],
      accepted: [],
      rejected: [],
      results: [],
      applied: false,
    });
    const broken = await store.create(fields);
    await store.update(broken.id, { status: 'failed', error: 'boom' });
    await store.create(fields);
    const body = await (await get('/api/needs-human')).json();
    expect(body.map((item: { run: { id: string }; reason: string }) => [item.run.id, item.reason]).sort()).toEqual(
      [
        [asked.id, 'asked'],
        [broken.id, 'failed'],
      ].sort()
    );
    expect(body.find((item: { reason: string }) => item.reason === 'asked').questions).toEqual(['Which port?']);
  });

  it('serves events from an offset', async () => {
    const { store, get } = setup();
    const { id } = await store.create(fields);
    for (const [i, text] of ['a', 'b', 'c'].entries()) await store.append(id, record(i, text));
    expect((await (await get(`/api/runs/${id}/events?from=1`)).json()).map((r: EventRecord) => r.seq)).toEqual([1, 2]);
    expect((await get(`/api/runs/${id}/events?from=x`)).status).toBe(400);
  });

  it('lists and serves raw harness files, refusing anything else', async () => {
    const { store, get } = setup();
    const { id } = await store.create(fields);
    expect(await (await get(`/api/runs/${id}/files`)).json()).toEqual([]);
    mkdirSync(join(store.home(id), '.codex', 'sessions'), { recursive: true });
    writeFileSync(join(store.home(id), '.codex', 'sessions', 'rollout-1.jsonl'), '{"a":1}\n');
    writeFileSync(join(store.home(id), '.codex', 'auth.json'), '{"key":"x"}');
    expect(await (await get(`/api/runs/${id}/files`)).json()).toEqual(['.codex/sessions/rollout-1.jsonl']);

    const file = await get(`/api/runs/${id}/files/.codex/sessions/rollout-1.jsonl`);
    expect(file.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(await file.text()).toBe('{"a":1}\n');
    for (const path of ['.codex/auth.json', '..%2Frun.json', '%2E%2E/%2E%2E/run.json', 'nope.jsonl'])
      expect((await get(`/api/runs/${id}/files/${path}`)).status).toBe(404);
    expect((await get('/api/runs/nope/files')).status).toBe(404);
  });

  it('answers 404 for unknown runs and routes, 405 for writes', async () => {
    const { get } = setup();
    for (const path of ['/api/runs/nope', '/api/runs/nope/events', '/api/runs/nope/stream', '/api/other'])
      expect((await get(path)).status).toBe(404);
    expect((await get('/api/runs', { method: 'POST' })).status).toBe(405);
  });

  it('streams a finished run and ends', async () => {
    const { store, get } = setup();
    const { id } = await store.create(fields);
    for (const [i, text] of ['a', 'b'].entries()) await store.append(id, record(i, text));
    await store.update(id, { status: 'succeeded' });
    const response = await get(`/api/runs/${id}/stream`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await readSse(response)).toEqual([
      { id: '0', data: JSON.stringify(record(0, 'a')) },
      { id: '1', data: JSON.stringify(record(1, 'b')) },
      { event: 'end', data: '{"status":"succeeded"}' },
    ]);
  });

  it('tails a live run until it leaves running, resuming after Last-Event-ID', async () => {
    const { store, get } = setup();
    const { id } = await store.create(fields);
    await store.update(id, { status: 'running' });
    await store.append(id, record(0, 'a'));
    const response = get(`/api/runs/${id}/stream`, { headers: { 'last-event-id': '0' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    await store.append(id, record(1, 'b'));
    await store.update(id, { status: 'failed' });
    const messages = await readSse(await response);
    expect(messages.map(m => m.id ?? m.event)).toEqual(['1', 'end']);
  });

  it('stops tailing when the client aborts', async () => {
    const { store, get } = setup();
    const { id } = await store.create(fields);
    const abort = new AbortController();
    const response = await get(`/api/runs/${id}/stream`, { signal: abort.signal });
    abort.abort();
    expect(await response.text()).toBe('');
  });
});

describe('readFiles', () => {
  it('lists text files per root and skips hidden, binary, large and escaping paths', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'bothub-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    const dir = mkdtempSync(join(tmpdir(), 'bothub-files-'));
    mkdirSync(join(dir, 'bots'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'bots', 'a.md'), '---\nharness: pi\n---\nhi\n');
    writeFileSync(join(dir, 'node_modules', 'x.js'), '1');
    writeFileSync(join(dir, '.env'), 'TOKEN=1');
    writeFileSync(join(dir, '.env.example'), 'TOKEN=');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
    symlinkSync(outside, join(dir, 'escape'));
    symlinkSync(dir, join(dir, 'bots', 'loop'));

    const files = await readFiles([
      { name: 'hub', dir },
      { name: 'infra', dir: join(dir, 'missing') },
    ]);
    expect(files.map(f => `${f.root}:${f.path}`)).toEqual(['hub:.env.example', 'hub:bots/a.md']);
    expect(files[1]?.source).toContain('harness: pi');
  });

  it('is served at /api/files with the hub first', async () => {
    const infra = mkdtempSync(join(tmpdir(), 'bothub-infra-'));
    writeFileSync(join(infra, 'compose.yml'), 'services: {}\n');
    const handle = api({ hubDir, store: openStore(infra), roots: [{ name: 'infra', dir: infra }] });
    const files = await (await handle(new Request('http://studio/api/files'))).json();
    expect(files[0].root).toBe('hub');
    expect(files.at(-1)).toEqual({ root: 'infra', path: 'compose.yml', source: 'services: {}\n' });
  });
});

describe('serve', () => {
  it('adapts node:http to the handler', async () => {
    const { store } = setup();
    const run = await store.create(fields);
    const server = await serve(api({ hubDir, store }), 0);
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}`);
      expect(response.status).toBe(200);
      expect((await response.json()).run).toEqual(run);
      expect((await fetch(`http://127.0.0.1:${port}/api/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
