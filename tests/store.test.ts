import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { dispatch } from '../src/dispatch.ts';
import { readHub } from '../src/load.ts';
import { alive, openStore, reconcile, runId } from '../src/store.ts';
import type { BotEvent } from '../src/types.ts';

const event: BotEvent = {
  id: 'e1',
  ts: '2026-10-12T00:00:00.000Z',
  source: 'cli',
  trigger: 'issue_comment',
  repo: 'acme/app',
  actor: { login: 'morgan', association: 'OWNER' },
};
const fields = { workflow: 'review', job: 'review', bot: 'reviewer', harness: 'opencode' as const, event };
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

  it('reports a damaged data directory instead of reading it as empty', async () => {
    const dir = temp();
    const store = openStore(dir);
    const { id } = await store.create(fields);
    writeFileSync(join(dir, 'runs', id, 'run.json'), '{"id":');
    await expect(store.read(id)).rejects.toThrow(SyntaxError);
    await expect(store.list()).rejects.toThrow(SyntaxError);
    mkdirSync(join(dir, 'runs', id, 'events.jsonl'));
    await expect(store.events(id)).rejects.toThrow('EISDIR');

    const flat = temp();
    writeFileSync(join(flat, 'runs'), '');
    writeFileSync(join(flat, 'deliveries'), '');
    await expect(openStore(flat).list()).rejects.toThrow('ENOTDIR');
    await expect(openStore(flat).deliver('gh-1')).rejects.toThrow('EEXIST');
  });

  it('lists runs newest first', async () => {
    const store = openStore(temp());
    const old = await store.create(fields, runId(new Date('2026-10-01T00:00:00Z')));
    const fresh = await store.create(fields, runId(new Date('2026-10-02T00:00:00Z')));
    expect((await store.list()).map(r => r.id)).toEqual([fresh.id, old.id]);
  });

  it('finds the runs matching every field of a filter', async () => {
    const store = openStore(temp());
    const at = (day: number) => runId(new Date(`2026-10-0${day}T00:00:00Z`));
    const job = await store.create({ ...fields, startedAt: '2026-10-02T00:00:00Z' }, at(1));
    const check = await store.create({ ...fields, check: 'lint', parent: job.id }, at(2));
    const other = await store.create({ ...fields, job: 'other', event: { ...event, id: 'e2', number: 3 } }, at(3));
    const ids = async (filter: Parameters<typeof store.runs>[0]) => (await store.runs(filter)).map(r => r.id);
    expect(await ids({})).toEqual([other.id, check.id, job.id]);
    expect(await ids({ event: 'e1', check: false })).toEqual([job.id]);
    expect(await ids({ check: true })).toEqual([check.id]);
    expect(await ids({ repo: 'acme/app', number: 3, job: 'other' })).toEqual([other.id]);
    expect(await ids({ since: Date.parse('2026-10-01T00:00:00Z') })).toEqual([job.id]);
    expect(await ids({ bot: 'nobody' })).toEqual([]);
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
    put('.pi/agent/sessions/--work--/s1.jsonl', '{"a":1}\n');
    put('.local/share/opencode/storage/session/ses_1.json');
    put('.pi/auth.json');
    put('.local/share/opencode/auth.json');
    put('.cache/blob.bin');
    const outside = mkdtempSync(join(tmpdir(), 'bothub-outside-'));
    writeFileSync(join(outside, 'secret.jsonl'), 'nope');
    symlinkSync(outside, join(home, 'escape'));
    symlinkSync(join(outside, 'secret.jsonl'), join(home, 'link.jsonl'));

    expect(await store.files(id)).toEqual([
      '.local/share/opencode/storage/session/ses_1.json',
      '.pi/agent/sessions/--work--/s1.jsonl',
    ]);
    expect(await store.file(id, '.pi/agent/sessions/--work--/s1.jsonl')).toBe('{"a":1}\n');
    for (const path of ['../run.json', '/etc/passwd', '.pi/auth.json', 'link.jsonl', 'escape/secret.jsonl'])
      expect(await store.file(id, path)).toBeUndefined();
  });
});

describe('delivery ledger and branch locks', () => {
  it('sees each delivery once, across store handles', async () => {
    const dir = temp();
    expect(await openStore(dir).deliver('gh-1')).toBe(true);
    expect(await openStore(dir).deliver('gh-1')).toBe(false);
    expect(await openStore(dir).deliver('gh-2')).toBe(true);
  });

  it('holds a lock for a live owner and takes over one a stopped process left', async () => {
    const dir = temp();
    const store = openStore(dir);
    const held = await store.lock('acme/app:bothub/7', 'r1');
    expect(await store.lock('acme/app:bothub/7', 'r2')).toEqual({ holder: 'r1' });
    if ('release' in held) await held.release();
    expect('release' in (await store.lock('acme/app:bothub/7', 'r2'))).toBe(true);

    const stopped = openStore(dir, { pid: process.pid, token: 'gone' });
    expect('release' in (await stopped.lock('acme/app:bothub/8', 'r3'))).toBe(true);
    expect('release' in (await store.lock('acme/app:bothub/8', 'r4'))).toBe(true);
  });

  it('plans an event once per delivery id', async () => {
    const compiled = compile(await readHub(join(import.meta.dirname, '../examples/hub')));
    if (!compiled.ok) throw new Error('example hub');
    const store = openStore(temp());
    const comment: BotEvent = { ...event, id: 'gh-9', number: 3, action: 'created', body: '/bothub fix it' };
    expect((await dispatch(comment, compiled.config, store)).map(j => j.job)).toEqual(['implement']);
    expect(await dispatch(comment, compiled.config, store)).toEqual([]);
  });
});

describe('alive', () => {
  it('trusts the token for this process and the pid for others', () => {
    const me = { pid: process.pid, token: 'me' };
    expect(alive({ pid: process.pid, token: 'me' }, me)).toBe(true);
    expect(alive({ pid: process.pid, token: 'before' }, me)).toBe(false);
    expect(alive({ pid: 2 ** 22 + 12345, token: 'x' }, me)).toBe(false);
    expect(alive(undefined, me)).toBe(false);
  });
});

describe('reconcile', () => {
  it('marks runs a stopped process left running or applying as interrupted and removes their worktrees', async () => {
    const dir = temp();
    const before = openStore(dir, { pid: process.pid, token: 'before' });
    const running = await before.create({ ...fields, status: 'running' });
    const applying = await before.create(fields);
    await before.update(applying.id, { status: 'succeeded' });
    await before.saveOutcome(applying.id, {
      proposals: [],
      errors: [],
      accepted: [],
      rejected: [],
      applied: true,
      results: [{ kind: 'reply', key: 'e1/review/review/reply-1', status: 'pending' }],
    });
    const done = await before.create(fields);
    await before.update(done.id, { status: 'succeeded' });
    const me = { pid: process.pid, token: 'now' };
    const now = openStore(dir, me);
    const mine = await now.create({ ...fields, status: 'running' });

    const removed: string[] = [];
    const marked = await reconcile(now, { remove: async (_, id) => void removed.push(id) }, me);
    expect(marked.map(r => r.id).sort()).toEqual([running.id, applying.id].sort());
    expect(await now.read(running.id)).toMatchObject({
      status: 'interrupted',
      error: 'the process running it stopped while it was running',
    });
    expect(await now.read(applying.id)).toMatchObject({
      status: 'interrupted',
      error: expect.stringMatching(/while applying/),
    });
    expect((await now.read(done.id))?.status).toBe('succeeded');
    expect((await now.read(mine.id))?.status).toBe('running');
    expect(removed.sort()).toEqual([running.id, applying.id].sort());
  });
});
