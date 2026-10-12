import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore, runId } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';

const event: BotEvent = {
  id: 'e1',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'cli',
  trigger: 'issue_comment',
  repo: 'acme/app',
  actor: { login: 'morgan', association: 'OWNER' },
};
const fields = { workflow: 'review', job: 'review', bot: 'reviewer', harness: 'claude-code' as const, event };
const temp = () => mkdtempSync(join(tmpdir(), 'bothub-store-'));

describe('runId', () => {
  it('is filesystem-safe and sorts by time', () => {
    const a = runId(new Date('2026-10-12T09:00:00.000Z'));
    const b = runId(new Date('2026-10-12T10:00:00.000Z'));
    expect(a).toMatch(/^2026-10-12T09-00-00-000Z-[0-9a-f]{6}$/);
    expect([b, a].sort()).toEqual([a, b]);
  });
});

describe('openStore', () => {
  it('creates, updates atomically and reads runs', async () => {
    const dir = temp();
    const store = openStore(dir);
    const run = await store.create(fields);
    expect(run.status).toBe('queued');
    expect(await store.read(run.id)).toEqual(run);

    const updated = await store.update(run.id, { status: 'succeeded', costUsd: 0.1, turns: 2 });
    expect(updated).toEqual({ ...run, status: 'succeeded', costUsd: 0.1, turns: 2 });
    expect(await store.read(run.id)).toEqual(updated);
    expect(readdirSync(join(dir, 'runs', run.id)).sort()).toEqual(['run.json']);
  });

  it('returns nothing for unknown runs and rejects updates to them', async () => {
    const store = openStore(temp());
    expect(await store.read('nope')).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.events('nope')).toEqual([]);
    await expect(store.update('nope', { status: 'failed' })).rejects.toThrow('unknown run');
  });

  it('lists runs newest first', async () => {
    const store = openStore(temp());
    const old = await store.create(fields, runId(new Date('2026-10-01T00:00:00Z')));
    const fresh = await store.create(fields, runId(new Date('2026-10-02T00:00:00Z')));
    expect((await store.list()).map(r => r.id)).toEqual([fresh.id, old.id]);
  });

  it('appends events and reads them from an offset, skipping a partial trailing line', async () => {
    const dir = temp();
    const store = openStore(dir);
    const { id } = await store.create(fields);
    const ts = '2026-10-12T00:00:00.000Z';
    await store.append(id, { ts, seq: 0, event: { type: 'start' } });
    await store.append(id, { ts, seq: 1, event: { type: 'text', text: 'hi' } });
    await store.append(id, { ts, seq: 2, event: { type: 'end', ok: true } });
    appendFileSync(join(dir, 'runs', id, 'events.jsonl'), '{"ts":"');

    expect((await store.events(id)).map(r => r.seq)).toEqual([0, 1, 2]);
    expect(await store.events(id, 1)).toEqual([
      { ts, seq: 1, event: { type: 'text', text: 'hi' } },
      { ts, seq: 2, event: { type: 'end', ok: true } },
    ]);
  });

  it('lists and reads harness files under home, without credentials or paths outside it', async () => {
    const store = openStore(temp());
    const { id } = await store.create(fields);
    expect(await store.files(id)).toEqual([]);
    const home = store.home(id);
    const put = (path: string, text = '{}') => {
      mkdirSync(join(home, path, '..'), { recursive: true });
      writeFileSync(join(home, path), text);
    };
    put('.claude/projects/-work/s1.jsonl', '{"a":1}\n');
    put('.codex/sessions/2026/10/12/rollout-1.jsonl');
    put('.local/share/opencode/storage/session/ses_1.json');
    put('.codex/auth.json');
    put('.local/share/opencode/auth.json');
    put('.cache/blob.bin');
    const outside = mkdtempSync(join(tmpdir(), 'bothub-outside-'));
    writeFileSync(join(outside, 'secret.jsonl'), 'nope');
    symlinkSync(outside, join(home, 'escape'));
    symlinkSync(join(outside, 'secret.jsonl'), join(home, 'link.jsonl'));

    expect(await store.files(id)).toEqual([
      '.claude/projects/-work/s1.jsonl',
      '.codex/sessions/2026/10/12/rollout-1.jsonl',
      '.local/share/opencode/storage/session/ses_1.json',
    ]);
    expect(await store.file(id, '.claude/projects/-work/s1.jsonl')).toBe('{"a":1}\n');
    for (const path of ['../run.json', '/etc/passwd', '.codex/auth.json', 'link.jsonl', 'escape/secret.jsonl'])
      expect(await store.file(id, path)).toBeUndefined();
  });
});
