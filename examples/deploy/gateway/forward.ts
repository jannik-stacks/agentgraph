const hopHeaders = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'];

export const forwardToGateway = async (request: Request, base: string, extra = '{}', send = fetch) => {
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
  });
};
