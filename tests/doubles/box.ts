import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../examples/deploy/cloudflare/box.sh', import.meta.url));

const read = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

export const startBoxServer = async (dir: string, { frame = true } = {}) => {
  const runs: { id: string; network: string; argv: string[] }[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://box');
    const [id = '', op = ''] = url.pathname.slice(1).split('/');
    const root = join(dir, id);
    if (request.method === 'DELETE') {
      rmSync(root, { recursive: true, force: true });
      return response.end();
    }
    if (!existsSync(root)) response.setHeader('agentgraph-box-fresh', '1');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const body = await read(request);
    const env = { ...process.env, AGENTGRAPH_BOX_ROOT: root };
    if (op === 'run') {
      const [minutes = '1', ...argv] = JSON.parse(body.toString('utf8')) as string[];
      runs.push({ id, network: url.searchParams.get('network') ?? '', argv });
      const child = spawn(
        'sh',
        [script, 'run', minutes, ...argv.map(arg => arg.replace(/^(\w+=)(\/(homes|hub)(\/.*)?)$/s, `$1${root}$2`))],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        }
      );
      response.flushHeaders();
      let last = 10;
      const out = (chunk: Buffer) => {
        last = chunk.at(-1) ?? last;
        response.write(chunk);
      };
      child.stdout.on('data', out);
      child.stderr.on('data', out);
      response.on('close', () => child.exitCode === null && process.kill(-child.pid!, 'SIGKILL'));
      child.on('close', code =>
        response.end(frame ? `${last === 10 ? '' : '\n'}\u0000agentgraph-exit ${code ?? 137}\n` : '')
      );
      return;
    }
    const child = spawn('sh', [script, op, ...url.searchParams.getAll('arg')], { env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.end(body);
    child.on('close', code => {
      response.statusCode = code === 0 ? 200 : 500;
      response.end(code === 0 ? Buffer.concat(out) : Buffer.concat([...out, ...err]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runs,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};
