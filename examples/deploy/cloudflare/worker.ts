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

export class Engine extends Container<Env> {
  sleepAfter = '10m';
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = ['github.com', 'api.github.com', 'codeload.github.com', 'box.internal', 'data.internal', 'gateway.internal'];
  static {
    this.outboundByHost = { 'box.internal': runBox, 'data.internal': storeData, 'gateway.internal': gateway };
  }

  async wake() {
    if (this.ctx.container?.running) return;
    const env = this.env;
    await this.start({
      envVars: {
        AGENTGRAPH_REPO: env.AGENTGRAPH_REPO,
        AGENTGRAPH_APP_ID: env.AGENTGRAPH_APP_ID,
        AGENTGRAPH_APP_KEY: env.AGENTGRAPH_APP_KEY,
        AGENTGRAPH_PROXY_KEYS: env.AGENTGRAPH_PROXY_KEYS,
      },
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
    if ([...this.running.values()].some(count => count > 0)) this.renewActivityTimeout();
    else await this.destroy();
  }

  override async fetch(request: Request) {
    if (request.method === 'DELETE') {
      await this.destroy();
      return new Response(null, { status: 204 });
    }
    const url = new URL(request.url);
    const op = url.pathname.split('/')[2] ?? '';
    await this.start();
    this.renewActivityTimeout();
    if (op === 'run') {
      const network = url.searchParams.get('network');
      if (!networks.includes(network as Network)) return new Response(`unknown network ${network}`, { status: 400 });
      return this.run(network as Network, await request.json());
    }
    if (!['init', 'push', 'pull', 'put'].includes(op)) return new Response(`unknown op ${op}`, { status: 404 });
    const child = await this.ctx.container!.exec(['sh', '-c', boxScript, 'box', op, ...url.searchParams.getAll('arg')], {
      user: op === 'init' || op === 'put' ? 'root' : '1000:1000',
      ...(request.body && { stdin: request.body }),
      stderr: 'pipe',
    });
    if (op === 'pull') return new Response(child.stdout);
    const { exitCode, stdout, stderr } = await child.output();
    const text = new TextDecoder();
    return exitCode === 0
      ? new Response(null, { status: 204 })
      : new Response(text.decode(stdout) + text.decode(stderr), { status: 500 });
  }

  async run(network: Network, argv: string[]) {
    this.running.set(network, (this.running.get(network) ?? 0) + 1);
    const done = () => this.running.set(network, (this.running.get(network) ?? 1) - 1);
    const child = await this.ctx.container!.exec(['sh', '-c', boxScript, 'box', 'run', ...argv], {
      user: '1000:1000',
      stderr: 'combined',
    }).catch(error => {
      done();
      throw error;
    });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const pump = async () => {
      const writer = writable.getWriter();
      let last = 10;
      try {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          last = chunk.at(-1) ?? last;
          this.renewActivityTimeout();
          await writer.write(chunk);
        }
        const code = await child.exitCode;
        await writer.write(new TextEncoder().encode((last === 10 ? '' : '\n') + frame(code)));
        await writer.close();
      } catch (error) {
        child.kill(9);
        await writer.abort(error);
      } finally {
        done();
      }
    };
    this.ctx.waitUntil(pump());
    return new Response(readable);
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env) {
    await env.ENGINE.get(env.ENGINE.idFromName('engine')).wake();
  },
} satisfies ExportedHandler<Env>;
