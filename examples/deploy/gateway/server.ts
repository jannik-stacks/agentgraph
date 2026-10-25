import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { forwardToGateway } from './forward.ts';

const decoded = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const readRequest = async (message: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const method = message.method ?? 'GET';
  const headers = Object.entries(message.headers).flatMap(([name, value]): [string, string][] =>
    value === undefined ? [] : [[name, String(value)]]
  );
  const body = ['GET', 'HEAD'].includes(method) ? null : Buffer.concat(chunks);
  return new Request(`http://gateway${message.url ?? '/'}`, { method, headers, body });
};

export const startGateway = (env: Record<string, string | undefined>, port = 4000, send = fetch) =>
  createServer(async (message, response) => {
    try {
      if (!env.GATEWAY_URL) throw new Error('GATEWAY_URL is not set');
      const answer = await forwardToGateway(await readRequest(message), env.GATEWAY_URL, env.GATEWAY_HEADERS, send);
      const headers = [...answer.headers].filter(([name]) => !decoded.has(name));
      response.writeHead(answer.status, Object.fromEntries(headers));
      if (answer.body) for await (const chunk of answer.body) response.write(chunk);
      response.end();
    } catch (error) {
      if (response.headersSent) return void response.destroy();
      response.writeHead(502).end(`gateway: ${(error as Error).message}\n`);
    }
  }).listen(port);

if (process.argv[1] === fileURLToPath(import.meta.url)) startGateway(process.env, Number(process.env.PORT ?? 4000));
