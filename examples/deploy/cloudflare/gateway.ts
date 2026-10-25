export const networks = ['none', 'models', 'egress', 'open'] as const;
export type Network = (typeof networks)[number];

export const forwardToGateway = (request: Request, base: string, extra = '{}', send = fetch) => {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete('host');
  for (const [name, value] of Object.entries(JSON.parse(extra || '{}') as Record<string, string>))
    if (value) headers.set(name, value);
    else headers.delete(name);
  return send(base.replace(/\/$/, '') + url.pathname.replace(/^\/v1(?=\/|$)/, '') + url.search, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });
};

export const reachOf = (running: Map<Network, number>, egress: RegExp[], host: string) => {
  const on = (network: Network) => (running.get(network) ?? 0) > 0;
  if (host === 'gateway.internal') return on('models') || on('egress') || on('open') ? 'gateway' : 'none';
  if (on('open') || (on('egress') && egress.some(pattern => pattern.test(host)))) return 'pass';
  return 'none';
};
