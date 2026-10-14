import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Chunk, Effect, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { opencode } from '../src/harnesses/opencode.ts';
import { pi } from '../src/harnesses/pi.ts';
import {
  agentEnv,
  agentEvents,
  homeEnv,
  limiter,
  masker,
  runJob,
  runScript,
  sandboxed,
  stuckWatch,
  unsandboxed,
  type Launcher,
} from '../src/runner.ts';
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
const orphanExit = `const parent = process.ppid; setInterval(() => process.ppid !== parent && process.exit(), 100);`;
const hang = `console.log('pid ' + process.pid); ${orphanExit}`;
const host = ['HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'USER'].filter(k => process.env[k]);
const end = (ok: boolean) => JSON.stringify({ type: 'end', ok });

const started: { store: Store; runId: string }[] = [];

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
  started.push({ store, runId: run.id });
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
  const pid = first?.event.type === 'text' && /^pid (\d+)$/.exec(first.event.text)?.[1];
  if (!pid) throw new Error('no pid recorded');
  return Number(pid);
};

afterEach(async () => {
  for (const { store, runId } of started.splice(0)) {
    const pid = await pidOf(store, runId).catch(() => undefined);
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

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
    const events = await Effect.runPromise(
      Stream.runCollect(agentEvents(node(replay, pi.parseLine), spec, undefined, undefined, unsandboxed))
    );
    expect(Chunk.toArray(events)).toEqual(expected);
  });

  it('emits a final line without a trailing newline', async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(
        agentEvents(node(`process.stdout.write('a\\nb')`, asText), spec, undefined, undefined, unsandboxed)
      )
    );
    expect(Chunk.toArray(events)).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it("sends the adapter's start events once, with the first line", async () => {
    const adapter = {
      ...node(`process.stdout.write('a\\nb')`, asText),
      start: () => [{ type: 'start' as const, model: 'm' }],
    };
    const events = await Effect.runPromise(
      Stream.runCollect(agentEvents(adapter, spec, undefined, undefined, unsandboxed))
    );
    expect(Chunk.toArray(events)).toEqual([
      { type: 'start', model: 'm' },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('takes the opencode session from its first own line when a plugin prints first', async () => {
    const lines = [
      { type: 'bothub', event: { type: 'start', model: 'sol' } },
      { type: 'bothub', event: { type: 'recall', on: 'turn', query: 'q', tokens: 1, items: [] } },
      { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'hi' } },
    ];
    const script = `process.stdout.write(${JSON.stringify(lines.map(line => JSON.stringify(line)).join('\n'))})`;
    const adapter = { ...opencode, command: node(script).command };
    const events = await Effect.runPromise(
      Stream.runCollect(agentEvents(adapter, { ...spec, model: 'writer' }, undefined, undefined, unsandboxed))
    );
    expect(Chunk.toArray(events).map(e => e.type)).toEqual(['start', 'recall', 'start', 'text']);
    expect(Chunk.toArray(events)[0]).toEqual({ type: 'start', model: 'sol' });
    expect(Chunk.toArray(events)[2]).toEqual({ type: 'start', session: 'ses_1' });
  });

  it('closes stdin and does not inherit the host env', async () => {
    const script = `process.stdin.on('end', () => console.log(Object.keys(process.env).sort().join(','))).resume();`;
    const events = await Effect.runPromise(
      Stream.runCollect(agentEvents(node(script, asText), spec, { S: 'x' }, undefined, unsandboxed))
    );
    const keys = Chunk.toArray(events)[0];
    expect(keys).toMatchObject({ type: 'text' });
    expect((keys as { text: string }).text.split(',').filter(k => !k.startsWith('__CF'))).toEqual(
      ['FROM_ADAPTER', 'S', ...host].sort()
    );
  });

  it('fails with the stderr tail on a non-zero exit', async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Stream.runDrain(
          agentEvents(node(`console.error('boom'); process.exit(3)`), spec, undefined, undefined, unsandboxed)
        )
      )
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
        launch: unsandboxed,
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

  it('fails a successful run when one of its plugins never marked itself loaded', async () => {
    const mark = `const fs = require('fs'), path = require('path'); const f = path.join(process.env.HOME, '.bothub', 'loaded', 'bothub-surfacer'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '');`;
    const withPlugins = (script: string): HarnessAdapter => ({
      ...node(`${script} console.log(${JSON.stringify(end(true))})`),
      plugins: () => ['bothub-surfacer', 'bothub-decider'],
    });
    const run = async (script: string, plugins = withPlugins(script)) => {
      const { store, runId } = await setup();
      return Effect.runPromise(
        runJob({ adapter: plugins, spec, timeoutMinutes: 1, store, runId, launch: unsandboxed })
      );
    };
    expect(await run(mark)).toMatchObject({ status: 'failed', error: 'plugin bothub-decider did not load' });
    expect(await run('')).toMatchObject({
      status: 'failed',
      error: 'plugin bothub-surfacer, bothub-decider did not load',
    });
    const one = { ...withPlugins(mark), plugins: () => ['bothub-surfacer'] };
    expect(await run(mark, one)).toMatchObject({ status: 'succeeded' });
  });

  it('fails when the agent reports failure', async () => {
    const { store, runId } = await setup();
    const run = await Effect.runPromise(
      runJob({
        adapter: node(`console.log(${JSON.stringify(end(false))})`),
        spec,
        timeoutMinutes: 1,
        store,
        runId,
        launch: unsandboxed,
      })
    );
    expect(run).toMatchObject({ status: 'failed', error: 'agent reported failure' });
  });

  it('fails on a non-zero exit even after a successful result', async () => {
    const { store, runId } = await setup();
    const script = `console.log(${JSON.stringify(end(true))}); console.error('crashed'); process.exit(1)`;
    const run = await Effect.runPromise(
      runJob({ adapter: node(script), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed })
    );
    expect(run).toMatchObject({ status: 'failed', error: 'crashed' });
  });

  it('fails when the command cannot start', async () => {
    const { store, runId } = await setup();
    const adapter = { ...node(''), command: () => ({ cmd: 'bothub-no-such-binary', args: [], env: {} }) };
    const run = await Effect.runPromise(
      runJob({ adapter, spec, timeoutMinutes: 1, store, runId, launch: unsandboxed })
    );
    expect(run.status).toBe('failed');
    expect(run.error).toContain('ENOENT');
  });

  it('times out and kills the process', async () => {
    const { store, runId } = await setup();
    const run = await Effect.runPromise(
      runJob({ adapter: node(hang, asText), spec, timeoutMinutes: 0.005, store, runId, launch: unsandboxed })
    );
    expect(run.status).toBe('timed-out');
    expect(alive(await pidOf(store, runId))).toBe(false);
  });

  it('records cancelled and kills the process on interrupt', async () => {
    const { store, runId } = await setup();
    const fiber = Effect.runFork(
      runJob({ adapter: node(hang, asText), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed })
    );
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
      runJob({ adapter: node(script, asText), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed, secrets })
    );
    expect(run).toMatchObject({ status: 'failed', error: 'bad ***' });
    expect((await store.events(runId)).map(r => r.event)).toEqual([{ type: 'text', text: 'the key is ***' }]);
    expect(readFileSync(join(store.home(runId), 'log.txt'), 'utf8')).toBe('key ***');
  });

  it('passes env to the harness without masking it', async () => {
    const { store, runId } = await setup();
    const script = `console.log('branch ' + process.env.BOTHUB_BRANCH);`;
    const env = { BOTHUB_BRANCH: 'bothub/7-long-name' };
    await Effect.runPromise(
      runJob({ adapter: node(script, asText), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed, env })
    );
    expect((await store.events(runId)).map(r => r.event)).toEqual([
      { type: 'text', text: 'branch bothub/7-long-name' },
    ]);
  });

  it('masks a secret in a binary home file without moving a byte', async () => {
    const { store, runId } = await setup();
    const script = `const e = process.env;
require('fs').writeFileSync(require('path').join(e.HOME, 'opencode.db'), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from('key ' + e.BOTHUB_LLM_API_KEY), Buffer.from([0, 200])]));`;
    const secrets = { BOTHUB_LLM_API_KEY: 'sk-secret-value-123' };
    await Effect.runPromise(
      runJob({ adapter: node(script, asText), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed, secrets })
    );
    const db = readFileSync(join(store.home(runId), 'opencode.db'));
    expect(db).toEqual(
      Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(`key ${'*'.repeat(19)}`), Buffer.from([0, 200])])
    );
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
    const script = `let i = 0; setInterval(() => console.log(i++), 1); ${orphanExit}`;
    const run = await Effect.runPromise(
      runJob({ adapter: node(script, loop), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed })
    );
    expect(run).toMatchObject({ status: 'failed', error: 'stuck: the same tool call and result 4 times in a row' });
    expect(await store.events(runId)).toHaveLength(8);
  });

  it('stops a harness that goes silent, and the process with it', async () => {
    const { store, runId } = await setup();
    const run = await Effect.runPromise(
      runJob({
        adapter: node(hang, asText),
        spec,
        timeoutMinutes: 1,
        stallMinutes: 0.01,
        store,
        runId,
        launch: unsandboxed,
      })
    );
    expect(run).toMatchObject({
      status: 'failed',
      stopped: 'stalled',
      error: 'stalled: no agent event for 0.01 minutes',
    });
    const pid = await pidOf(store, runId);
    await waitFor(async () => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  it('alerts on a stall and keeps the whole stderr, the last event, the exit and the env names of a failed run', async () => {
    const { store, runId } = await setup();
    const alerts: string[] = [];
    const stalled = await Effect.runPromise(
      runJob({
        adapter: node(hang, asText),
        spec,
        timeoutMinutes: 1,
        stallMinutes: 0.01,
        store,
        runId,
        launch: unsandboxed,
        onAlert: line => alerts.push(line),
      })
    );
    expect(alerts).toEqual([`ALERT stalled ${runId} 0.01`]);
    expect(stalled.lastEvent).toMatchObject({ type: 'text' });

    const next = await setup();
    const noisy = `console.log('hello'); console.error('x'.repeat(10000) + ' sk-secret-value-1'); process.exit(3);`;
    const run = await Effect.runPromise(
      runJob({
        adapter: node(noisy, asText),
        spec,
        timeoutMinutes: 1,
        store: next.store,
        runId: next.runId,
        secrets: { LLM_KEY: 'sk-secret-value-1' },
        env: { PLAIN: 'v' },
        launch: unsandboxed,
      })
    );
    expect(run).toMatchObject({ status: 'failed', exit: { code: 3 }, envNames: ['PLAIN', 'LLM_KEY'] });
    expect(run.lastEvent?.type).toBe('text');
    const log = readFileSync(join(next.store.home(next.runId), '..', 'stderr.log'), 'utf8');
    expect(log.length).toBeGreaterThan(10000);
    expect(log).not.toContain('sk-secret-value-1');
    expect(JSON.stringify(run)).not.toContain('sk-secret-value-1');
  });

  it('withdraws a run once its work is abandoned, and stops the process', async () => {
    const { store, runId } = await setup();
    const until = Effect.promise(() => waitFor(async () => (await store.events(runId)).length > 0)).pipe(
      Effect.as('#1 was closed')
    );
    const run = await Effect.runPromise(
      runJob({ adapter: node(hang, asText), spec, timeoutMinutes: 1, until, store, runId, launch: unsandboxed })
    );
    expect(run).toMatchObject({ status: 'cancelled', stopped: 'withdrawn', error: 'withdrawn: #1 was closed' });
    const pid = await pidOf(store, runId);
    await waitFor(async () => !alive(pid));
    expect(alive(pid)).toBe(false);
  });
});

describe('the sandbox', () => {
  const withEnv = async <T>(env: Record<string, string>, body: () => Promise<T>) => {
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      return await body();
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  };
  const marker = () => join(mkdtempSync(join(tmpdir(), 'bothub-marker-')), 'ran');
  const touching = (file: string) => node(`require('fs').writeFileSync(${JSON.stringify(file)}, 'x')`);
  const noDocker = () => ({ PATH: mkdtempSync(join(tmpdir(), 'bothub-empty-path-')) });

  it('counts docker exit 125 before any output as the sandbox failing', () => {
    expect(sandboxed.startFailed(Object.assign(new Error('x'), { exitCode: 125 }))).toBe(true);
    expect(unsandboxed.startFailed(Object.assign(new Error('x'), { exitCode: 125 }))).toBe(false);
  });

  it('fails a run as sandbox-failed when docker is unavailable, and nothing runs on the host', async () => {
    const { store, runId } = await setup();
    const file = marker();
    const run = await withEnv(noDocker(), () =>
      Effect.runPromise(runJob({ adapter: touching(file), spec, timeoutMinutes: 1, store, runId }))
    );
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^sandbox-failed: .*ENOENT/);
    expect(existsSync(file)).toBe(false);
  });

  it.each([{ BOTHUB_SANDBOX_IMAGE: '--privileged' }, { BOTHUB_SANDBOX_MEMORY: '0' }])(
    'fails a run as sandbox-failed with %o, and nothing runs on the host',
    async env => {
      const { store, runId } = await setup();
      const file = marker();
      const run = await withEnv(env, () =>
        Effect.runPromise(runJob({ adapter: touching(file), spec, timeoutMinutes: 1, store, runId }))
      );
      expect(run).toMatchObject({ status: 'failed', error: expect.stringMatching(/^sandbox-failed: BOTHUB_SANDBOX/) });
      expect(existsSync(file)).toBe(false);
    }
  );

  it('fails a script as sandbox-failed when docker is unavailable, and nothing runs on the host', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bothub-script-'));
    const file = marker();
    const result = await withEnv(noDocker(), () => runScript(`touch ${file}`, cwd, 1));
    expect(result).toMatchObject({ ok: false, output: expect.stringMatching(/^sandbox-failed: .*ENOENT/) });
    expect(existsSync(file)).toBe(false);
  });

  it('passes a launcher failure through as sandbox-failed', async () => {
    const { store, runId } = await setup();
    const broken: Launcher = { ...sandboxed, agent: () => Promise.reject(new Error('no daemon')) };
    const run = await Effect.runPromise(
      runJob({ adapter: node(''), spec, timeoutMinutes: 1, store, runId, launch: broken })
    );
    expect(run).toMatchObject({ status: 'failed', error: 'sandbox-failed: no daemon' });
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
    const run = await Effect.runPromise(
      runJob({ adapter: node(script), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed })
    );
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
      runJob({ adapter: node(`process.exit(2)`), spec, timeoutMinutes: 1, store, runId, launch: unsandboxed })
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
    expect(await runScript('echo "$BOTHUB_SECRET_PROBE" ok; pwd', cwd, 1, {}, unsandboxed)).toMatchObject({
      ok: true,
      output: expect.stringMatching(/^ok\n.*bothub-script-/),
    });
    delete process.env.BOTHUB_SECRET_PROBE;
    expect(await runScript('echo broke >&2; exit 2', cwd, 1, {}, unsandboxed)).toMatchObject({
      ok: false,
      output: 'broke',
    });
    expect(
      await runScript('echo "$BOTHUB_BRANCH"', cwd, 1, { BOTHUB_BRANCH: 'bothub/7-x' }, unsandboxed)
    ).toMatchObject({
      ok: true,
      output: 'bothub/7-x',
    });
  });

  it('gives every script an existing, writable HOME even when the host has none', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bothub-script-'));
    const host = process.env.HOME;
    delete process.env.HOME;
    const probe = `fs.accessSync(os.homedir(), fs.constants.W_OK); console.log(process.env.HOME)`;
    const result = await runScript(
      `node -e "const os = require('os'), fs = require('fs'); ${probe}"`,
      cwd,
      1,
      {
        HOME: '/no/such/home',
      },
      unsandboxed
    ).finally(() => {
      if (host !== undefined) process.env.HOME = host;
    });
    expect(result).toMatchObject({ ok: true, output: tmpdir() });
  });

  it('writes the input to stdin and returns the whole stdout apart from the output tail', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bothub-script-'));
    const result = await runScript('tr a-z A-Z; echo note >&2', cwd, 1, {}, unsandboxed, { input: 'one\ntwo\n' });
    expect(result).toEqual({ ok: true, output: 'ONE\nTWO\nnote', stdout: 'ONE\nTWO\n' });
  });

  it('strips terminal colors from the output tail, also when a sequence spans two writes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bothub-script-'));
    const script = `printf '\\033[3'; sleep 0.1; printf '2mgreen\\033[0m\\n'`;
    expect(await runScript(script, cwd, 1, {}, unsandboxed)).toMatchObject({ ok: true, output: 'green' });
    const long = `i=0; while [ $i -lt 8000 ]; do printf '\\033[32m.\\033[39m'; i=$((i+1)); done; echo; echo done`;
    expect(await runScript(long, cwd, 1, {}, unsandboxed)).toMatchObject({ ok: true, output: 'done' });
  });

  it('kills the script after the timeout', async () => {
    const result = await runScript('sleep 5', mkdtempSync(join(tmpdir(), 'bothub-script-')), 0.002, {}, unsandboxed);
    expect(result).toMatchObject({ ok: false, output: 'timed out after 0.002 minutes' });
  });
});

describe('limiter', () => {
  it('runs at most n jobs at once and keeps the rest queued', async () => {
    const a = await setup();
    const b = { store: a.store, runId: (await a.store.create((await a.store.read(a.runId))!)).id };
    const script = `console.log(${JSON.stringify(end(true))}); setTimeout(() => {}, 300);`;
    const job = (ids: typeof a) =>
      runJob({ adapter: node(script), spec, timeoutMinutes: 1, ...ids, launch: unsandboxed });

    const fiber = Effect.runFork(
      Effect.flatMap(limiter(1), limit => Effect.all([limit(job(a)), limit(job(b))], { concurrency: 'unbounded' }))
    );
    await waitFor(async () => (await a.store.read(a.runId))?.status === 'running');
    expect((await b.store.read(b.runId))?.status).toBe('queued');

    const [first, second] = await Effect.runPromise(Fiber.join(fiber));
    expect([first.status, second.status]).toEqual(['succeeded', 'succeeded']);
    expect(second.startedAt! >= first.endedAt!).toBe(true);
  });

  /** The most sessions that ran at once among `sessions`, each a 20 ms session run through `limiter(n)`. */
  const peaks = (n: number, sessions: Parameters<Effect.Effect.Success<ReturnType<typeof limiter>>>[1][]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const limit = yield* limiter(n);
        let running = 0;
        let peak = 0;
        const session = Effect.gen(function* () {
          peak = Math.max(peak, ++running);
          yield* Effect.sleep('20 millis');
          running--;
        });
        yield* Effect.all(
          sessions.map(who => limit(session, who)),
          { concurrency: 'unbounded' }
        );
        return peak;
      })
    );

  const SESSIONS = [
    ['job sessions share the pool', 1, [{}, {}], 1],
    ['a check does not wait behind a job', 1, [{}, { check: true }], 2],
    ['a bot without concurrency only has the pool', 4, [{ bot: { name: 'b' } }, { bot: { name: 'b' } }], 2],
    [
      'a bot with concurrency 1 runs one session at a time, jobs and checks together',
      4,
      [{ bot: { name: 'b', concurrency: 1 } }, { bot: { name: 'b', concurrency: 1 }, check: true }],
      1,
    ],
    [
      'other bots are not held by a capped one',
      4,
      [{ bot: { name: 'b', concurrency: 1 } }, { bot: { name: 'c', concurrency: 1 } }],
      2,
    ],
  ] as const;

  it.each(SESSIONS)('%s', async (_, n, sessions, peak) => {
    expect(await peaks(n, [...sessions])).toBe(peak);
  });
});
