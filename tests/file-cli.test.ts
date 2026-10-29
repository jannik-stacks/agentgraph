import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = async (args: string[]) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(import.meta.dirname, '../bin/run.ts'), 'file', ...args],
    {
      env: {
        PATH: process.env.PATH,
        AGENTGRAPH_TOOL_URL: process.env.AGENTGRAPH_TOOL_URL,
        AGENTGRAPH_TOOL_SECRET: process.env.AGENTGRAPH_TOOL_SECRET,
      },
    }
  );
  return stdout.trim();
};

afterEach(() => vi.unstubAllEnvs());

it('streams the sandbox file without sending its name or a Content-Length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-cli-'));
  const path = join(dir, 'private-name.png');
  const bytes = Buffer.alloc(200_000, 7);
  await writeFile(path, bytes);
  const requests: unknown[] = [];
  const ref = `file_${'a'.repeat(64)}`;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      auth: request.headers.authorization,
      length: request.headers['content-length'],
      bytes: Buffer.concat(chunks),
    });
    response.writeHead(201).end(ref);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  vi.stubEnv('AGENTGRAPH_TOOL_URL', `http://127.0.0.1:${address.port}/session`);
  vi.stubEnv('AGENTGRAPH_TOOL_SECRET', 'test-secret');
  try {
    expect(await runFile(['put', path])).toBe(ref);
    expect(requests).toEqual([{ url: '/session/files', auth: 'Bearer test-secret', length: undefined, bytes }]);
    await expect(runFile(['put', dir])).rejects.toThrow(`File ${dir}: expected a regular file`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('fails explicitly outside a local tool session', async () => {
  vi.stubEnv('AGENTGRAPH_TOOL_URL', '');
  await expect(runFile(['put', '/tmp/image.png'])).rejects.toThrow(
    'File /tmp/image.png: file passing needs a local sandbox tool session'
  );
  await expect(runFile(['other', '/tmp/image.png'])).rejects.toThrow('usage: agi file put');
});
