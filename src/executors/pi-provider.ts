type Pi = { registerProvider: (name: string, config: Record<string, unknown>) => void };

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** pi extension: one OpenAI-compatible provider whose endpoint, key and model come from the environment. */
export default (pi: Pi) => {
  const id = process.env.BOTHUB_LLM_MODEL ?? 'default';
  pi.registerProvider('bothub', {
    baseUrl: process.env.BOTHUB_LLM_BASE_URL,
    apiKey: '$BOTHUB_LLM_API_KEY',
    api: 'openai-completions',
    models: [
      { id, name: id, reasoning: false, input: ['text'], cost: free, contextWindow: 200_000, maxTokens: 32_000 },
    ],
  });
};
