import { markLoaded, report } from './opencode-surfacer.ts';

const urlOf = (input: Parameters<typeof fetch>[0]) => (input instanceof Request ? input.url : String(input));

/**
 * opencode server plugin: reports the model that answered each of the agent's model calls as a `start` event, whenever
 * it changes. The model proxy names it in `x-litellm-model-group`, which differs from `alias` after a fallback; a
 * response without it was answered by `alias`.
 */
export const watcher = async (_input: unknown, raw?: Record<string, unknown>) => {
  const { alias } = raw as { alias: string };
  await markLoaded(watcherId);
  const send = globalThis.fetch;
  let last: string | undefined;
  globalThis.fetch = async (input, init) => {
    const response = await send(input, init);
    if (!new URL(urlOf(input)).pathname.endsWith('/responses')) return response;
    const model = response.headers.get('x-litellm-model-group') || alias;
    if (model !== last) report({ type: 'start', model: (last = model) });
    return response;
  };
  return {};
};

const watcherId = 'bothub-model';

export default { id: watcherId, server: watcher };
