import { Container, ContainerProxy, type OutboundHandlerContext } from '@cloudflare/containers';
import allowlist from '../../../infra/local/egress/allowlist';
import boxScript from './box.sh';
import { forwardToGateway, type Network, networks, reachOf } from './gateway.ts';

export { ContainerProxy };

type Env = {
  ENGINE: DurableObjectNamespace<Engine>;
  BOX: DurableObjectNamespace<Box>;
  DATA: R2Bucket;
  GATEWAY_URL: string;
  GATEWAY_HEADERS?: string;
  AGENTGRAPH_REPO: string;
  AGENTGRAPH_APP_ID: string;
  AGENTGRAPH_APP_KEY: string;
  AGENTGRAPH_PROXY_KEYS: string;
};

const egress = allowlist
  .split('\n')
  .filter(Boolean)
  .map(line => new RegExp(line));

const frame = (code: number) => `\u0000agentgraph-exit ${code}\n`;

const gateway = (request: Request, env: Env) => forwardToGateway(request, env.GATEWAY_URL, env.GATEWAY_HEADERS);

const runBox = (request: Request, env: Env) => {
  const id = new URL(request.url).pathname.split('/')[1] ?? '';
  if (!/^[\w-]+$/.test(id)) return new Response('no box id', { status: 400 });
  return env.BOX.get(env.BOX.idFromName(id)).fetch(request);
};

const storeData = async (request: Request, env: Env) => {
  const key = new URL(request.url).pathname.slice(1);
  if (request.method === 'PUT') {
    const previous = await env.DATA.get(key);
    if (previous) await env.DATA.put(`${key}.previous`, previous.body);
    await env.DATA.put(key, request.body);
    return new Response(null, { status: 204 });
  }
  const object = await env.DATA.get(key);
  return object ? new Response(object.body) : new Response(null, { status: 404 });
};

const readKey = (request: Request, env: Env) => {
  const name = new URL(request.url).pathname.slice(1);
  if (name !== 'AGENTGRAPH_APP_KEY' && name !== 'AGENTGRAPH_PROXY_KEYS') return new Response(null, { status: 404 });
  return env[name] ? new Response(env[name]) : new Response(null, { status: 404 });
};

export class Engine extends Container<Env> {
  sleepAfter = '10m';
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'box.internal',
    'data.internal',
    'gateway.internal',
    'keys.internal',
  ];
  static {
    this.outboundByHost = {
      'box.internal': runBox,
      'data.internal': storeData,
      'gateway.internal': gateway,
      'keys.internal': readKey,
    };
  }

  async wake() {
    if (this.ctx.container?.running) return;
    await this.start({
      envVars: { AGENTGRAPH_REPO: this.env.AGENTGRAPH_REPO, AGENTGRAPH_APP_ID: this.env.AGENTGRAPH_APP_ID },
    });
  }

  override async onActivityExpired() {
    this.renewActivityTimeout();
  }
}

export class Box extends Container<Env> {
  sleepAfter = '30m';
  enableInternet = false;
  interceptHttps = true;
  entrypoint = ['sh', '-c', boxScript, 'box', 'start'];
  running = new Map<Network, number>();
  requests = 0;
  stopped = new Set<string>();
  static {
    this.outbound = async (request: Request, env: Env, ctx: OutboundHandlerContext) => {
      const host = new URL(request.url).hostname;
      const reach = await env.BOX.get(env.BOX.idFromString(ctx.containerId)).reach(host);
      if (reach === 'gateway') return gateway(request, env);
      if (reach === 'pass') return fetch(request);
      return new Response(`agentgraph: ${host} is not reachable from this command\n`, { status: 403 });
    };
  }

  reach(host: string) {
    return reachOf(this.running, egress, host);
  }

  override async onActivityExpired() {
    if ([...this.running.values()].some(count => count > 0)) return this.renewActivityTimeout();
    if (!this.ctx.container?.running) return;
    const seen = this.requests;
    const dirty = await this.ctx.storage.get<string>('dirty');
    if (dirty && !(await this.keep(dirty).catch(() => false))) return this.renewActivityTimeout();
    if (this.requests !== seen) return this.renewActivityTimeout();
    await this.ctx.storage.delete('dirty');
    await this.destroy();
  }

  async keep(checkout: string) {
    const exec = (cmd: string[]) => this.ctx.container!.exec(cmd, { user: '0:0', stderr: 'ignore' });
    const packed = await (await exec(['sh', '-c', boxScript, 'box', 'keep'])).output();
    const size = Number(new TextDecoder().decode(packed.stdout));
    if (packed.exitCode !== 0 || !size) return false;
    const { readable, writable } = new FixedLengthStream(size);
    const cat = await exec(['cat', '/tmp/agentgraph-kept.tgz']);
    await Promise.all([
      this.env.DATA.put(`kept/${checkout}.tgz`, readable),
      (cat.stdout as ReadableStream<Uint8Array>).pipeTo(writable),
    ]);
    return true;
  }

  override async fetch(request: Request) {
    this.requests++;
    if (request.method === 'DELETE') {
      await this.ctx.storage.delete('dirty');
      if (this.ctx.container?.running) await this.destroy();
      return new Response(null, { status: 204 });
    }
    const url = new URL(request.url);
    const op = url.pathname.split('/')[2] ?? '';
    const fresh = !this.ctx.container?.running;
    if (fresh) await this.ctx.storage.delete('dirty');
    await this.start();
    this.renewActivityTimeout();
    const headers: HeadersInit = fresh ? { 'agentgraph-box-fresh': '1' } : {};
    if (op === 'run') {
      if (fresh) return new Response(null, { headers });
      const network = url.searchParams.get('network');
      if (!networks.includes(network as Network)) return new Response(`unknown network ${network}`, { status: 400 });
      const { argv, secrets } = (await request.json()) as { argv: string[]; secrets: Record<string, string> };
      await this.ctx.storage.put('dirty', url.pathname.split('/')[1] ?? '');
      return this.run(url.searchParams.get('id') ?? '', network as Network, argv, secrets, headers);
    }
    if (op === 'stop') {
      const id = url.searchParams.get('arg') ?? '';
      this.stopped.add(id);
      await this.reap(id);
      return new Response(null, { status: 204, headers });
    }
    if (!['init', 'push', 'pull', 'put'].includes(op)) return new Response(`unknown op ${op}`, { status: 404 });
    const child = await this.ctx.container!.exec(['sh', '-c', boxScript, 'box', op, ...url.searchParams.getAll('arg')], {
      user: op === 'init' || op === 'put' ? '0:0' : '1000:1000',
      ...(request.body && { stdin: request.body }),
      stderr: op === 'pull' ? 'ignore' : 'pipe',
    });
    if (op === 'pull') return new Response(child.stdout, { headers });
    const { exitCode, stdout, stderr } = await child.output();
    const text = new TextDecoder();
    return exitCode === 0
      ? new Response(null, { status: 204, headers })
      : new Response(text.decode(stdout) + text.decode(stderr), { status: 500 });
  }

  async reap(id: string) {
    const reaper = await this.ctx.container!.exec(['sh', '-c', boxScript, 'box', 'reap', id], { user: '0:0' });
    await reaper.exitCode;
  }

  async run(id: string, network: Network, argv: string[], secrets: Record<string, string>, headers: HeadersInit) {
    if (this.stopped.delete(id)) return new Response(frame(137), { headers });
    this.running.set(network, (this.running.get(network) ?? 0) + 1);
    const done = () => {
      this.running.set(network, (this.running.get(network) ?? 1) - 1);
    };
    const started = this.ctx.container!.exec(['sh', '-c', boxScript, 'box', 'run', ...argv], {
      user: '1000:1000',
      env: { ...secrets, AGENTGRAPH_RUN: id },
      stderr: 'combined',
    }).catch(error => {
      done();
      throw error;
    });
    const child = await started;
    if (this.stopped.has(id)) await this.reap(id);
    void child.exitCode.then(() => this.reap(id)).catch(() => undefined);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const pump = async () => {
      const writer = writable.getWriter();
      writer.closed.catch(() => this.reap(id));
      let last = 10;
      try {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          last = chunk.at(-1) ?? last;
          this.renewActivityTimeout();
          await writer.write(chunk);
        }
        const code = await child.exitCode;
        await this.reap(id);
        await writer.write(new TextEncoder().encode((last === 10 ? '' : '\n') + frame(code)));
        await writer.close();
      } catch (error) {
        await this.reap(id);
        await writer.abort(error).catch(() => undefined);
      } finally {
        done();
      }
    };
    this.ctx.waitUntil(pump());
    return new Response(readable, { headers });
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env) {
    await env.ENGINE.get(env.ENGINE.idFromName('engine')).wake();
  },
} satisfies ExportedHandler<Env>;
