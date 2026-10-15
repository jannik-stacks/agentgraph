import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { serve } from '../src/api.ts';
import { cli, main } from '../src/cli.ts';
import { opNames } from '../src/ops.ts';
import { openStore } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';
import { temp } from './kit.ts';

const examples = join(import.meta.dirname, '../examples');

const event: BotEvent = {
  id: 'e',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'cli',
  trigger: 'issue_comment',
  repo: 'acme/app',
  actor: { login: 'octocat', association: 'OWNER' },
};
const ts = '2026-10-12T09:30:15.000Z';

const seeded = async () => {
  const data = temp('cli');
  const store = openStore(data);
  const run = await store.create({ workflow: 'issue-command', job: 'implement', harness: 'opencode', event });
  await store.update(run.id, { status: 'succeeded', costUsd: 0.1234, startedAt: ts });
  await store.append(run.id, { ts, seq: 0, event: { type: 'start', model: 'sonnet' } });
  await store.append(run.id, {
    ts,
    seq: 1,
    event: { type: 'tool_call', id: 't', tool: 'Bash', input: { command: 'ls' } },
  });
  await store.append(run.id, { ts, seq: 2, event: { type: 'text', text: 'all\n  done' } });
  await store.append(run.id, { ts, seq: 3, event: { type: 'end', ok: true, turns: 2, costUsd: 0.1234 } });
  return { data, store, id: run.id };
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(s => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation(s => (err.push(String(s)), true));
  return { out, err };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('cli', () => {
  it('check passes on the example hub and fails closed on an empty one', async () => {
    const io = capture();
    expect(await main(['check', '--dir', join(examples, 'hub'), '--json'])).toBe(0);
    expect(await main(['check', '--dir', join(examples, 'payloads')])).toBe(2);
    expect(io.out[0]).toBe('{"ok":true,"warnings":[]}\n');
    expect(JSON.parse(io.out[1] ?? '').errors[0].message).toBe('no bots, skills, checks, workflows or notes found');
    expect(await main(['check', '--dir', join(examples, 'hub'), '--no-json'])).toBe(0);
    expect(io.out[2]).toBe('ok: 2 bots, 3 skills, 2 checks, 1 workflow (2 jobs), 5 notes\n');
  });

  it('check validates the hub sandbox and fails on a setup script it cannot find', async () => {
    const dir = temp('cli-hub');
    cpSync(join(examples, 'hub'), dir, { recursive: true });
    const io = capture();
    writeFileSync(join(dir, 'hub.yaml'), 'sandbox:\n  network: wide\n');
    expect(await main(['check', '--dir', dir, '--no-json'])).toBe(2);
    expect(io.err.join('')).toMatch(/hub\.yaml[^]*sandbox\.network/);
    writeFileSync(join(dir, 'hub.yaml'), 'sandbox:\n  setup: sandbox/setup.sh\n  network: open\n');
    expect(await main(['check', '--dir', dir, '--no-json'])).toBe(2);
    expect(io.err.at(-1)).toBe('bothub: hub.yaml: sandbox.setup sandbox/setup.sh is not a file in the hub\n');
    mkdirSync(join(dir, 'sandbox'));
    writeFileSync(join(dir, 'sandbox', 'setup.sh'), '#!/bin/sh\n');
    expect(await main(['check', '--dir', dir, '--no-json'])).toBe(0);
  });

  it('check prints the warnings of a hub that compiles', async () => {
    const dir = temp('cli-hub');
    cpSync(join(examples, 'hub'), dir, { recursive: true });
    writeFileSync(join(dir, 'checks/fine.md'), '---\ntype: decide\nmode: block\n---\nIs the change fine?\n');
    const io = capture();
    expect(await main(['check', '--dir', dir, '--no-json'])).toBe(0);
    expect(io.err).toEqual([
      expect.stringMatching(/^warning: checks\/fine.md: .*without a "threshold"/),
      expect.stringMatching(/^warning: checks\/fine.md: no job lists it/),
    ]);
    expect(io.err.every(line => line.startsWith('warning: '))).toBe(true);
    expect(io.out[0]).toMatch(new RegExp(`, ${io.err.length} warnings?\\n$`));
  });

  it('serve takes only a positive whole number of events at once', async () => {
    const { err } = capture();
    const hub = ['--hub', temp('cli'), '--repo', temp('cli')];
    expect(await main(['serve', ...hub, '--concurrency', '0'])).toBe(2);
    await main(['serve', ...hub, '--concurrency', 'many']);
    expect(err.join('')).toBe(
      'bothub: --concurrency must be a positive whole number, not "0"\n' +
        'bothub: --concurrency must be a positive whole number, not "many"\n'
    );
  });

  it('run --dry-run --json lists the jobs a payload starts', async () => {
    const io = capture();
    const code = await main([
      'run',
      '--event',
      'issue_comment',
      join(examples, 'payloads/issue-comment.json'),
      '--dir',
      join(examples, 'hub'),
      '--dry-run',
      '--json',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('')).jobs).toEqual([
      expect.objectContaining({
        workflow: 'issue',
        job: 'implement',
        bot: 'implementor',
        args: 'add a /health endpoint with a test',
      }),
    ]);
  });

  it('run --dry-run prints each agent session without creating anything', async () => {
    const io = capture();
    const data = join(temp('cli'), 'data');
    const payload = join(examples, 'payloads/issue-comment.json');
    const args = ['run', '--event', 'issue_comment', payload, '--dir', join(examples, 'hub'), '--data', data];
    expect(await main([...args, '--dry-run', '--json'])).toBe(0);
    const [job] = JSON.parse(io.out.join('')).jobs;
    expect(job).toMatchObject({
      workflow: 'issue',
      job: 'implement',
      harness: 'opencode',
      timeoutMinutes: 45,
      branch: 'bothub/7',
      until: { checks: ['types', 'review'], max: 2 },
    });
    expect(job.spec.cwd.startsWith(join(data, 'work'))).toBe(true);
    expect(job.spec.system).toContain('"kind": "merge-request"');
    expect(job.spec.system).not.toContain('## Notes');
    expect(job.spec.surfacer).toMatchObject({ bot: 'implementor', hub: join(examples, 'hub'), data });
    expect(job.spec.prompt).toContain('```text\nadd a /health endpoint with a test\n```');
    expect(job.command.slice(0, 2)).toEqual(['opencode', 'run']);

    io.out.length = 0;
    expect(await main([...args, '--dry-run', '--no-json'])).toBe(0);
    const text = io.out.join('');
    expect(text).toContain('issue/implement (implementor, opencode, 45 min)\n');
    expect(text).toContain('until: types, review pass, at most 2 more attempts\n');
    expect(text).toContain('--agent bothub --model bothub/writer -- <prompt>');
    expect(text).toMatch(/ -- <prompt>\n/);
    expect(existsSync(data)).toBe(false);
  });

  it('logs without an id lists runs as a table or JSON', async () => {
    const { data, id } = await seeded();
    const io = capture();
    expect(await main(['logs', '--data', data, '--no-json'])).toBe(0);
    expect(io.out[0]).toMatch(new RegExp(`^${id}  succeeded  issue-command/implement  \\$0\\.12  \\d+[smhd] ago\\n$`));
    expect(await main(['logs', '--data', data, '--json'])).toBe(0);
    expect(JSON.parse(io.out[1] ?? '')[0]).toMatchObject({ id, status: 'succeeded' });
    expect(await main(['logs', '--data', temp('cli'), '--no-json'])).toBe(0);
    expect(io.out[2]).toBe('no runs\n');
  });

  it('logs prints one line per event and fails on unknown runs', async () => {
    const { data, id } = await seeded();
    const io = capture();
    expect(await main(['logs', id, '--data', data, '--no-json'])).toBe(0);
    expect(io.out).toEqual([
      '09:30:15 start sonnet\n',
      '09:30:15 call Bash {"command":"ls"}\n',
      '09:30:15 text all done\n',
      '09:30:15 end ok, 2 turns, $0.12\n',
    ]);
    expect(await main(['logs', 'nope', '--data', data])).toBe(2);
    expect(io.err).toEqual(['bothub: unknown run "nope"\n']);
  });

  it('logs --follow prints new events until the run finishes', async () => {
    const { data, store, id } = await seeded();
    await store.update(id, { status: 'running' });
    const io = capture();
    setTimeout(async () => {
      await store.append(id, { ts, seq: 4, event: { type: 'error', message: 'late' } });
      await store.update(id, { status: 'failed' });
    }, 100);
    expect(await main(['logs', id, '--data', data, '--follow', '--json'])).toBe(0);
    expect(io.out.map(line => JSON.parse(line).seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('logs --spend compares the calls recorded per key with the model proxy, which it needs', async () => {
    const data = temp('cli');
    const store = openStore(data);
    const run = await store.create({
      workflow: 'w',
      job: 'j',
      bot: 'reviewer',
      event,
      startedAt: new Date().toISOString(),
    });
    await store.add(run.id, {
      type: 'usage',
      inputTokens: 30,
      outputTokens: 2,
      source: 'decide-check',
      model: 'luna',
      ms: 40,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([]))
    );
    const io = capture();
    vi.stubEnv('BOTHUB_LLM_BASE_URL', 'http://proxy.test/v1');
    vi.stubEnv('LITELLM_MASTER_KEY', 'sk-master');
    expect(await main(['logs', '--spend', '--data', data, '--no-json'])).toBe(0);
    expect(io.out.slice(1)).toEqual([
      'shared: bothub 1 calls, 30 in, 2 out, $0.00; proxy 0 calls, 0 in, 0 out, $0.00; missing -1 calls, -30 in, -2 out, $0.00\n',
      'keys no bot holds: proxy 0 calls, 0 in, 0 out, $0.00\n',
    ]);
    expect(await main(['logs', run.id, '--data', data, '--no-json'])).toBe(0);
    expect(io.out.at(-1)).toMatch(/ usage decide-check luna 30 in, 2 out, 40 ms\n$/);
    vi.stubEnv('LITELLM_MASTER_KEY', '');
    expect(await main(['logs', '--spend', '--data', data])).toBe(1);
    expect(io.err).toEqual(['bothub: comparing spend needs BOTHUB_LLM_BASE_URL and LITELLM_MASTER_KEY\n']);
  });
});

describe('cli surface', () => {
  it('lists six commands and one per op, and keeps mcp hidden', async () => {
    expect(Object.keys(cli.subCommands as object)).toEqual([
      'check',
      'run',
      'serve',
      'logs',
      'sim',
      'setup-app',
      ...opNames.map(name => name.replaceAll('_', '-')),
    ]);
    capture();
    expect(await main(['plan'])).toBe(2);
    expect(await main(['mcp', '--dir', join(examples, 'payloads')])).toBe(2);
  });
});

describe('op commands', () => {
  it('sends an op to the served runner with flags and the text as its input', async () => {
    const calls: [string, unknown][] = [];
    const server = await serve(async req => {
      calls.push([new URL(req.url).pathname, await req.json()]);
      return Response.json(null);
    }, 0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      capture();
      expect(await main(['say', '--issue', '12', 'please look', '--url', url])).toBe(0);
      expect(await main(['pause', '--now', '--url', url])).toBe(0);
      expect(calls).toEqual([
        ['/rpc/say', { issue: 12, text: 'please look' }],
        ['/rpc/pause', { now: true }],
      ]);
    } finally {
      server.close();
    }
  });
});
