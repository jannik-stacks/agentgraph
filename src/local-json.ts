const loopback = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Whether a request is addressed to a loopback host and, when it names one, comes from a loopback origin. */
export const isLocal = (req: Request) => {
  const url = new URL(req.url);
  if (!loopback.has(url.hostname)) return false;
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return loopback.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

const fail = (error: string, status: number) => ({ response: Response.json({ error }, { status }) });

/**
 * The JSON body of a request that writes, or the response refusing it: only from localhost, only with a JSON
 * content type, so a web page cannot send one as a simple request, and at most `maxBytes` long.
 */
export const localJson = async (
  req: Request,
  maxBytes = 2 * 1024 * 1024
): Promise<{ input: unknown } | { response: Response }> => {
  if (req.method !== 'POST') return fail('method not allowed', 405);
  if (!isLocal(req)) return fail('writes are only served on localhost', 403);
  if (!req.headers.get('content-type')?.startsWith('application/json')) return fail('expected a JSON body', 415);
  const text = await req.text();
  if (text.length > maxBytes) return fail('body too large', 413);
  try {
    return { input: JSON.parse(text) };
  } catch {
    return fail('body is not JSON', 400);
  }
};
