import { type ChildProcess, spawn } from 'node:child_process';
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
  const faults = { pulls: 0 };
  const children = new Map<string, ChildProcess>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://box');
    const [id = '', op = ''] = url.pathname.slice(1).split('/');
    const root = join(dir, id);
    if (request.method === 'DELETE') {
      rmSync(root, { recursive: true, force: true });
      return response.end();
    }
    const fresh = !existsSync(root);
    if (fresh) response.setHeader('agentgraph-box-fresh', '1');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const body = await read(request);
    const env = { ...process.env, AGENTGRAPH_BOX_ROOT: root };
    if (op === 'stop') {
      const child = children.get(url.searchParams.get('arg') ?? '');
      if (child?.exitCode === null) {
        const exited = new Promise(resolve => child.once('close', resolve));
        process.kill(-child.pid!, 'SIGKILL');
        await exited;
      }
      return response.end();
    }
    if (op === 'run') {
      if (fresh) return response.end();
      const sent = JSON.parse(body.toString('utf8')) as { argv: string[]; secrets: Record<string, string> };
      const [minutes = '1', ...argv] = sent.argv;
      runs.push({ id, network: url.searchParams.get('network') ?? '', argv });
      const child = spawn(
        'sh',
        [script, 'run', minutes, ...argv.map(arg => arg.replace(/^(\w+=)(\/(homes|hub)(\/.*)?)$/s, `$1${root}$2`))],
        {
          env: { ...env, ...sent.secrets },
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
      children.set(url.searchParams.get('id') ?? '', child);
      child.on('close', code =>
        response.end(frame ? `${last === 10 ? '' : '\n'}\u0000agentgraph-exit ${code ?? 137}\n` : '')
      );
      return;
    }
    if (op === 'pull' && faults.pulls > 0) {
      faults.pulls--;
      response.statusCode = 503;
      return response.end('unreachable');
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
    faults,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};
