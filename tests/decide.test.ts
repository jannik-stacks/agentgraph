import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, chatAnswers, decide, decideCheck, viaChat, type Question } from '../src/decide.ts';

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
    await expect(decide({ model: 'm:1b', state: 's', questions: {} })).rejects.toThrow(/1 to 64 questions/);
    await expect(
      decide({ model: 'm:1b', state: 's', questions: { s: { type: 'score', instructions: 'x', criteria: ['one'] } } })
    ).rejects.toThrow(/invalid request/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports server errors with their message', async () => {
    stub(reply(404, { error: 'model "nope" not found, try pulling it first' }));
    await expect(
      decide({ model: 'nope:1b', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    ).rejects.toThrow('decide: 404: model "nope" not found');
  });

  it('rejects responses missing an answer or of the wrong shape', async () => {
    stub(reply(200, { answers: { q: { type: 'score', score: 1, legend: {}, probabilities: {}, confidence: 1 } } }));
    await expect(
      decide({ model: 'm:1b', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    ).rejects.toThrow('no noul answer for "q"');
    stub(reply(200, { answers: { q: { type: 'noul' } } }));
    await expect(
      decide({ model: 'm:1b', state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
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
      decide({ model: 'm:1b', state: 's', timeoutMs: 5, questions: { q: { type: 'noul', instructions: 'x' } } })
    ).rejects.toThrow('timed out after 5 ms');
  });
});

describe('decideCheck', () => {
  const env = { BOTHUB_DECIDE_URL: 'http://ollama:11434', BOTHUB_DECIDE_MODEL: 'tev1:0.8b' };

  it('passes at or above the threshold and reports the probability of yes', async () => {
    const fetch = stub(reply(200, { answers: { answer: { type: 'noul', noul: 0.5 } } }));
    expect(await decideCheck('Is the code fine?', 'src/a.ts\nexport const a = 1;', env, 0.5)).toEqual({
      pass: true,
      findings: 'Probability of yes 0.500, threshold 0.5. Is the code fine?',
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

  it('only records the probability without a threshold', async () => {
    stub(reply(200, { answers: { answer: { type: 'noul', noul: 0.1 } } }));
    expect(await decideCheck('Fine?', 'x', env)).toEqual({
      pass: true,
      findings: 'Probability of yes 0.100, no threshold. Fine?',
    });
  });

  it("keeps the head and tail of a long state, to fit the model's context", async () => {
    const fetch = stub(reply(200, { answers: { answer: { type: 'noul', noul: 1 } } }));
    await decideCheck('q', `${'a'.repeat(10_000)}${'z'.repeat(10_000)}`, env);
    expect(sent(fetch).state).toBe(`${'a'.repeat(2000)}\n[…]\n${'z'.repeat(2000)}`);
  });

  it('is blocked when no answer comes', async () => {
    stub(reply(500, { error: 'boom' }));
    expect(await decideCheck('q', 'x', env)).toEqual({ pass: false, findings: 'decide: 500: boom', blocked: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    );
    expect(await decideCheck('q', 'x', env)).toMatchObject({ pass: false, blocked: true });
    stub(reply(200, { answers: {} }));
    expect(await decideCheck('q', 'x', env)).toMatchObject({ pass: false, blocked: true });
  });

  it('fails when the call is rejected', async () => {
    stub(reply(404, { error: 'model not found' }));
    expect(await decideCheck('q', 'x', env)).toEqual({ pass: false, findings: 'decide: 404: model not found' });
  });
});

const chat = (content: string) => reply(200, { choices: [{ message: { content } }] });

const llm = { url: 'http://litellm:4000/v1', apiKey: 'sk-bh-implementor' };

const MODELS = [
  { model: 'tev1:0.8b', chat: false },
  { model: 'qwen3.5:4b', chat: false },
  { model: 'luna', chat: true },
  { model: 'local', chat: true },
];

const CHAT_REPLIES = [
  { name: 'a bare object', reply: '{"c0": 0.9, "c1": 0.1}', answers: { c0: 0.9, c1: 0.1 } },
  { name: 'a fenced object', reply: '```json\n{"c0": 1}\n```', answers: { c0: 1 } },
  {
    name: 'words and booleans',
    reply: '{"a": "yes", "b": "no", "c": true, "d": false}',
    answers: { a: 1, b: 0, c: 1, d: 0 },
  },
  { name: 'numeric strings', reply: '{"a": "0.25"}', answers: { a: 0.25 } },
  { name: 'out-of-range numbers, clamped', reply: '{"a": 3, "b": -1}', answers: { a: 1, b: 0 } },
  { name: 'unreadable values, left out', reply: '{"a": "maybe", "b": null, "c": "", "d": 0.5}', answers: { d: 0.5 } },
  { name: 'reasoning before the object', reply: 'It says {x}, so no.\n{"a": 0.1}', answers: { a: 0.1 } },
  { name: 'the last of several objects', reply: '{"a": 0.9} On reflection: {"a": 0.2}', answers: { a: 0.2 } },
  { name: 'no object', reply: 'Yes.', answers: {} },
  { name: 'broken JSON', reply: '{"a": 0.5', answers: {} },
  { name: 'an array', reply: '[0.5]', answers: {} },
];

const CHAT_FAILURES = [
  {
    name: 'no chat endpoint',
    llm: undefined,
    content: '{}',
    questions: { q: { type: 'noul', instructions: 'x' } },
    error: 'decide: luna is a chat model and BOTHUB_LLM_BASE_URL is not set',
  },
  {
    name: 'a question that is not noul',
    llm,
    content: '{}',
    questions: { s: { type: 'score', instructions: 'x', criteria: ['low', 'high'] } },
    error: 'decide: luna answers only noul questions, "s" is score',
  },
  {
    name: 'an answer missing from the reply',
    llm,
    content: '{"a": 0.9}',
    questions: { a: { type: 'noul', instructions: 'x' }, b: { type: 'noul', instructions: 'y' } },
    error: 'decide: no noul answer for "b"',
  },
] satisfies { llm: typeof llm | undefined; questions: Record<string, Question>; [key: string]: unknown }[];

describe('decide through a chat model', () => {
  it.each(MODELS)('sends $model to the chat endpoint: $chat', ({ model, chat }) => {
    expect(viaChat(model)).toBe(chat);
  });

  it.each(CHAT_REPLIES)('reads $name', ({ reply, answers }) => {
    expect(chatAnswers(reply)).toEqual(answers);
  });

  it('asks the chat endpoint with the key and returns noul answers', async () => {
    const fetch = stub(chat('{"ok": 0.8}'));
    const answers = await decide({
      llm,
      model: 'luna',
      state: 'The sky is blue.',
      questions: { ok: { type: 'noul', instructions: 'Is it blue?' } },
    });
    expect(answers).toEqual({ ok: { type: 'noul', noul: 0.8 } });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://litellm:4000/v1/chat/completions');
    expect(fetch.mock.calls[0]?.[1].headers).toMatchObject({ authorization: 'Bearer sk-bh-implementor' });
    expect(sent(fetch)).toMatchObject({ model: 'luna' });
    expect(sent(fetch).messages[1].content).toBe('<state>\nThe sky is blue.\n</state>\n\nQuestions:\nok: Is it blue?');
  });

  it.each(CHAT_FAILURES)('rejects $name', async ({ llm, content, questions, error }) => {
    stub(chat(content));
    await expect(decide({ llm, model: 'luna', state: 's', questions })).rejects.toThrow(error);
  });

  it('leaves an unanswered question out of ask, where decide rejects it', async () => {
    stub(chat('{"a": 0.9}'));
    const questions = { a: { type: 'noul', instructions: 'x' }, b: { type: 'noul', instructions: 'y' } } as const;
    expect(await ask({ llm, model: 'luna', state: 's', questions })).toEqual({ a: { type: 'noul', noul: 0.9 } });
  });

  it('runs a decide check on the chat model the env names', async () => {
    const fetch = stub(chat('{"answer": 0.9}'));
    const env = { BOTHUB_DECIDE_MODEL: 'luna', BOTHUB_LLM_BASE_URL: llm.url, BOTHUB_LLM_API_KEY: llm.apiKey };
    expect(await decideCheck('Fine?', 'x', env)).toEqual({
      pass: true,
      findings: 'Probability of yes 0.900, no threshold. Fine?',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://litellm:4000/v1/chat/completions');
  });

  const env = { BOTHUB_DECIDE_MODEL: 'luna', BOTHUB_LLM_BASE_URL: llm.url };

  it.each([
    { name: 'an unreadable reply', fetch: chat('Probably yes.'), blocked: true },
    { name: 'a server error', fetch: reply(503, {}), blocked: true },
    { name: 'a rejected key', fetch: reply(401, {}), blocked: undefined },
  ])('marks a decide check on $name blocked: $blocked', async ({ fetch, blocked }) => {
    stub(fetch);
    const verdict = await decideCheck('Fine?', 'x', env);
    expect(verdict.pass).toBe(false);
    expect(verdict.blocked).toBe(blocked);
  });
});
