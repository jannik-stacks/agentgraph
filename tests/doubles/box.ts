import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const runs: { id: string; run: string; network: string; argv: string[] }[] = [];
  const faults = { pulls: 0, stops: 0 };
  const events: string[] = [];
  const children = new Map<string, { box: string; child: ChildProcess }>();
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const exited = new Promise(resolve => child.once('close', resolve));
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
    return true;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://box');
    const [id = '', op = ''] = url.pathname.slice(1).split('/');
    const root = join(dir, id);
    if (request.method === 'DELETE') {
      await Promise.all([...children.values()].filter(c => c.box === id).map(c => stop(c.child)));
      rmSync(root, { recursive: true, force: true });
      return response.end();
    }
    const marker = join(root, 'tmp', 'started');
    const fresh = !existsSync(marker);
    if (fresh) response.setHeader('agentgraph-box-fresh', '1');
    mkdirSync(join(root, 'tmp'), { recursive: true });
    if (fresh) writeFileSync(marker, '');
    const body = await read(request);
    const env = { ...process.env, AGENTGRAPH_BOX_ROOT: root };
    if (op === 'stop' && faults.stops > 0) {
      faults.stops--;
      response.statusCode = 503;
      return response.end('unreachable');
    }
    if (op === 'stop') {
      const run = url.searchParams.get('arg') ?? '';
      const running = children.get(run);
      if (running && (await stop(running.child))) events.push(`stopped ${run}`);
      return response.end();
    }
    if (op === 'run') {
      if (fresh) return response.end();
      const sent = JSON.parse(body.toString('utf8')) as { argv: string[]; secrets: Record<string, string> };
      const [minutes = '1', ...argv] = sent.argv;
      runs.push({ id, run: url.searchParams.get('id') ?? '', network: url.searchParams.get('network') ?? '', argv });
      const child = spawn(
        'sh',
        [script, 'run', minutes, ...argv.map(arg => arg.replace(/^(\w+=)(\/(homes|graph)(\/.*)?)$/s, `$1${root}$2`))],
        {
          env: { ...env, ...sent.secrets, AGENTGRAPH_RUN: url.searchParams.get('id') ?? '' },
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
      children.set(url.searchParams.get('id') ?? '', { box: id, child });
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
    if (op === 'pull') events.push('pull');
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
    events,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};
