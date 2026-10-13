import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { localIssues } from '../src/issues-local.ts';
import { bothubServer, mcpToolNames, opencodeMcpConfig, type McpServer } from '../src/mcp-config.ts';
import { proposalsFile, serveMcp } from '../src/mcp.ts';
import { openStore } from '../src/store.ts';
import { temp } from './git.ts';

const compiled = compile([
  { path: 'notes/caveat/hex.md', source: '---\ntitle: Hex has no 0x\n---\n\nPersisted hex has no prefix.' },
  { path: 'notes/style/vectors.md', source: '---\ntitle: Golden vectors\n---\n\nTest against vectors.' },
  { path: 'notes/caveat/hex-draft.md', source: '---\ntitle: Hex draft\nstatus: proposed\n---\n\nMaybe hex prefix.' },
]);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

const connect = (granted: Parameters<typeof serveMcp>[0], sources: Parameters<typeof serveMcp>[1]) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveMcp(granted, sources, { input, output });
  const pending = new Map<number, (message: unknown) => void>();
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at)) as { id: number };
      buffer = buffer.slice(at + 1);
      pending.get(message.id)?.(message);
    }
  });
  let next = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<any>(resolve => {
      const id = ++next;
      pending.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name: string, args: unknown = {}) =>
    (await request('tools/call', { name, arguments: args })).result as {
      content: { text: string }[];
      isError?: boolean;
    };
  return { request, call, close: () => (input.end(), done) };
};

describe('serveMcp', () => {
  it('speaks MCP over stdio and serves only the granted tools', async () => {
    const dir = temp('issues');
    writeFileSync(join(dir, '4-spec.md'), '---\ntitle: Spec\nlabels: [spec]\n---\n\nThe spec.\n');
    const issues = localIssues(dir, { repo: 'a/b' });
    const server = connect(['issues_get', 'issues_list', 'notes_search', 'notes_get'], {
      config: compiled.config,
      issues,
    });

    expect((await server.request('initialize', { protocolVersion: '2025-03-26' })).result).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'bothub', version: '0.0.0' },
    });
    const { tools } = (await server.request('tools/list')).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual([
      'issues_get',
      'issues_list',
      'notes_search',
      'notes_get',
    ]);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: ['number'] });

    expect(JSON.parse((await server.call('issues_get', { number: 4 })).content[0]!.text)).toMatchObject({
      number: 4,
      title: 'Spec',
      body: 'The spec.',
    });
    expect(JSON.parse((await server.call('issues_list', { label: 'spec' })).content[0]!.text)).toEqual([
      { number: 4, title: 'Spec', state: 'open', labels: ['spec'], url: 'issues/4-spec.md' },
    ]);
    expect(JSON.parse((await server.call('notes_search', { query: 'HEX prefix' })).content[0]!.text)).toEqual([
      { kind: 'caveat', slug: 'hex', title: 'Hex has no 0x' },
    ]);
    expect(
      JSON.parse((await server.call('notes_search', { query: 'hex', status: 'proposed' })).content[0]!.text)
    ).toEqual([{ kind: 'caveat', slug: 'hex-draft', title: 'Hex draft', status: 'proposed' }]);
    expect(JSON.parse((await server.call('notes_get', { kind: 'style', slug: 'vectors' })).content[0]!.text)).toEqual({
      slug: 'vectors',
      title: 'Golden vectors',
      kind: 'style',
      body: 'Test against vectors.',
    });
    expect(await server.call('runs_read')).toEqual({
      content: [{ type: 'text', text: 'unknown tool "runs_read"' }],
      isError: true,
    });
    expect((await server.call('issues_get', { number: 'four' })).isError).toBe(true);
    expect((await server.request('resources/list')).error).toEqual({
      code: -32601,
      message: 'method not found: resources/list',
    });
    await server.close();
  });

  it('reads runs only when granted and given a store', async () => {
    const store = openStore(temp('runs'));
    const run = await store.create({
      workflow: 'w',
      job: 'j',
      event: {
        id: 'e',
        ts: 't',
        source: 'cli',
        trigger: 'push',
        repo: 'a/b',
        actor: { login: 'x', association: 'NONE' },
      },
    });
    const server = connect(['runs_read'], { config: compiled.config, store });
    expect(JSON.parse((await server.call('runs_read')).content[0]!.text)).toMatchObject([{ id: run.id }]);
    expect(JSON.parse((await server.call('runs_read', { id: run.id })).content[0]!.text)).toMatchObject({
      run: { id: run.id },
      events: [],
    });
    await server.close();
    const bare = connect(['runs_read', 'issues_get'], { config: compiled.config });
    expect((await bare.call('runs_read')).content[0]!.text).toBe('this server has no runs');
    expect((await bare.call('issues_get', { number: 1 })).content[0]!.text).toBe('this server has no issues');
    await bare.close();
  });
});

describe('notes_add', () => {
  it('records a proposed note in the run home for the pipeline to land', async () => {
    const home = temp('home');
    const server = connect(['notes_add'], { config: compiled.config, home });
    const note = { note: 'caveat', slug: 'fee-retry', title: 'Fees retry once', body: 'A rejected fee retries once.' };
    expect((await server.call('notes_add', note)).content[0]!.text).toContain('notes/caveat/fee-retry.md');
    expect((await server.call('notes_add', { ...note, note: 'pattern' })).isError).toBe(true);
    expect((await server.call('notes_add', { ...note, slug: 'Not Kebab' })).isError).toBe(true);
    expect((await server.call('notes_search', { query: 'fee' })).isError).toBe(true);
    await server.close();
    const lines = readFileSync(proposalsFile(home), 'utf8').trim().split('\n');
    expect(lines.map(line => JSON.parse(line))).toEqual([{ kind: 'note', ...note }]);

    const homeless = connect(['notes_add'], { config: compiled.config });
    expect((await homeless.call('notes_add', note)).isError).toBe(true);
    await homeless.close();
  });
});

describe('harness MCP config', () => {
  const server: McpServer = {
    command: '/bin/node',
    args: ['bothub.mjs', 'mcp', '--tools', 'issues_get'],
    env: { A: 'b' },
  };

  it('starts the server through the bothub CLI with the granted tools', () => {
    expect(bothubServer({ dir: '/hub', tools: ['issues_get', 'notes_search'], repo: 'a/b', data: '/data' })).toEqual({
      command: process.execPath,
      args: [
        expect.stringMatching(/bin\/bothub\.mjs$/),
        'mcp',
        '--dir',
        '/hub',
        '--repo',
        'a/b',
        '--tools',
        'issues_get,notes_search',
        '--data',
        '/data',
      ],
      env: {},
    });
  });

  it('renders the mount for opencode', () => {
    expect(opencodeMcpConfig(server)).toEqual({
      mcp: {
        bothub: {
          type: 'local',
          command: ['/bin/node', 'bothub.mjs', 'mcp', '--tools', 'issues_get'],
          environment: { A: 'b' },
          enabled: true,
        },
      },
    });
  });

  it('names the tools the way each harness allowlists them', () => {
    expect(mcpToolNames('opencode', ['issues_get'])).toEqual(['bothub_issues_get']);
    expect(mcpToolNames('pi', ['issues_get'])).toEqual([]);
  });
});
