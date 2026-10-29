import { tool, jsonSchema, type Tool, type InferSchema } from 'ai';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readLocalHttp } from './doubles/http.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { Effect } from 'effect';
import { loadGraph } from '../src/folder.ts';
import { tmp, write } from './kit.ts';
import { startTools } from '../src/tools.ts';

const endpoints: Awaited<ReturnType<typeof startTools>>[] = [];
const credential = 'engine-credential-material';
const directories: string[] = [];
const startRegistered = async (...args: Parameters<typeof startTools>) => {
  const [definitions, context, trace, route, hidden, timeout] = args;
  const first = Object.values(definitions)[0]!;
  const available: typeof definitions = { private: first, ...definitions };
  const dir = tmp('endpoint');
  directories.push(dir);
  const records = Object.keys(available)
    .map(
      name =>
        `${JSON.stringify(name)}: tool({ description: 'Registered tool', inputSchema: Schema.Struct({ query: Schema.String }), execute: async () => 'registered' })`
    )
    .join(',');
  write(dir, {
    'settings.yaml': 'repo: owner/repo\n',
    'agents/reader.md': `---\nharness: fixture\ntools: [read, ${Object.keys(definitions).join(', ')}]\n---\n`,
    'workflows/search.md': '---\non: issues\nagent: reader\n---\n',
    'plugins/tools.ts': `import { makePlugin, tool } from '${new URL('../src/plugin.ts', import.meta.url).href}'; import { Schema } from '${import.meta.resolve('effect')}'; export default makePlugin({ name: 'fixture', tools: { ${records} } });`,
  });
  const graph = await Effect.runPromise(
    loadGraph(dir, [{ name: 'fixture', classify: name => (name === 'read' ? 'read' : undefined) }])
  );
  const selected = Object.fromEntries(
    graph.tools!.filter(name => graph.agents.reader!.tools.includes(name)).map(name => [name, available[name]!])
  );
  return startTools(selected, context, trace, route, hidden, timeout);
};
const schema = jsonSchema<{ query: string }>(
  { type: 'object', properties: { query: { type: 'string' } } },
  {
    validate: async value =>
      typeof (value as { query?: unknown })?.query === 'string'
        ? { success: true, value: value as { query: string } }
        : { success: false, error: new Error('query must be string') },
  }
);
const open = async (
  execute: NonNullable<Tool<InferSchema<typeof schema>, string>['execute']>,
  timeout = 30000,
  inputSchema = schema
) => {
  const trace: Parameters<Parameters<typeof startTools>[2]>[0][] = [];
  const endpoint = await startRegistered(
    { issues: { tool: tool({ inputSchema, execute }), settings: {}, plugin: 'issues' } },
    { repo: 'owner/repo', dir: '/checkout', forge: { searchIssues: async () => [] } },
    event => {
      trace.push(event);
    },
    undefined,
    [credential],
    timeout
  );
  endpoints.push(endpoint);
  const request = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
    readLocalHttp(endpoint.url, {
      method,
      headers: {
        Authorization: `Bearer ${endpoint.secret}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(method !== 'GET' && { body: JSON.stringify(body) }),
    });
  const call = (query: unknown) =>
    request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'issues', arguments: { query } } });
  return { endpoint, request, call, trace };
};
afterEach(async () => {
  await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()));
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

it('lists only allowed tools, validates input, and scrubs results and traces', async () => {
  const { request, call, trace } = await open(async ({ query }) => (query === 'big' ? 'x'.repeat(16385) : query));
  const listed = await (await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['issues']);
  const result = await (await call(credential)).json();
  expect(result.result).toMatchObject({ content: [{ text: '[redacted]' }], isError: false });
  expect(trace[0]).toMatchObject({
    name: 'issues',
    input: { query: '[redacted]' },
    output: '[redacted]',
    ms: expect.any(Number),
  });
  expect((await (await call(42)).json()).result.isError).toBe(true);
  expect((await (await call('big')).json()).result).toMatchObject({
    isError: true,
    content: [{ text: 'tool output exceeds 16384 bytes' }],
  });
});

it.each([
  [{ Host: 'untrusted.example' }, 'POST', 403],
  [{ Origin: 'http://untrusted.example' }, 'POST', 403],
  [{ Authorization: 'Bearer wrong' }, 'POST', 401],
  [{}, 'GET', 405],
] as const)('rejects invalid request headers %j', async (headers, method, status) => {
  const { request } = await open(async () => 'ok');
  expect((await request({}, headers, method)).status).toBe(status);
});

it('rejects oversized bodies and keeps permits until timed-out native work drains', async () => {
  let finish!: (value: string) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const native = new Promise<string>(resolve => {
    finish = resolve;
  });
  let count = 0;
  const { request, call, trace } = await open(async () => {
    if (++count === 4) started();
    return native;
  }, 100);
  expect((await request({ padding: 'x'.repeat(65537) })).status).toBe(413);
  const blocked = Promise.all(Array.from({ length: 4 }, () => call('wait')));
  await ready;
  expect((await call('overflow')).status).toBe(429);
  const timed = await blocked;
  expect((await Promise.all(timed.map(response => response.json()))).map(body => body.result.isError)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect((await (await call('blocked')).json()).result).toMatchObject({
    isError: true,
    content: [{ text: 'tool concurrency limit reached' }],
  });
  expect(trace.every(event => event.ok === false)).toBe(true);
  finish('done');
});

it('serves the SDK client and revokes its endpoint on session close', async () => {
  const { endpoint } = await open(async ({ query }) => query);
  const client = new Client({ name: 'agentgraph-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        fetch: readLocalHttp,
        requestInit: { headers: { Authorization: `Bearer ${endpoint.secret}` } },
      }) as Parameters<Client['connect']>[0]
    );
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['issues']);
    expect(await client.callTool({ name: 'issues', arguments: { query: 'cache' } })).toMatchObject({
      content: [{ text: 'cache' }],
      isError: false,
    });
  } finally {
    await client.close();
  }
  await endpoint.close();
  endpoints.splice(endpoints.indexOf(endpoint), 1);
  await expect(readLocalHttp(endpoint.url, { method: 'POST' })).rejects.toThrow();
});

it('ends a request whose body never finishes', async () => {
  const { endpoint } = await open(async () => 'ok', 30);
  const url = new URL(endpoint.url);
  const host = url.host;
  url.hostname = '127.0.0.1';
  const status = await new Promise<number>(resolve => {
    const outgoing = httpRequest(
      url,
      { method: 'POST', headers: { Host: host, Authorization: `Bearer ${endpoint.secret}` } },
      response => resolve(response.statusCode!)
    );
    outgoing.once('error', () => resolve(0));
    outgoing.write('{');
  });
  expect([0, 408]).toContain(status);
});

it('rejects the wrong session path and peers outside its allowed subnet', async () => {
  const { endpoint } = await open(async () => 'ok');
  const wrong = new URL(endpoint.url);
  wrong.pathname = '/unknown';
  expect((await readLocalHttp(wrong, { method: 'POST' })).status).toBe(404);
  const blocked = await startRegistered(
    { issues: { tool: tool({ inputSchema: schema, execute: async () => 'ok' }), settings: {}, plugin: 'issues' } },
    { repo: 'o/r', dir: '/checkout', forge: { searchIssues: async () => [] } },
    () => {},
    {
      host: '127.0.0.1',
      subnet: '192.0.2.0/24',
    }
  );
  endpoints.push(blocked);
  expect((await readLocalHttp(blocked.url, { method: 'POST' })).status).toBe(403);
});

it('scrubs tool errors and supplied credentials from descriptions and schemas', async () => {
  const { endpoint, call, trace } = await open(async () => {
    throw new Error(credential);
  });
  expect((await (await call('error')).json()).result).toMatchObject({
    content: [{ text: '[redacted]' }],
    isError: true,
  });
  expect(trace[0]?.output).toBe('[redacted]');
  const anonymous = await readLocalHttp(endpoint.url, { method: 'POST' });
  expect(anonymous.status).toBe(401);
});

it('does not expose errors thrown by its trace sink', async () => {
  const endpoint = await startRegistered(
    { issues: { tool: tool({ inputSchema: schema, execute: async () => 'ok' }), settings: {}, plugin: 'issues' } },
    { repo: 'o/r', dir: '/checkout', forge: { searchIssues: async () => [] } },
    () => {
      throw new Error(credential);
    }
  );
  endpoints.push(endpoint);
  const response = await readLocalHttp(endpoint.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.secret}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'issues', arguments: { query: 'test' } },
    }),
  });
  expect((await response.json()).result).toMatchObject({
    isError: true,
    content: [{ text: 'tool trace could not be written' }],
  });
});

it('bounds and scrubs descriptions, schemas and large trace inputs', async () => {
  const definition = tool({
    description: `${credential} ${'x'.repeat(4096)}`,
    inputSchema: jsonSchema({ type: 'object', properties: { query: { type: 'string', default: credential } } }),
    execute: async () => 'ok',
  });
  const context = { repo: 'o/r', dir: '/checkout', forge: { searchIssues: async () => [] } };
  const endpoint = await startRegistered(
    { issues: { tool: definition, settings: {}, plugin: 'issues' } },
    context,
    () => {},
    undefined,
    [credential]
  );
  endpoints.push(endpoint);
  const response = await readLocalHttp(endpoint.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.secret}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const shown = (await response.json()).result.tools[0];
  expect(shown.description.length).toBe(2048);
  expect(shown.description).not.toContain(credential);
  expect(shown.inputSchema.properties.query.default).toBe('[redacted]');
  const huge = tool({
    inputSchema: jsonSchema({ type: 'object', description: 'x'.repeat(16385) }),
    execute: async () => 'ok',
  });
  await expect(
    startRegistered({ huge: { tool: huge, settings: {}, plugin: 'huge' } }, context, () => {})
  ).rejects.toThrow('tool schema exceeds 16384 bytes');
  const opened = await open(async ({ query }) => query);
  await opened.call('x'.repeat(4096));
  expect(opened.trace[0]?.input).toHaveLength(2048);
  expect(opened.trace[0]?.output).toHaveLength(2048);
});

it('records a bounded failure when deeply nested input cannot be serialized', async () => {
  const { endpoint, trace } = await open(async ({ query }) => query);
  const body =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"issues","arguments":{"query":"ok","nested":' +
    '['.repeat(6000) +
    '0' +
    ']'.repeat(6000) +
    '}}}';
  const response = await readLocalHttp(endpoint.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.secret}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body,
  });
  expect((await response.json()).result).toMatchObject({
    isError: true,
    content: [{ text: 'tool input could not be recorded' }],
  });
  expect(trace[0]).toMatchObject({ input: '[input omitted]', ok: false });
});

it.each(['', '0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0'])(
  'refuses wildcard listen address %s',
  async host => {
    const definitions = {
      issues: { tool: tool({ inputSchema: schema, execute: async () => 'ok' }), settings: {}, plugin: 'issues' },
    };
    await expect(
      startRegistered(
        definitions,
        { repo: 'o/r', dir: '/checkout', forge: { searchIssues: async () => [] } },
        () => {},
        {
          host,
          subnet: '127.0.0.0/8',
        }
      )
    ).rejects.toThrow('tools need a specific IP listen address');
  }
);

it('does not execute a tool when validation finishes after cancellation', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let validations = 0;
  const delayed = jsonSchema<InferSchema<typeof schema>>(
    { type: 'object' },
    {
      validate: async value => {
        if (++validations === 4) started();
        await gate;
        return { success: true, value: value as InferSchema<typeof schema> };
      },
    }
  );
  const execute = vi.fn(async () => 'executed');
  const { call } = await open(execute, 60, delayed);
  const pending = Promise.all(Array.from({ length: 4 }, () => call('wait')));
  await ready;
  await pending;
  expect((await (await call('blocked')).json()).result).toMatchObject({
    isError: true,
    content: [{ text: 'tool concurrency limit reached' }],
  });
  expect(execute).not.toHaveBeenCalled();
  release();
  expect((await (await call('fresh')).json()).result).toMatchObject({
    isError: false,
    content: [{ text: 'executed' }],
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('finishes cancellation tracing before closing without waiting for native work', async () => {
  let started!: () => void;
  let recorded!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => {
    started = resolve;
  });
  const tracing = new Promise<void>(resolve => {
    recorded = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const endpoint = await startRegistered(
    {
      issues: {
        tool: tool({
          inputSchema: schema,
          execute: () => {
            started();
            return new Promise<string>(() => {});
          },
        }),
        settings: {},
        plugin: 'issues',
      },
    },
    { repo: 'o/r', dir: '/checkout', forge: { searchIssues: async () => [] } },
    async () => {
      recorded();
      await gate;
    }
  );
  const pending = readLocalHttp(endpoint.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.secret}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'issues', arguments: { query: 'wait' } },
    }),
  }).catch(() => undefined);
  await ready;
  let closed = false;
  const closing = endpoint.close().then(() => {
    closed = true;
  });
  await tracing;
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    expect(closed).toBe(false);
    await expect(readLocalHttp(endpoint.url, { method: 'POST' })).rejects.toThrow();
  } finally {
    release();
    await closing;
    await pending;
  }
  expect(closed).toBe(true);
});

it('releases request permits when clients disconnect', async () => {
  let started!: () => void;
  let stopped!: () => void;
  const { endpoint, request, trace } = await open(
    async (_input, { abortSignal }) =>
      new Promise<string>(resolve => {
        started();
        abortSignal!.addEventListener(
          'abort',
          () => {
            stopped();
            resolve('cancelled');
          },
          { once: true }
        );
      })
  );
  for (let index = 0; index < 4; index++) {
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const settled = new Promise<void>(resolve => {
      stopped = resolve;
    });
    const controller = new AbortController();
    const pending = readLocalHttp(endpoint.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${endpoint.secret}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: { name: 'issues', arguments: { query: 'cancel' } },
      }),
    }).catch(() => undefined);
    await ready;
    controller.abort();
    await settled;
    await pending;
  }
  await vi.waitFor(() => expect(trace).toHaveLength(4));
  expect((await request({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).status).toBe(200);
});
