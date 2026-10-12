import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import { openStore } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';
import { temp } from './git.ts';

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
  const run = await store.create({ workflow: 'issue-command', job: 'implement', executor: 'claude-code', event });
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

afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('check passes on the example hub and fails closed on an empty one', async () => {
    const io = capture();
    expect(await main(['check', '--dir', join(examples, 'hub'), '--json'])).toBe(0);
    expect(await main(['check', '--dir', join(examples, 'payloads')])).toBe(2);
    expect(io.out[0]).toBe('{"ok":true}\n');
    expect(JSON.parse(io.out[1] ?? '').errors[0].message).toBe('no personas/*.md or workflows/*.md found');
  });

  it('plan prints the jobs a payload starts', async () => {
    const io = capture();
    const code = await main([
      'plan',
      '--event',
      'issue_comment',
      join(examples, 'payloads/issue-comment.json'),
      '--dir',
      join(examples, 'hub'),
      '--json',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('')).jobs).toEqual([
      {
        workflow: 'issue-command',
        job: 'implement',
        persona: 'implementor',
        args: 'add a /health endpoint with a test',
      },
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
      workflow: 'issue-command',
      job: 'implement',
      executor: 'claude-code',
      timeoutMinutes: 45,
    });
    expect(job.spec.cwd.startsWith(join(data, 'work'))).toBe(true);
    expect(job.spec.system).toContain('"kind": "open-pr"');
    expect(job.spec.prompt).toContain('```text\nadd a /health endpoint with a test\n```');
    expect(job.command.slice(0, 2)).toEqual(['claude', '-p']);

    io.out.length = 0;
    expect(await main([...args, '--dry-run', '--no-json'])).toBe(0);
    const text = io.out.join('');
    expect(text).toContain('issue-command/implement (implementor, claude-code, 45 min)\n');
    expect(text).toContain('--append-system-prompt <system>');
    expect(text).toMatch(/ -- <prompt>\n/);
    expect(existsSync(data)).toBe(false);
  });

  it('runs lists runs as a table or JSON', async () => {
    const { data, id } = await seeded();
    const io = capture();
    expect(await main(['runs', '--data', data, '--no-json'])).toBe(0);
    expect(io.out[0]).toMatch(new RegExp(`^${id}  succeeded  issue-command/implement  \\$0\\.12  \\d+[smhd] ago\\n$`));
    expect(await main(['runs', '--data', data, '--json'])).toBe(0);
    expect(JSON.parse(io.out[1] ?? '')[0]).toMatchObject({ id, status: 'succeeded' });
    expect(await main(['runs', '--data', temp('cli'), '--no-json'])).toBe(0);
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
});
