import { afterEach, describe, expect, it, vi } from 'vitest';
import { decide, decideCheck } from '../src/decide.ts';

const reply = (status: number, body: unknown) =>
  vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));

const stub = (fetch: ReturnType<typeof reply>) => {
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

const sent = (fetch: ReturnType<typeof reply>) =>
  JSON.parse(String(fetch.mock.calls[0]?.[1].body)) as Record<string, any>;

afterEach(() => vi.unstubAllGlobals());

describe('decide', () => {
  it('posts the request and returns typed answers', async () => {
    const fetch = stub(
      reply(200, {
        model: 'tev1:0.8b',
        answers: {
          ok: { type: 'noul', noul: 0.9 },
          color: { type: 'choice', choice: 'blue', probabilities: { blue: 0.9, red: 0.1 }, confidence: 0.8 },
          heat: {
            type: 'score',
            score: 1.6,
            legend: { 0: 'cold', 1: 'mild', 2: 'hot' },
            probabilities: {},
            confidence: 0.5,
          },
        },
      })
    );
    const answers = await decide({
      url: 'http://ollama:11434/',
      model: 'tev1:0.8b',
      state: 'The sky is blue.',
      questions: {
        ok: { type: 'noul', instructions: 'Is it blue?' },
        color: { type: 'choice', instructions: 'Which color?', criteria: { blue: null, red: 'reddish' } },
        heat: { type: 'score', instructions: 'How hot?', criteria: ['cold', 'mild', 'hot'] },
      },
    });
    expect(answers.ok.noul).toBe(0.9);
    expect(answers.color.choice).toBe('blue');
    expect(answers.heat.score).toBe(1.6);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://ollama:11434/v1/systemone');
    expect(sent(fetch)).toMatchObject({ model: 'tev1:0.8b', state: 'The sky is blue.' });
  });

  it('rejects invalid requests before sending', async () => {
    const fetch = stub(reply(200, {}));
    await expect(decide({ model: 'm', state: 's', questions: {} })).rejects.toThrow(/1 to 64 questions/);
    await expect(
      decide({ model: 'm', state: 's', questions: { s: { type: 'score', instructions: 'x', criteria: ['one'] } } })
    ).rejects.toThrow(/invalid request/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports server errors with their message', async () => {
    stub(reply(404, { error: 'model "nope" not found, try pulling it first' }));
    await expect(
      decide({ model: 'nope', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    ).rejects.toThrow('decide: 404: model "nope" not found');
  });

  it('rejects responses missing an answer or of the wrong shape', async () => {
    stub(reply(200, { answers: { q: { type: 'score', score: 1, legend: {}, probabilities: {}, confidence: 1 } } }));
    await expect(
      decide({ model: 'm', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    ).rejects.toThrow('no noul answer for "q"');
    stub(reply(200, { answers: { q: { type: 'noul' } } }));
    await expect(
      decide({ model: 'm', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    ).rejects.toThrow(/unexpected response/);
  });

  it('names timeouts and unreachable servers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      })
    );
    await expect(
      decide({ model: 'm', state: 's', timeoutMs: 5, questions: { q: { type: 'noul', instructions: 'x' } } })
    ).rejects.toThrow('timed out after 5 ms');
  });
});

describe('decideCheck', () => {
  const env = { BOTHUB_DECIDE_URL: 'http://ollama:11434', BOTHUB_DECIDE_MODEL: 'tev1:0.8b' };

  it('passes at or above the threshold and reports the probability of yes', async () => {
    const fetch = stub(reply(200, { answers: { answer: { type: 'noul', noul: 0.5 } } }));
    expect(await decideCheck('Is the code fine?', 'src/a.ts\nexport const a = 1;', env)).toEqual({
      pass: true,
      findings: 'Is the code fine? Probability of yes 0.500, threshold 0.5.',
    });
    const body = sent(fetch);
    expect(body.model).toBe('tev1:0.8b');
    expect(body.questions).toEqual({ answer: { type: 'noul', instructions: 'Is the code fine?' } });
    expect(body.state).toBe('src/a.ts\nexport const a = 1;');
  });

  it('fails below the threshold', async () => {
    stub(reply(200, { answers: { answer: { type: 'noul', noul: 0.7 } } }));
    const verdict = await decideCheck('Fine?', 'x', env, 0.8);
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toContain('0.700');
  });

  it('clips a long state', async () => {
    const fetch = stub(reply(200, { answers: { answer: { type: 'noul', noul: 1 } } }));
    await decideCheck('q', 'x'.repeat(20_000), env);
    expect(sent(fetch).state).toMatch(/\[truncated\]$/);
  });

  it('fails closed when the model is unreachable', async () => {
    stub(reply(500, { error: 'boom' }));
    expect(await decideCheck('q', 'x', env)).toEqual({ pass: false, findings: 'decide: 500: boom' });
  });
});
