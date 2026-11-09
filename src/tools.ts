import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { asSchema } from 'ai';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { formatRedactedText } from './context.ts';
import { makeFiles } from './files.ts';
import type { SessionEvent } from './trace.ts';
import type { readPlugins, ToolContext } from './plugin.ts';

export const readRequestBody = async (request: AsyncIterable<Buffer>, limit = 65_536) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
};

export const startTools = async (
  tools: Awaited<ReturnType<typeof readPlugins>>['tools'],
  context: Omit<ToolContext<unknown>, 'settings' | 'abortSignal' | 'readFile'>,
  trace: (event: Extract<SessionEvent, { type: 'tool' }>) => void | Promise<void>,
  storage: { save: Parameters<typeof makeFiles>[1]; session: string },
  route = { host: '127.0.0.1', subnet: '127.0.0.0/8' },
  hidden: readonly string[] = [],
  timeout = 30_000
) => {
  const wildcards = new BlockList();
  wildcards.addAddress('0.0.0.0');
  wildcards.addAddress('::', 'ipv6');
  if (!isIP(route.host) || wildcards.check(route.host, isIP(route.host) === 6 ? 'ipv6' : 'ipv4'))
    throw new Error('tools need a specific IP listen address');
  const secret = randomBytes(32).toString('hex');
  const bearer = Buffer.from(`Bearer ${secret}`);
  const id = randomUUID();
  const path = `/${id}`;
  const controllers = new Set<AbortController>();
  const running = new Set<Promise<unknown>>();
  const calls = new Set<Promise<unknown>>();
  const files = makeFiles(async (action, ref, bytes, hash, type) => {
    await trace({
      type: 'tool',
      id: randomUUID(),
      name: `file_${action}`,
      input: { ref, bytes, type, hash, session: storage.session },
      ok: true,
    });
  }, storage.save);
  const peers = new BlockList();
  const [address, prefix] = route.subnet.split('/');
  peers.addSubnet(address!, Number(prefix), isIP(address!) === 6 ? 'ipv6' : 'ipv4');
  const known = [
    secret,
    ...hidden,
    ...Object.entries(process.env)
      .filter(([name, value]) => /key|token|secret|password/i.test(name) && (value?.length ?? 0) >= 8)
      .map(([, value]) => value!),
  ];
  const clean = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, part) => {
        if (typeof part === 'string') return formatRedactedText(part, known);
        if (part && typeof part === 'object' && !Array.isArray(part))
          return Object.fromEntries(
            Object.entries(part).map(([key, entry]) => [formatRedactedText(key, known), entry])
          );
        return part;
      })
    );
  const schemas = Object.fromEntries(
    await Promise.all(
      Object.entries(tools).map(async ([name, entry]) => {
        const schema = clean(await asSchema(entry.tool.inputSchema).jsonSchema);
        if (Buffer.byteLength(JSON.stringify(schema)) > 16_384) throw new Error('tool schema exceeds 16384 bytes');
        return [name, schema];
      })
    )
  );
  let origin = '';
  const server = createServer(async (request, response) => {
    const peer = request.socket.remoteAddress ?? '';
    if (
      !isIP(peer) ||
      !peers.check(peer, isIP(peer) === 6 ? 'ipv6' : 'ipv4') ||
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== path && request.url !== `${path}/files`) {
      response.writeHead(404).end();
      return;
    }
    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (authorization.length !== bearer.length || !timingSafeEqual(authorization, bearer)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    if (controllers.size >= 4) {
      response.writeHead(429).end();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    let received = false;
    const timer = setTimeout(() => {
      controller.abort(new Error('tool request timed out'));
      if (!received) {
        response.writeHead(408).end();
        request.destroy();
      }
    }, timeout);
    if (request.url === `${path}/files`) {
      response.once('close', () => {
        clearTimeout(timer);
        controllers.delete(controller);
        controller.abort(new Error('file request closed'));
        request.destroy();
      });
      const pending = (async () => {
        try {
          const ref = await files.put(request.iterator({ destroyOnReturn: false }), controller.signal);
          received = true;
          response.writeHead(201, { 'Content-Type': 'text/plain' }).end(ref);
        } catch (error) {
          if (!response.headersSent)
            response
              .writeHead(400, { 'Content-Type': 'text/plain' })
              .end(formatRedactedText(error instanceof Error ? error.message : String(error), known));
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
        }
      })();
      calls.add(pending);
      await pending.finally(() => calls.delete(pending));
      return;
    }
    const mcp = new Server({ name: 'agentgraph-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.once('close', () => {
      clearTimeout(timer);
      controllers.delete(controller);
      controller.abort(new Error('tool request closed'));
      void mcp.close();
    });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.entries(tools).map(([name, entry]) => ({
        name,
        description: formatRedactedText(
          typeof entry.tool.description === 'string' ? entry.tool.description : name,
          known
        ).slice(0, 2048),
        inputSchema: schemas[name] as { type: 'object' },
      })),
    }));
    const call = async (request: CallToolRequest) => {
      const { name, arguments: input = {} } = request.params;
      const call = randomUUID();
      const started = Date.now();
      let output: string;
      let ok = false;
      try {
        if (!Object.hasOwn(tools, name)) throw new Error(`unknown tool ${name}`);
        if (running.size >= 4) throw new Error('tool concurrency limit reached');
        controller.signal.throwIfAborted();
        const entry = tools[name]!;
        const execution = Promise.resolve().then(async () => {
          const parsed = await asSchema(entry.tool.inputSchema).validate!(input);
          if (!parsed.success) throw parsed.error;
          controller.signal.throwIfAborted();
          return entry.tool.execute!(parsed.value, {
            toolCallId: call,
            messages: [],
            abortSignal: controller.signal,
            context: {
              ...context,
              settings: entry.settings,
              readFile: (ref: string) => {
                const pending = files.read(ref, controller.signal);
                calls.add(pending);
                void pending.finally(() => calls.delete(pending)).catch(() => {});
                return pending;
              },
            },
          });
        });
        running.add(execution);
        void execution.finally(() => running.delete(execution)).catch(() => {});
        const result = await Promise.race([
          execution,
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
              once: true,
            });
          }),
        ]);
        output = typeof result === 'string' ? result : (JSON.stringify(result) ?? 'null');
        if (Buffer.byteLength(output) > 16_384) throw new Error('tool output exceeds 16384 bytes');
        output = formatRedactedText(output, known);
        if (Buffer.byteLength(output) > 16_384) throw new Error('tool output exceeds 16384 bytes');
        ok = true;
      } catch (error) {
        output = formatRedactedText(error instanceof Error ? error.message : String(error), known).slice(0, 2048);
      }
      let recorded: unknown = '[input omitted]';
      try {
        const text = JSON.stringify(clean(input));
        recorded = text.length > 2048 ? text.slice(0, 2048) : JSON.parse(text);
      } catch {
        output = 'tool input could not be recorded';
        ok = false;
      }
      try {
        await trace({
          type: 'tool',
          id: call,
          name: formatRedactedText(name, known).slice(0, 128),
          input: recorded,
          output: output.slice(0, 2048),
          ok,
          ms: Date.now() - started,
        });
      } catch {
        output = 'tool trace could not be written';
        ok = false;
      }
      return { content: [{ type: 'text' as const, text: output }], isError: !ok };
    };
    mcp.setRequestHandler(CallToolRequestSchema, request => {
      const pending = call(request);
      calls.add(pending);
      return pending.finally(() => calls.delete(pending));
    });
    try {
      const text = await readRequestBody(request);
      if (text === undefined) {
        response.writeHead(413).end();
        return;
      }
      received = true;
      controller.signal.throwIfAborted();
      const body: unknown = JSON.parse(text);
      await mcp.connect(transport as Parameters<Server['connect']>[0]);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  });
  server.maxConnections = 8;
  server.headersTimeout = timeout;
  server.requestTimeout = timeout;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, route.host, resolve);
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('tools listener has no port');
  const url = `http://tools-${id}.internal:${bound.port}${path}`;
  origin = new URL(url).origin;
  return {
    url,
    secret,
    host: route.host,
    tools: Object.keys(tools),
    close: async () => {
      files.close();
      const closed = new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      for (const controller of controllers) controller.abort(new Error('tool session closed'));
      server.closeAllConnections();
      await Promise.allSettled(calls);
      await closed;
    },
  };
};
