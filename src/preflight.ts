import type { Config } from './config.ts';
import { keyVariable, secretsFor } from './pipeline/prompt.ts';

/**
 * Whether error text says the model endpoint refused the key. A bare HTTP 401 or 403 counts only when `early`, the
 * run having died before its bot did anything, since the tools a bot runs meet those too.
 */
export const authFailure = (text = '', early = true) =>
  /authentication error|malformed api key|invalid api key|incorrect api key/i.test(text) ||
  (early && /\b(?:http|status|code)[ :]*40[13]\b/i.test(text));

/**
 * One authenticated `GET <base>/models` per distinct endpoint and key the hub's bots use. Resolves to a line for each
 * pair the endpoint refuses, naming the bots, their models and the environment variable; never the key. Bots on the
 * `claude` harness and unreachable endpoints are skipped.
 */
export const preflight = async (
  config: Config,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch
) => {
  const groups = new Map<string, { url: string; key: string; variable: string; bots: string[] }>();
  for (const bot of Object.values(config.bots)) {
    if (bot.harness === 'claude') continue;
    const { BOTHUB_LLM_BASE_URL: url, BOTHUB_LLM_API_KEY: key } = secretsFor(bot, env);
    if (!url) continue;
    const variable = keyVariable(bot, env);
    const group = groups.get(`${url} ${key}`) ?? { url, key: key ?? '', variable, bots: [] };
    group.bots.push(`${bot.name}${bot.model ? ` (${bot.model})` : ''}`);
    groups.set(`${url} ${key}`, group);
  }
  const refused = await Promise.all(
    [...groups.values()].map(async ({ url, key, variable, bots }) => {
      const response = await fetcher(`${url.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      if (!response || response.status < 400) return;
      if (response.status === 401 || response.status === 403 || authFailure(await response.text().catch(() => '')))
        return `${bots.join(', ')}: ${url} refused the key from ${variable} (HTTP ${response.status})`;
    })
  );
  return refused.filter(line => line !== undefined);
};
