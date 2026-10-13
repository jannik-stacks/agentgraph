import { appendFileSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { api, serve } from '../src/api.ts';
import { tail, watchRuns } from '../src/live.ts';
import { loadPrices, modelNames } from '../src/prices.ts';
import { openStore, type EventRecord } from '../src/store.ts';
import type { AgentEvent, BotEvent } from '../src/types.ts';
import { estimate, tally } from '../src/usage.ts';

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
const fields = { workflow: 'issue', job: 'implement', bot: 'implementor', harness: 'opencode' as const, event };
const record = (seq: number, text = `step ${seq}`): EventRecord => ({
  ts: '2026-10-12T00:00:00.000Z',
  seq,
  event: { type: 'text', text },
});

type Message = { event: string; id?: string; data: unknown };

/** Reads Server-Sent Events from a response body as they arrive. */
const reader = (response: Response) => {
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queued: Message[] = [];
  const pull = async () => {
    const { value, done } = await body.read();
    if (done) throw new Error('stream ended');
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(':')) continue;
      const lines = Object.fromEntries(
        block.split('\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)])
      );
      queued.push({
        event: lines.event ?? 'message',
        ...(lines.id && { id: lines.id }),
        data: JSON.parse(lines.data ?? 'null'),
      });
    }
  };
  /** Messages up to and including the first one `until` accepts. */
  const until = async (done: (message: Message) => boolean) => {
    const seen: Message[] = [];
    for (;;) {
      while (queued.length) {
        const message = queued.shift()!;
        seen.push(message);
        if (done(message)) return seen;
      }
      await pull();
    }
  };
  return { until, cancel: () => body.cancel() };
};

const setup = (dir = mkdtempSync(join(tmpdir(), 'bothub-live-')), watch = {}) => {
  const store = openStore(dir);
  const handle = api({ hubDir, store, watch: { pollMs: 20, ...watch } });
  const get = (path: string, init?: RequestInit) => handle(new Request(`http://studio${path}`, init));
  return { dir, store, get };
};

const seqs = (messages: Message[]) =>
  messages.flatMap(m => (m.event === 'record' ? [(m.data as EventRecord).seq] : []));

describe('live stream', () => {
  it('sends a snapshot, the followed run in order, and runs as they change', async () => {
    const { store, get } = setup();
    const { id } = await store.create({ ...fields, status: 'running' });
    for (const seq of [0, 1]) await store.append(id, record(seq));
    const abort = new AbortController();
    const stream = reader(await get(`/api/stream?run=${id}`, { signal: abort.signal }));
    const first = await stream.until(m => m.event === 'record' && (m.data as EventRecord).seq === 1);
    expect(first[0]).toMatchObject({ event: 'snapshot', data: { runs: [{ id, tally: { calls: 0 } }], pulls: [] } });
    expect(first.find(m => m.event === 'outcome')).toMatchObject({ data: { id, outcome: null } });
    expect(seqs(first)).toEqual([0, 1]);
    expect(first.at(-1)?.id).toBe('1');

    for (const seq of [2, 3, 4]) await store.append(id, record(seq));
    await store.append(id, { ts: '', seq: 5, event: { type: 'usage', inputTokens: 100, outputTokens: 7 } });
    const appended = await stream.until(m => m.event === 'record' && (m.data as EventRecord).seq === 5);
    expect(seqs(appended)).toEqual([2, 3, 4, 5]);

    const other = await store.create(fields);
    const created = await stream.until(m => m.event === 'run' && (m.data as { id: string }).id === other.id);
    expect(created.at(-1)?.data).toMatchObject({ status: 'queued' });
    await store.update(id, { status: 'succeeded' });
    const changed = await stream.until(
      m => m.event === 'run' && (m.data as { id: string; status: string }).status === 'succeeded'
    );
    expect(changed.at(-1)?.data).toMatchObject({ id, tally: { calls: 1, in: 100, out: 7 } });
    abort.abort();
  });

  it('hears appends through fs.watch without waiting for a poll', async () => {
    const { store, get } = setup(undefined, { pollMs: 60_000 });
    const { id } = await store.create({ ...fields, status: 'running' });
    const abort = new AbortController();
    const stream = reader(await get(`/api/stream?run=${id}`, { signal: abort.signal }));
    await stream.until(m => m.event === 'outcome');
    await store.append(id, record(0));
    const seen = await stream.until(m => m.event === 'record');
    expect(seqs(seen)).toEqual([0]);
    abort.abort();
  });

  it('resumes after Last-Event-ID without repeating or dropping a record', async () => {
    const { store, get } = setup();
    const { id } = await store.create({ ...fields, status: 'running' });
    for (const seq of [0, 1, 2, 3]) await store.append(id, record(seq));
    const abort = new AbortController();
    const stream = reader(
      await get(`/api/stream?run=${id}`, { signal: abort.signal, headers: { 'last-event-id': '1' } })
    );
    const seen = await stream.until(m => m.event === 'record' && (m.data as EventRecord).seq === 3);
    expect(seqs(seen)).toEqual([2, 3]);
    abort.abort();
    expect((await get(`/api/stream?run=${id}&from=x`)).status).toBe(400);
  });

  it('sends a line that arrives in two writes once, when it is complete', async () => {
    const { dir, store, get } = setup();
    const { id } = await store.create({ ...fields, status: 'running' });
    const file = join(dir, 'runs', id, 'events.jsonl');
    const line = JSON.stringify(record(0, 'ünïcode')) + '\n';
    appendFileSync(file, line.slice(0, 20));
    const abort = new AbortController();
    const stream = reader(await get(`/api/stream?run=${id}`, { signal: abort.signal }));
    await stream.until(m => m.event === 'outcome');
    appendFileSync(file, line.slice(20));
    const seen = await stream.until(m => m.event === 'record');
    expect(seen.at(-1)?.data).toMatchObject({ seq: 0, event: { text: 'ünïcode' } });
    abort.abort();
  });

  it('follows a symlinked data directory, also when the link moves', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bothub-live-'));
    const [a, b, link] = ['a', 'b', 'live'].map(name => join(base, name)) as [string, string, string];
    mkdirSync(a);
    mkdirSync(b);
    symlinkSync(a, link);
    const { store, get } = setup(link);
    const first = await store.create(fields);
    const abort = new AbortController();
    const stream = reader(await get('/api/stream', { signal: abort.signal }));
    const [snapshot] = await stream.until(m => m.event === 'snapshot');
    expect((snapshot!.data as { runs: { id: string }[] }).runs.map(r => r.id)).toEqual([first.id]);
    const second = await store.create(fields);
    await stream.until(m => m.event === 'run' && (m.data as { id: string }).id === second.id);

    const moved = await openStore(b).create(fields);
    unlinkSync(link);
    symlinkSync(b, link);
    const reset = await stream.until(m => m.event === 'snapshot');
    expect(reset.find(m => m.event === 'reset')?.data).toMatchObject({ dir: link, real: expect.stringMatching(/b$/) });
    expect((reset.at(-1)!.data as { runs: { id: string }[] }).runs.map(r => r.id)).toEqual([moved.id]);
    abort.abort();
  });

  it('notices changes by polling when fs.watch is off, and reports removed runs and pulls', async () => {
    const { dir, store, get } = setup(undefined, { useWatch: false, pollMs: 10, sweepEvery: 2 });
    const run = await store.create(fields);
    const abort = new AbortController();
    const stream = reader(await get('/api/stream', { signal: abort.signal }));
    await stream.until(m => m.event === 'snapshot');
    await store.saveOutcome(run.id, {
      proposals: [{ kind: 'reply', body: 'hi' }],
      errors: [],
      accepted: [],
      rejected: [],
      results: [{ kind: 'reply', status: 'applied' }],
      applied: true,
      pr: 3,
    });
    const briefed = await stream.until(m => m.event === 'run' && 'brief' in (m.data as object));
    expect(briefed.at(-1)?.data).toMatchObject({ brief: { applied: true, kinds: ['reply'], pr: 3 } });
    writeFileSync(
      join(dir, 'pulls.jsonl'),
      JSON.stringify({
        number: 3,
        op: 'open',
        branch: 'b',
        into: 'main',
        title: 't',
        body: '',
        sha: 'x',
        job: 'implement',
        event: 'e1',
      }) + '\n'
    );
    const pulls = await stream.until(m => m.event === 'pulls');
    expect(pulls.at(-1)?.data).toEqual([
      { number: 3, title: 't', branch: 'b', into: 'main', state: 'open', origin: { job: 'implement', event: 'e1' } },
    ]);
    renameSync(join(dir, 'runs', run.id), join(dir, 'gone'));
    await stream.until(m => m.event === 'removed' && (m.data as { id: string }).id === run.id);
    abort.abort();
  });

  it('answers the snapshot as JSON', async () => {
    const { store, get } = setup();
    const { id } = await store.create(fields);
    await store.append(id, { ts: '', seq: 0, event: { type: 'tool_call', id: 'c', tool: 'read', input: { a: 1 } } });
    const body = await (await get('/api/live')).json();
    expect(body.runs).toMatchObject([{ id, tally: { tools: 1, toolChars: 7 } }]);
  });

  it('says which hub and data directory it serves', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bothub-live-'));
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'live'));
    const { get } = setup(join(base, 'live'));
    const info = await (await get('/api/info')).json();
    expect(info).toMatchObject({ hub: hubDir, data: join(base, 'live'), pid: process.pid });
    expect(info.dataReal).toMatch(/real$/);
  });
});

describe('serve', () => {
  it('rejects with a readable error when the port is taken', async () => {
    const { get } = setup();
    const first = await serve(req => get(new URL(req.url).pathname), 0);
    const { port } = first.address() as AddressInfo;
    await expect(serve(req => get(new URL(req.url).pathname), port)).rejects.toThrow(`port ${port} is in use`);
    first.close();
  });
});

describe('run watcher', () => {
  it('starts with its first subscriber and stops with its last', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bothub-live-'));
    const store = openStore(dir);
    await store.create(fields);
    const watcher = watchRuns(dir, { pollMs: 10 });
    const a = watcher.subscribe(() => {});
    await a.ready;
    expect(watcher.rows()).toHaveLength(1);
    a.close();
    await watcher.idle();
  });

  it('reads only complete lines and returns the offset after them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bothub-live-'));
    const file = join(dir, 'f');
    expect(await tail(file, 0)).toEqual({ lines: [], offset: 0, size: 0 });
    writeFileSync(file, 'a\nb\nc');
    expect(await tail(file, 0)).toEqual({ lines: ['a', 'b'], offset: 4, size: 5 });
    expect(await tail(file, 4)).toEqual({ lines: [], offset: 4, size: 5 });
  });
});

describe('usage', () => {
  const events: AgentEvent[] = [
    { type: 'usage', inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, reasoningTokens: 50, costUsd: 0.01 },
    { type: 'tool_call', id: 'a', tool: 'read', input: 'abcd' },
    { type: 'tool_result', id: 'a', ok: true, output: 'efgh' },
    { type: 'error', message: 'x' },
    { type: 'end', ok: true, costUsd: 0.5 },
  ];

  it('tallies tokens, tools and the harness cost', () => {
    expect(tally(events)).toEqual({
      calls: 1,
      in: 1000,
      out: 100,
      cached: 800,
      reasoning: 50,
      usd: 0.5,
      tools: 1,
      toolChars: 8,
      errors: 1,
    });
  });

  it('estimates list cost with cached input at its own price', () => {
    expect(estimate(tally(events), { input: 1, cached: 0.1, output: 10 })).toBeCloseTo((200 + 80 + 1500) / 1e6);
    expect(estimate(tally(events), undefined)).toBeUndefined();
  });

  it('resolves alias prices from the environment, the proxy and the table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bothub-live-'));
    const file = join(dir, 'prices.json');
    writeFileSync(
      file,
      JSON.stringify({
        aliases: { smart: 'chatgpt/m1' },
        models: { m1: { input: 1, output: 2 }, m2: { input: 3, output: 4 } },
      })
    );
    const proxy = async () =>
      Response.json({
        data: [
          {
            model_name: 'review',
            litellm_params: { model: 'anthropic/x' },
            model_info: { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 5e-7 },
          },
          { model_name: 'writer', litellm_params: { model: 'chatgpt/m1' }, model_info: { input_cost_per_token: 0 } },
        ],
      });
    const prices = await loadPrices({
      file,
      env: { BOTHUB_MODEL_FAST: 'ollama/m2', BOTHUB_LLM_BASE_URL: 'http://proxy/v1', LITELLM_MASTER_KEY: 'k' },
      fetcher: proxy as typeof fetch,
    })();
    expect(prices.smart).toEqual({ input: 1, output: 2, model: 'chatgpt/m1' });
    expect(prices.writer).toEqual({ input: 1, output: 2, model: 'chatgpt/m1' });
    expect(prices.fast).toEqual({ input: 3, output: 4, model: 'ollama/m2' });
    expect(prices.review).toMatchObject({ model: 'anthropic/x', input: 5, output: 25 });
    expect(prices.review?.cached).toBeCloseTo(0.5);
    expect(await loadPrices({ env: {} })()).toEqual({});
  });
});

const MODEL_CONFIGS = [
  {
    name: 'every alias once, sorted',
    files: [
      { path: 'local/litellm.config.yaml', source: 'model_list:\n  - model_name: smart\n  - model_name: fast\n' },
    ],
    names: ['fast', 'smart'],
  },
  {
    name: 'aliases of every proxy config',
    files: [
      { path: 'litellm.yaml', source: 'model_list:\n  - model_name: smart\n' },
      { path: 'local/litellm.offline.yml', source: 'model_list:\n  - model_name: smart\n  - model_name: local\n' },
    ],
    names: ['local', 'smart'],
  },
  { name: 'no other yaml', files: [{ path: 'compose.yaml', source: 'model_list:\n  - model_name: x\n' }], names: [] },
  {
    name: 'no commented alias',
    files: [{ path: 'litellm.yaml', source: '# model_name: old\nmodel_list: []\n' }],
    names: [],
  },
  { name: 'nothing from broken yaml', files: [{ path: 'litellm.yaml', source: 'model_list: [' }], names: [] },
];

describe('modelNames', () => {
  it.each(MODEL_CONFIGS)('lists $name', ({ files, names }) => {
    expect(modelNames(files)).toEqual(names);
  });
});
