import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { forwardToGateway } from './forward.ts';

const decoded = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
const maxBody = 32 * 1024 * 1024;

const readRequest = async (message: IncomingMessage, signal: AbortSignal) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    size += (chunk as Buffer).length;
    if (size <= maxBody) chunks.push(chunk as Buffer);
  }
  if (size > maxBody) return undefined;
  const method = message.method ?? 'GET';
  const headers = Object.entries(message.headers).flatMap(([name, value]): [string, string][] =>
    value === undefined ? [] : [[name, String(value)]]
  );
  const body = ['GET', 'HEAD'].includes(method) ? null : Buffer.concat(chunks);
  return new Request(`http://gateway${message.url ?? '/'}`, { method, headers, body, signal });
};

export const startGateway = (env: Record<string, string | undefined>, port = 4000, send = fetch) =>
  createServer(async (message, response) => {
    const gone = new AbortController();
    response.on('close', () => gone.abort());
    try {
      const request = await readRequest(message, gone.signal);
      if (!request) return void response.writeHead(413).end('gateway: request too large\n');
      const answer = await forwardToGateway(request, env.GATEWAY_URL, env.GATEWAY_HEADERS, send);
      const headers = [...answer.headers].filter(([name]) => !decoded.has(name));
      response.writeHead(answer.status, Object.fromEntries(headers));
      if (answer.body) for await (const chunk of answer.body) response.write(chunk);
      response.end();
    } catch {
      if (response.headersSent) return void response.destroy();
      response.writeHead(502).end('gateway: request failed\n');
    }
  }).listen(port);

if (process.argv[1] === fileURLToPath(import.meta.url)) startGateway(process.env, Number(process.env.PORT ?? 4000));
