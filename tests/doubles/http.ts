import { request } from 'node:http';

export const readLocalHttp: typeof fetch = async (input, init) => {
  const outgoing = new Request(input, init);
  const url = new URL(outgoing.url);
  const headers = new Headers(outgoing.headers);
  if (!headers.has('host')) headers.set('host', url.host);
  url.hostname = '127.0.0.1';
  const body = Buffer.from(await outgoing.arrayBuffer());
  return new Promise((resolve, reject) => {
    const pending = request(
      url,
      { method: outgoing.method, headers: Object.fromEntries(headers), signal: outgoing.signal },
      incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode!,
              headers: Object.fromEntries(
                Object.entries(incoming.headers).flatMap(([key, value]) =>
                  value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value]]
                )
              ),
            })
          )
        );
      }
    );
    pending.once('error', reject);
    pending.end(body);
  });
};
