import { markLoaded } from './opencode-surfacer.ts';

/** Most characters of a `read` or `grep` result the model sees. */
export const limit = 8192;

/** The result cut at a line end within `limit`, with a note on how to narrow the call; short results pass unchanged. */
export const trim = (output: string) => {
  if (output.length <= limit) return output;
  const head = output.slice(0, limit);
  const kept = head.slice(0, head.lastIndexOf('\n') + 1 || limit);
  return `${kept}\n[bothub] Output cut at ${kept.length} of ${output.length} characters. Narrow the call: a tighter grep pattern or path, or read with offset and limit.`;
};

/** opencode server plugin: keeps `read` and `grep` output small, since every later turn carries it again. */
export const trimmer = async () => {
  await markLoaded(trimmerId);
  return {
    'tool.execute.after': async ({ tool }: { tool: string }, result: { output: string }) => {
      if (tool === 'read' || tool === 'grep') result.output = trim(result.output);
    },
  };
};

const trimmerId = 'bothub-trim';

export default { id: trimmerId, server: trimmer };
