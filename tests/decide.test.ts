import { afterEach, describe, expect, it, vi } from 'vitest';
import { addedLines, Decide, decide, decideCheck } from '../src/decide.ts';

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

describe('addedLines', () => {
  it('keeps added lines under their file names', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b.md b/b.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.md',
      '@@ -0,0 +1,2 @@',
      '+# Title',
      '+',
      '+Text',
    ].join('\n');
    expect(addedLines(diff)).toBe('a.ts\nnew\n\nb.md\n# Title\n\nText');
  });
});

describe('decideCheck', () => {
  const check = (decide: Parameters<typeof decideCheck>[0]['decide']) => ({
    name: 'commit-style',
    mode: 'block' as const,
    decide,
  });
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1,2 @@',
    ' const keep = 0;',
    '-const old = 1;',
    '+export const a = 1;',
    '',
  ].join('\n');
  const inputs = { files: ['src/a.ts'], diff };
  const env = { BOTHUB_DECIDE_URL: 'http://ollama:11434', BOTHUB_DECIDE_MODEL: 'tev1:0.8b' };

  it('passes at or above the threshold and reports the probability', async () => {
    const fetch = stub(reply(200, { answers: { answer: { type: 'noul', noul: 0.5 } } }));
    const verdict = await decideCheck(check({ question: 'Is the code fine?' }), inputs, env);
    expect(verdict).toEqual({
      check: 'commit-style',
      gating: true,
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
    const verdict = await decideCheck(check({ question: 'Fine?', threshold: 0.8 }), inputs, env);
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toContain('0.700');
  });

  it('passes on the probability of no for pass-on: no', async () => {
    stub(reply(200, { answers: { answer: { type: 'noul', noul: 0.2 } } }));
    const verdict = await decideCheck(check({ question: 'Does it contain a date?', 'pass-on': 'no' }), inputs, env);
    expect(verdict).toMatchObject({
      pass: true,
      findings: 'Does it contain a date? Probability of no 0.800, threshold 0.5.',
    });
  });

  it('sends the full diff, the file names or the event text as `over` says', async () => {
    const fetch = stub(reply(200, { answers: { answer: { type: 'noul', noul: 1 } } }));
    await decideCheck(check({ question: 'q', over: 'diff' }), inputs, env);
    expect(sent(fetch).state).toBe(diff);
    fetch.mockClear();
    await decideCheck(check({ question: 'q', over: 'files' }), inputs, env);
    expect(sent(fetch).state).toBe('src/a.ts');
    fetch.mockClear();
    const event = {
      id: 'e',
      ts: '2026-10-12T00:00:00.000Z',
      source: 'local' as const,
      trigger: 'issue_comment' as const,
      repo: 'acme/app',
      actor: { login: 'morgan', association: 'OWNER' as const },
      body: '/bothub fix it',
    };
    await decideCheck(check({ question: 'q', over: 'event' }), { files: [], diff: '', event }, env);
    expect(sent(fetch).state).toBe('/bothub fix it');
  });

  it('skips without anything to look at and fails closed when the model is unreachable', async () => {
    const fetch = stub(reply(500, { error: 'boom' }));
    expect(await decideCheck(check({ question: 'q' }), { files: [], diff: '' }, env)).toMatchObject({
      pass: false,
      skipped: true,
      findings: 'no changed files',
    });
    expect(await decideCheck(check({ question: 'q', over: 'event' }), { files: [], diff: '' }, env)).toMatchObject({
      pass: false,
      skipped: true,
      findings: 'the event has no text',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await decideCheck(check({ question: 'q' }), inputs, env)).toMatchObject({
      pass: false,
      findings: 'decide: 500: boom',
    });
  });

  it('parses the check field with defaults', () => {
    expect(Decide.parse({ question: 'q' })).toEqual({ question: 'q', 'pass-on': 'yes', threshold: 0.5, over: 'added' });
    expect(() => Decide.parse({ question: 'q', threshold: 2 })).toThrow();
  });
});
