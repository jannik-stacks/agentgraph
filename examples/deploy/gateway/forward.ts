const hopHeaders = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'];

const fail = (reason: string) => new Response(`gateway: ${reason}\n`, { status: 502 });

const relay = async (request: Request, base: string, extra: string, send: typeof fetch) => {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of hopHeaders) headers.delete(name);
  for (const [name, value] of Object.entries(JSON.parse(extra || '{}') as Record<string, string>))
    if (value) headers.set(name, value);
    else headers.delete(name);
  return send(base.replace(/\/$/, '') + url.pathname + url.search, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer(),
    redirect: 'manual',
    signal: request.signal,
  });
};

export const forwardToGateway = (request: Request, base: string | undefined, extra = '{}', send = fetch) =>
  base ? relay(request, base, extra, send).catch(() => fail('request failed')) : fail('GATEWAY_URL is not set');
