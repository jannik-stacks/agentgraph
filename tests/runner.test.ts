import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Chunk, Effect, Fiber, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { pi } from '../src/harnesses/pi.ts';
import { agentEnv, agentEvents, homeEnv, limiter, masker, runJob, runScript, stuckWatch } from '../src/runner.ts';
import { openStore, type Store } from '../src/store.ts';
import type { AgentEvent, HarnessAdapter, RunSpec } from '../src/types.ts';

const fixturePath = join(import.meta.dirname, 'fixtures', 'pi-run.jsonl');
const spec: RunSpec = { prompt: 'p', system: 's', cwd: tmpdir(), tools: [], maxTurns: 1 };

const json = (line: string): AgentEvent[] => (line.trim() ? [JSON.parse(line)] : []);
const node = (script: string, parseLine = json): HarnessAdapter => ({
  name: 'opencode',
  command: () => ({ cmd: 'node', args: ['-e', script], env: { FROM_ADAPTER: '1' } }),
  parseLine,
});
const asText = (line: string): AgentEvent[] => (line ? [{ type: 'text', text: line }] : []);

const replay = `const s = require('fs').readFileSync(${JSON.stringify(fixturePath)}, 'utf8'); let i = 0;
const t = setInterval(() => { process.stdout.write(s.slice(i, (i += 97))); if (i >= s.length) clearInterval(t); }, 1);`;
const hang = `console.log(process.pid); setInterval(() => {}, 1e6);`;
const host = ['HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'USER'].filter(k => process.env[k]);
const end = (ok: boolean) => JSON.stringify({ type: 'end', ok });

const setup = async () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'bothub-runner-')));
  const run = await store.create({
    workflow: 'w',
    job: 'j',
    harness: 'opencode',
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
    process.env.OPENAI_API_KEY ??= 'leak';
    const env = agentEnv({ A: '1' }, { BOTHUB_LLM_API_KEY: 't' });
    expect(Object.keys(env).sort()).toEqual(['A', 'BOTHUB_LLM_API_KEY', ...host].sort());
  });

  it('puts HOME, the XDG directories and TMPDIR inside the run', () => {
    const env = agentEnv({}, {}, homeEnv('/data/runs/r/home', '/data/runs/r/tmp'));
    expect(env).toMatchObject({
      HOME: '/data/runs/r/home',
      XDG_CONFIG_HOME: '/data/runs/r/home/.config',
      XDG_DATA_HOME: '/data/runs/r/home/.local/share',
      XDG_STATE_HOME: '/data/runs/r/home/.local/state',
      XDG_CACHE_HOME: '/data/runs/r/home/.cache',
      TMPDIR: '/data/runs/r/tmp',
    });
  });
});

describe('agentEvents', () => {
  it('parses chunked stdout line by line', async () => {
    const expected = readFileSync(fixturePath, 'utf8').split('\n').flatMap(pi.parseLine);
    const events = await Effect.runPromise(Stream.runCollect(agentEvents(node(replay, pi.parseLine), spec)));
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
      runJob({
        adapter: node(replay, pi.parseLine),
        spec,
        timeoutMinutes: 1,
        store,
        runId,
        onEvent: r => seen.push(r.seq),
      })
    );
    expect(run).toMatchObject({ status: 'succeeded', turns: 2 });
    expect(run.startedAt).toBeDefined();
    expect(run.endedAt).toBeDefined();
    const events = await store.events(runId);
    expect(events.map(r => r.seq)).toEqual(seen);
    expect(events.map(r => r.event.type)).toEqual(
      readFileSync(fixturePath, 'utf8')
        .split('\n')
        .flatMap(pi.parseLine)
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

  it('masks secret values in stored events, the error and home files', async () => {
    const { store, runId } = await setup();
    const script = `const e = process.env;
require('fs').writeFileSync(require('path').join(e.HOME, 'log.txt'), 'key ' + e.BOTHUB_LLM_API_KEY);
console.log('the key is ' + e.BOTHUB_LLM_API_KEY); console.error('bad ' + e.BOTHUB_LLM_API_KEY); process.exit(1);`;
    const secrets = { BOTHUB_LLM_API_KEY: 'sk-secret-value-123' };
    const run = await Effect.runPromise(
      runJob({ adapter: node(script, asText), spec, timeoutMinutes: 1, store, runId, secrets })
    );
    expect(run).toMatchObject({ status: 'failed', error: 'bad ***' });
    expect((await store.events(runId)).map(r => r.event)).toEqual([{ type: 'text', text: 'the key is ***' }]);
    expect(readFileSync(join(store.home(runId), 'log.txt'), 'utf8')).toBe('key ***');
  });

  it('stops a run that repeats the same tool call and result', async () => {
    const { store, runId } = await setup();
    const loop = (line: string): AgentEvent[] =>
      line
        ? [
            { type: 'tool_call', id: line, tool: 'bash', input: { command: 'ls' } },
            { type: 'tool_result', id: line, ok: true, output: 'a.txt' },
          ]
        : [];
    const script = `let i = 0; setInterval(() => console.log(i++), 1);`;
    const run = await Effect.runPromise(runJob({ adapter: node(script, loop), spec, timeoutMinutes: 1, store, runId }));
    expect(run).toMatchObject({ status: 'failed', error: 'stuck: the same tool call and result 4 times in a row' });
    expect(await store.events(runId)).toHaveLength(8);
  });

  it('reports a container that never started as sandbox-failed', async () => {
    const { store, runId } = await setup();
    const path = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), 'bothub-empty-path-'));
    try {
      const run = await Effect.runPromise(
        runJob({ adapter: node(''), spec, timeoutMinutes: 1, store, runId, sandbox: 'docker' })
      );
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/^sandbox-failed: .*ENOENT/);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('stuckWatch', () => {
  it('reports the same error three times in a row and resets on a different one', () => {
    const watch = stuckWatch();
    const error = (message: string) => watch({ type: 'error', message });
    expect([error('a'), error('a'), error('b'), error('b')]).toEqual([undefined, undefined, undefined, undefined]);
    expect(error('b')).toBe('the same error 3 times in a row: b');
  });

  it('treats a different result as a new streak', () => {
    const watch = stuckWatch();
    const pair = (output: string) => {
      watch({ type: 'tool_call', id: output, tool: 'read', input: { path: 'x' } });
      return watch({ type: 'tool_result', id: output, ok: true, output: output.slice(0, 1) });
    };
    expect([pair('a1'), pair('a2'), pair('a3'), pair('b1'), pair('a4')]).toEqual(Array(5).fill(undefined));
  });
});

describe('masker', () => {
  it('replaces every secret of 8 or more characters and leaves short values alone', () => {
    const mask = masker(['sk-12345678', 'short', 'sk-12345678']);
    expect(mask('a sk-12345678 b sk-12345678 short')).toBe('a *** b *** short');
  });
});

describe('run directory', () => {
  const tree = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => relative(dir, join(entry.parentPath, entry.name)))
      .sort();

  it('gives the harness a private home that is kept and a tmp dir that is removed', async () => {
    const { store, runId } = await setup();
    const script = `const fs = require('fs'), path = require('path'), e = process.env;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
put(path.join(e.HOME, '.pi', 'agent', 'sessions', 'session-1.jsonl'), '{"type":"session"}\\n');
put(path.join(e.XDG_DATA_HOME, 'opencode', 'storage', 'session', 'ses_1.json'), '{}');
put(path.join(e.TMPDIR, 'scratch.txt'), 'gone');
console.log(${JSON.stringify(end(true))});`;
    const run = await Effect.runPromise(runJob({ adapter: node(script), spec, timeoutMinutes: 1, store, runId }));
    expect(run.status).toBe('succeeded');
    const dir = join(store.home(runId), '..');
    expect(existsSync(store.tmp(runId))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['events.jsonl', 'home', 'run.json']);
    expect(tree(dir)).toEqual([
      'events.jsonl',
      'home/.local/share/opencode/storage/session/ses_1.json',
      'home/.pi/agent/sessions/session-1.jsonl',
      'run.json',
    ]);
    expect(await store.files(runId)).toEqual([
      '.local/share/opencode/storage/session/ses_1.json',
      '.pi/agent/sessions/session-1.jsonl',
    ]);
  });

  it('removes tmp after a failed run too', async () => {
    const { store, runId } = await setup();
    const run = await Effect.runPromise(
      runJob({ adapter: node(`process.exit(2)`), spec, timeoutMinutes: 1, store, runId })
    );
    expect(run.status).toBe('failed');
    expect(existsSync(store.home(runId))).toBe(true);
    expect(existsSync(store.tmp(runId))).toBe(false);
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
    expect(await runScript('echo "$BOTHUB_BRANCH"', cwd, 1, { BOTHUB_BRANCH: 'bothub/7-x' })).toEqual({
      ok: true,
      output: 'bothub/7-x',
    });
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
