import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chunk, Effect, Fiber, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { claude } from '../src/executors/claude.ts';
import { agentEnv, agentEvents, limiter, runJob, runScript } from '../src/runner.ts';
import { openStore, type Store } from '../src/store.ts';
import type { AgentEvent, ExecutorAdapter, RunSpec } from '../src/types.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'claude-stream.jsonl');
const spec: RunSpec = { prompt: 'p', system: 's', cwd: tmpdir(), tools: [], maxTurns: 1 };

const node = (script: string, parseLine = claude.parseLine): ExecutorAdapter => ({
  name: 'claude-code',
  command: () => ({ cmd: 'node', args: ['-e', script], env: { FROM_ADAPTER: '1' } }),
  parseLine,
});
const asText = (line: string): AgentEvent[] => (line ? [{ type: 'text', text: line }] : []);

const replay = `const s = require('fs').readFileSync(${JSON.stringify(fixturePath)}, 'utf8'); let i = 0;
const t = setInterval(() => { process.stdout.write(s.slice(i, (i += 97))); if (i >= s.length) clearInterval(t); }, 1);`;
const hang = `console.log(process.pid); setInterval(() => {}, 1e6);`;
const host = ['HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'USER'].filter(k => process.env[k]);
const end = (ok: boolean) => JSON.stringify({ type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok });

const setup = async () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'bothub-runner-')));
  const run = await store.create({
    workflow: 'w',
    job: 'j',
    harness: 'claude-code',
    event: {
      id: 'e',
      ts: '2026-10-12T00:00:00.000Z',
      source: 'cli',
      trigger: 'issue_comment',
      repo: 'acme/app',
      actor: { login: 'morgan', association: 'OWNER' },
    },
  });
  return { store, runId: run.id };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidOf = async (store: Store, runId: string) => {
  const [first] = await store.events(runId);
  if (first?.event.type !== 'text') throw new Error('no pid recorded');
  return Number(first.event.text);
};

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await check()); i++) await new Promise(r => setTimeout(r, 10));
};

describe('agentEnv', () => {
  it('passes only the allowlist, adapter env and explicit secrets', () => {
    process.env.ANTHROPIC_API_KEY ??= 'leak';
    const env = agentEnv({ A: '1' }, { CLAUDE_CODE_OAUTH_TOKEN: 't' });
    expect(Object.keys(env).sort()).toEqual(['A', 'CLAUDE_CODE_OAUTH_TOKEN', ...host].sort());
  });
});

describe('agentEvents', () => {
  it('parses chunked stdout line by line', async () => {
    const expected = readFileSync(fixturePath, 'utf8').split('\n').flatMap(claude.parseLine);
    const events = await Effect.runPromise(Stream.runCollect(agentEvents(node(replay), spec)));
    expect(Chunk.toArray(events)).toEqual(expected);
  });

  it('emits a final line without a trailing newline', async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(agentEvents(node(`process.stdout.write('a\\nb')`, asText), spec))
    );
    expect(Chunk.toArray(events)).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('closes stdin and does not inherit the host env', async () => {
    const script = `process.stdin.on('end', () => console.log(Object.keys(process.env).sort().join(','))).resume();`;
    const events = await Effect.runPromise(Stream.runCollect(agentEvents(node(script, asText), spec, { S: 'x' })));
    const keys = Chunk.toArray(events)[0];
    expect(keys).toMatchObject({ type: 'text' });
    expect((keys as { text: string }).text.split(',').filter(k => !k.startsWith('__CF'))).toEqual(
      ['FROM_ADAPTER', 'S', ...host].sort()
    );
  });

  it('fails with the stderr tail on a non-zero exit', async () => {
    const result = await Effect.runPromise(
      Effect.either(Stream.runDrain(agentEvents(node(`console.error('boom'); process.exit(3)`), spec)))
    );
    expect(result._tag === 'Left' && result.left.message).toBe('boom');
  });
});

describe('runJob', () => {
  it('stores events and succeeds with cost and turns', async () => {
    const { store, runId } = await setup();
    const seen: number[] = [];
    const run = await Effect.runPromise(
      runJob({ adapter: node(replay), spec, timeoutMinutes: 1, store, runId, onEvent: r => seen.push(r.seq) })
    );
    expect(run).toMatchObject({ status: 'succeeded', turns: 2, costUsd: 0.11227379999999999 });
    expect(run.startedAt).toBeDefined();
    expect(run.endedAt).toBeDefined();
    const events = await store.events(runId);
    expect(events.map(r => r.seq)).toEqual(seen);
    expect(events.map(r => r.event.type)).toEqual(
      readFileSync(fixturePath, 'utf8')
        .split('\n')
        .flatMap(claude.parseLine)
        .map(e => e.type)
    );
    expect(await store.read(runId)).toEqual(run);
  });

  it('fails when the agent reports failure', async () => {
    const { store, runId } = await setup();
    const run = await Effect.runPromise(
      runJob({ adapter: node(`console.log(${JSON.stringify(end(false))})`), spec, timeoutMinutes: 1, store, runId })
    );
    expect(run).toMatchObject({ status: 'failed', error: 'agent reported failure' });
  });

  it('fails on a non-zero exit even after a successful result', async () => {
    const { store, runId } = await setup();
    const script = `console.log(${JSON.stringify(end(true))}); console.error('crashed'); process.exit(1)`;
    const run = await Effect.runPromise(runJob({ adapter: node(script), spec, timeoutMinutes: 1, store, runId }));
    expect(run).toMatchObject({ status: 'failed', error: 'crashed' });
  });

  it('fails when the command cannot start', async () => {
    const { store, runId } = await setup();
    const adapter = { ...node(''), command: () => ({ cmd: 'bothub-no-such-binary', args: [], env: {} }) };
    const run = await Effect.runPromise(runJob({ adapter, spec, timeoutMinutes: 1, store, runId }));
    expect(run.status).toBe('failed');
    expect(run.error).toContain('ENOENT');
  });

  it('times out and kills the process', async () => {
    const { store, runId } = await setup();
    const run = await Effect.runPromise(
      runJob({ adapter: node(hang, asText), spec, timeoutMinutes: 0.005, store, runId })
    );
    expect(run.status).toBe('timed-out');
    expect(alive(await pidOf(store, runId))).toBe(false);
  });

  it('records cancelled and kills the process on interrupt', async () => {
    const { store, runId } = await setup();
    const fiber = Effect.runFork(runJob({ adapter: node(hang, asText), spec, timeoutMinutes: 1, store, runId }));
    await waitFor(async () => (await store.events(runId)).length > 0);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const run = await store.read(runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.endedAt).toBeDefined();
    expect(alive(await pidOf(store, runId))).toBe(false);
  });
});

describe('runScript', () => {
  it('passes on exit 0 with a minimal env and reports the output tail otherwise', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bothub-script-'));
    process.env.BOTHUB_SECRET_PROBE = 'leak';
    expect(await runScript('echo "$BOTHUB_SECRET_PROBE" ok; pwd', cwd, 1)).toEqual({
      ok: true,
      output: expect.stringMatching(/^ok\n.*bothub-script-/),
    });
    delete process.env.BOTHUB_SECRET_PROBE;
    expect(await runScript('echo broke >&2; exit 2', cwd, 1)).toEqual({ ok: false, output: 'broke' });
  });

  it('kills the script after the timeout', async () => {
    const result = await runScript('sleep 5', mkdtempSync(join(tmpdir(), 'bothub-script-')), 0.002);
    expect(result).toEqual({ ok: false, output: 'timed out after 0.002 minutes' });
  });
});

describe('limiter', () => {
  it('runs at most n jobs at once and keeps the rest queued', async () => {
    const a = await setup();
    const b = { store: a.store, runId: (await a.store.create((await a.store.read(a.runId))!)).id };
    const script = `console.log(${JSON.stringify(end(true))}); setTimeout(() => {}, 300);`;
    const job = (ids: typeof a) => runJob({ adapter: node(script), spec, timeoutMinutes: 1, ...ids });

    const fiber = Effect.runFork(
      Effect.flatMap(limiter(1), limit => Effect.all([limit(job(a)), limit(job(b))], { concurrency: 'unbounded' }))
    );
    await waitFor(async () => (await a.store.read(a.runId))?.status === 'running');
    expect((await b.store.read(b.runId))?.status).toBe('queued');

    const [first, second] = await Effect.runPromise(Fiber.join(fiber));
    expect([first.status, second.status]).toEqual(['succeeded', 'succeeded']);
    expect(second.startedAt! >= first.endedAt!).toBe(true);
  });
});
