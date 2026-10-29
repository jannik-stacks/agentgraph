import { expect, it, afterEach } from 'vitest';
import { tool } from '../src/plugin.ts';
import { Schema } from 'effect';
import { startTools } from '../src/tools.ts';
import { readLocalHttp } from './doubles/http.ts';

const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const sessions: Awaited<ReturnType<typeof startTools>>[] = [];
const open = async (trace: Parameters<typeof startTools>[2] = () => {}) => {
  const read = tool({
    description: 'Read file',
    inputSchema: Schema.Struct({ ref: Schema.String }),
    execute: async ({ ref }, ctx) => {
      const first = await ctx.readFile(ref);
      const bytes = [...first.bytes];
      first.bytes.fill(0);
      const second = await ctx.readFile(ref);
      return { bytes, again: [...second.bytes], type: first.type };
    },
  });
  const endpoint = await startTools(
    { read: { tool: read, settings: undefined, plugin: 'files' } },
    { repo: 'o/r', forge: { searchIssues: async () => [] } },
    trace
  );
  sessions.push(endpoint);
  const headers = { Authorization: `Bearer ${endpoint.secret}` };
  return {
    endpoint,
    put: async (bytes = image) => {
      const response = await readLocalHttp(`${endpoint.url}/files`, { method: 'POST', headers, body: bytes });
      const text = await response.text();
      if (response.status !== 201) throw new Error(text || `file upload HTTP ${response.status}`);
      return text;
    },
    read: async (ref: string) => {
      const response = await readLocalHttp(endpoint.url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read', arguments: { ref } },
        }),
      });
      const result = (await response.json()).result;
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    },
  };
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
});

it('scopes random handles and returns immutable copies with metadata only', async () => {
  const events: unknown[] = [];
  const files = await open(event => {
    if (event.name.startsWith('file_')) events.push({ name: event.name, input: event.input });
  });
  const ref = await files.put();
  expect(ref).toMatch(/^file_[a-f0-9]{64}$/);
  expect(await files.read(ref)).toEqual({ bytes: [...image], again: [...image], type: 'image/png' });
  expect(events).toEqual([
    { name: 'file_put', input: { ref, bytes: 8, type: 'image/png' } },
    { name: 'file_read', input: { ref, bytes: 8, type: 'image/png' } },
    { name: 'file_read', input: { ref, bytes: 8, type: 'image/png' } },
  ]);
  const other = await open();
  await expect(other.read(ref)).rejects.toThrow(ref);
  await expect(files.read('guessed')).rejects.toThrow('File guessed: unknown, expired or outside this session');
  sessions.splice(sessions.indexOf(files.endpoint), 1);
  await files.endpoint.close();
  const resumed = await open();
  await expect(resumed.read(ref)).rejects.toThrow('expired');
});

it.each([
  ['wrong magic', new Uint8Array([1, 2, 3]), 'magic'],
  ['oversize', new Uint8Array(10 * 1024 * 1024 + 1), '10 MiB'],
])('rejects %s', async (_name, bytes, why) => {
  await expect((await open()).put(bytes)).rejects.toThrow(why);
});

it('accepts JPEG magic', async () => {
  const files = await open();
  const ref = await files.put(new Uint8Array([255, 216, 255]));
  expect((await files.read(ref)).type).toBe('image/jpeg');
});

it('caps session file count', async () => {
  const files = await open();
  for (let index = 0; index < 32; index++) await files.put();
  await expect(files.put()).rejects.toThrow('count limit');
});

it('caps retained bytes', async () => {
  const files = await open();
  const bytes = new Uint8Array(10 * 1024 * 1024);
  bytes.set(image);
  for (let index = 0; index < 6; index++) await files.put(bytes);
  await expect(files.put(bytes)).rejects.toThrow('byte limit');
});

it('counts rejected input toward cumulative quota', async () => {
  const files = await open();
  const failures = [];
  for (let index = 0; index < 26; index++)
    failures.push(await files.put(new Uint8Array(10 * 1024 * 1024)).catch(error => error.message));
  expect(failures.at(-1)).toContain('input byte limit');
});

it('caps concurrent uploads', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let ready!: () => void;
  const started = new Promise<void>(resolve => {
    ready = resolve;
  });
  let count = 0;
  const files = await open(async event => {
    if (event.name === 'file_put') {
      if (++count === 2) ready();
      await gate;
    }
  });
  const pending = [files.put(), files.put()];
  await started;
  try {
    await expect(files.put()).rejects.toThrow('concurrent');
  } finally {
    release();
  }
  expect(await Promise.all(pending)).toHaveLength(2);
});

it('reserves bytes before tracing concurrent puts near the session quota', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let ready!: () => void;
  const started = new Promise<void>(resolve => {
    ready = resolve;
  });
  let held = false;
  const records: unknown[] = [];
  const files = await open(async event => {
    if (held && event.name === 'file_put') {
      records.push(event.input);
      ready();
      await gate;
    }
  });
  const bytes = new Uint8Array(10 * 1024 * 1024);
  bytes.set(image);
  for (let index = 0; index < 6; index++) await files.put(bytes);
  held = true;
  const smaller = bytes.subarray(0, 3 * 1024 * 1024);
  const pending = files.put(smaller);
  await started;
  try {
    await expect(files.put(smaller)).rejects.toThrow('byte limit');
  } finally {
    release();
  }
  expect(await pending).toMatch(/^file_/);
  expect(records).toHaveLength(1);
});
