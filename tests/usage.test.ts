import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decide, decideCheck } from '../src/decide.ts';
import { compareSpend } from '../src/spend.ts';
import { openStore } from '../src/store.ts';
import { complete } from '../src/summaries.ts';
import type { AgentEvent } from '../src/types.ts';
import { meter, sources, sum, tally, type Usage } from '../src/usage.ts';

afterEach(() => vi.unstubAllGlobals());

const usage = (fields: Partial<Usage> = {}): Usage => ({
  type: 'usage',
  inputTokens: 100,
  outputTokens: 10,
  ...fields,
});

const SOURCES = sources.map(source => ({ source, event: usage({ source, model: 'm', ms: 7, cachedInputTokens: 40 }) }));

describe('tally by source', () => {
  it.each(SOURCES)('counts a $source call in its own row and in the run total', ({ source, event }) => {
    expect(tally([event])).toMatchObject({
      calls: 1,
      in: 100,
      out: 10,
      cached: 40,
      ms: 7,
      sources: { [source]: { calls: 1, in: 100, out: 10, cached: 40, ms: 7, errors: 0, model: 'm' } },
    });
  });

  it('counts a call without a source as the harness', () => {
    expect(Object.keys(tally([usage()]).sources)).toEqual(['harness']);
  });

  it('counts a failed call against its source, not as a run error', () => {
    const total = tally([usage({ source: 'decider', error: true, inputTokens: 0, outputTokens: 0 })]);
    expect([total.calls, total.errors, total.sources.decider?.errors]).toEqual([1, 0, 1]);
  });

  it("keeps bothub's own costs when the harness reports its total at the end", () => {
    const total = tally([
      usage({ costUsd: 0.1 }),
      usage({ source: 'summarizer', costUsd: 0.02 }),
      { type: 'end', ok: true, costUsd: 0.5 },
    ]);
    expect([total.usd, total.sources.harness?.usd, total.sources.summarizer?.usd]).toEqual([0.52, 0.5, 0.02]);
  });
});

describe('roll-up', () => {
  const attempt: AgentEvent[] = [usage(), usage({ source: 'recall', model: 'tev1:0.8b', direct: true, ms: 30 })];
  const check: AgentEvent[] = [usage({ inputTokens: 50 }), usage({ source: 'decide-check', model: 'tev1:0.8b' })];
  const nextDay: AgentEvent[] = [usage({ source: 'summarizer', model: 'small', outputTokens: 3 })];

  it('sums runs into one total with the same split by source', () => {
    expect(sum([tally(attempt), tally(check), tally(nextDay)])).toMatchObject({
      calls: 5,
      in: 450,
      out: 43,
      ms: 30,
      sources: {
        harness: { calls: 2, in: 150, out: 20 },
        recall: { calls: 1, in: 100, ms: 30, model: 'tev1:0.8b' },
        'decide-check': { calls: 1 },
        summarizer: { calls: 1, out: 3, model: 'small' },
      },
    });
  });

  it('leaves the tallies it sums untouched', () => {
    const one = tally(attempt);
    sum([one, one]);
    expect(one.sources.harness?.calls).toBe(1);
  });
});

describe('metered calls', () => {
  it('times a call and reports the tokens it read', async () => {
    const seen: Usage[] = [];
    const value = await meter(
      'm',
      u => seen.push(u),
      async () => ({ value: 'ok', tokens: { inputTokens: 5 } })
    );
    expect(value).toBe('ok');
    expect(seen).toEqual([{ type: 'usage', inputTokens: 5, outputTokens: 0, model: 'm', ms: expect.any(Number) }]);
  });

  it('reports a call that throws as failed and rethrows', async () => {
    const seen: Usage[] = [];
    const failing = meter(
      'm',
      u => seen.push(u),
      async () => Promise.reject(new Error('down'))
    );
    await expect(failing).rejects.toThrow('down');
    expect(seen).toEqual([
      { type: 'usage', inputTokens: 0, outputTokens: 0, model: 'm', ms: expect.any(Number), error: true },
    ]);
  });

  it('reads chat usage and the proxy cost header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            choices: [{ message: { content: ' line ' } }],
            usage: {
              prompt_tokens: 300,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 200 },
              completion_tokens_details: { reasoning_tokens: 4 },
            },
          },
          { headers: { 'x-litellm-response-cost': '0.003' } }
        )
      )
    );
    const seen: Usage[] = [];
    expect(await complete({ url: 'http://proxy/v1' }, 'small', 's', 'u', 64, u => seen.push(u))).toBe('line');
    expect(seen).toEqual([
      {
        type: 'usage',
        inputTokens: 300,
        outputTokens: 20,
        cachedInputTokens: 200,
        reasoningTokens: 4,
        costUsd: 0.003,
        model: 'small',
        ms: expect.any(Number),
      },
    ]);
  });

  it("reads the decision API's usage and marks the call direct", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          answers: { ok: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 107, output_tokens: 0 },
          prompt_eval_cached_count: 64,
        })
      )
    );
    const seen: Usage[] = [];
    await decide({
      model: 'tev1:0.8b',
      state: 's',
      questions: { ok: { type: 'noul', instructions: 'ok?' } },
      onUsage: u => seen.push(u),
    });
    expect(seen).toEqual([
      {
        type: 'usage',
        inputTokens: 107,
        outputTokens: 0,
        cachedInputTokens: 64,
        model: 'tev1:0.8b',
        ms: expect.any(Number),
        direct: true,
      },
    ]);
  });

  it('reports a decide check whose model is down as a failed call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('refused')))
    );
    const seen: Usage[] = [];
    const verdict = await decideCheck('Fine?', 'x', {}, 0.5, u => seen.push(u));
    expect(verdict.pass).toBe(false);
    expect(seen).toMatchObject([{ inputTokens: 0, error: true, direct: true, model: 'tev1:0.8b' }]);
  });
});

describe('events added after a session', () => {
  it('numbers added events on from the last one, one append at a time', async () => {
    const store = openStore(await mkdtemp(join(tmpdir(), 'usage-')));
    const run = await store.create({ workflow: 'w', job: 'j', event: { id: 'e' } as never });
    await store.append(run.id, { ts: '', seq: 0, event: { type: 'end', ok: true } });
    await Promise.all([
      store.add(run.id, usage({ source: 'summarizer' })),
      store.add(run.id, usage({ source: 'summarizer' }), usage({ source: 'summarizer' })),
      store.add(run.id, usage({ source: 'decide-check' })),
    ]);
    const events = await store.events(run.id);
    expect(events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(tally(events.map(e => e.event)).sources).toMatchObject({
      summarizer: { calls: 3 },
      'decide-check': { calls: 1 },
    });
  });
});

describe('spend reconciliation', () => {
  const since = Date.parse('2026-10-14T00:00:00Z');
  const until = Date.parse('2026-10-14T12:00:00Z');
  const at = '2026-10-14T06:00:00.000Z';
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');
  const env = {
    BOTHUB_LLM_BASE_URL: 'http://proxy.test/v1',
    LITELLM_MASTER_KEY: 'sk-master',
    BOTHUB_LLM_API_KEY: 'sk-shared',
    BOTHUB_LLM_API_KEY_DOCS_EDITOR: 'sk-docs',
  };
  const log = (key: string, prompt: number, completion: number, startTime = at) => ({
    api_key: hash(key),
    startTime,
    prompt_tokens: prompt,
    completion_tokens: completion,
    spend: 0,
  });

  const recorded = async () => {
    const store = openStore(await mkdtemp(join(tmpdir(), 'spend-')));
    const runs = {
      'docs-editor': [
        usage(),
        usage({ source: 'summarizer', model: 'small', reasoningTokens: 5 }),
        usage({ source: 'recall', model: 'tev1:0.8b', direct: true }),
        usage({ source: 'decide-check', model: 'luna' }),
      ],
      reviewer: [usage({ inputTokens: 40 })],
    };
    for (const [bot, events] of Object.entries(runs)) {
      const run = await store.create({ workflow: 'w', job: 'j', bot, event: { id: bot } as never, startedAt: at });
      await Promise.all(events.map((event, seq) => store.append(run.id, { ts: at, seq, event })));
      await store.append(run.id, { ts: '2026-10-13T06:00:00.000Z', seq: events.length, event: usage() });
    }
    return store;
  };

  it("compares bothub's calls per key with the proxy's logs and lists direct calls apart", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json([
        log('sk-docs', 100, 10),
        log('sk-docs', 100, 15),
        log('sk-docs', 700, 30),
        log('sk-shared', 100, 10),
        log('sk-shared', 40, 10),
        log('sk-master', 9, 1),
        log('sk-docs', 5, 5, '2026-10-15T06:00:00.000000Z'),
      ])
    );
    const spend = await compareSpend({ store: await recorded(), env, since, until, fetcher: fetcher as never });
    expect(spend).toEqual({
      since: '2026-10-14T00:00:00.000Z',
      until: '2026-10-14T12:00:00.000Z',
      keys: [
        {
          key: 'docs-editor',
          bothub: { calls: 2, in: 200, out: 25, usd: 0 },
          proxy: { calls: 3, in: 900, out: 55, usd: 0 },
          missing: { calls: 1, in: 700, out: 30, usd: 0 },
        },
        {
          key: 'shared',
          bothub: { calls: 2, in: 140, out: 20, usd: 0 },
          proxy: { calls: 2, in: 140, out: 20, usd: 0 },
          missing: { calls: 0, in: 0, out: 0, usd: 0 },
        },
      ],
      direct: { 'docs-editor': { calls: 1, in: 100, out: 10, usd: 0 } },
      other: { calls: 1, in: 9, out: 1, usd: 0 },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://proxy.test/spend/logs?start_date=2026-10-14&end_date=2026-10-15&summarize=false');
    expect(init?.headers).toEqual({ authorization: 'Bearer sk-master' });
  });

  const MISCONFIGURED = [
    {
      name: 'no proxy URL',
      env: { LITELLM_MASTER_KEY: 'k' },
      error: 'needs BOTHUB_LLM_BASE_URL and LITELLM_MASTER_KEY',
    },
    { name: 'no master key', env: { BOTHUB_LLM_BASE_URL: 'http://p' }, error: 'needs BOTHUB_LLM_BASE_URL' },
  ];

  it.each(MISCONFIGURED)('refuses to compare with $name', async ({ env: partial, error }) => {
    await expect(compareSpend({ store: await recorded(), env: partial, since, until })).rejects.toThrow(error);
  });

  it('says when the proxy refuses the master key', async () => {
    const fetcher = async () => new Response('no', { status: 401 });
    await expect(
      compareSpend({ store: await recorded(), env, since, until, fetcher: fetcher as never })
    ).rejects.toThrow('spend logs: 401: no');
  });
});
