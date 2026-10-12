import { spawn } from 'node:child_process';
import { Cause, Duration, Effect, Stream } from 'effect';
import type { EventRecord, Run, Store } from './store.ts';
import type { AgentEvent, ExecutorAdapter, RunSpec } from './types.ts';

const inherited = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER', 'TERM'];
const stderrLimit = 4096;

/** The child's environment: an allowlist of the host env, then the adapter's env, then explicit secrets. */
export const agentEnv = (adapterEnv: Record<string, string>, secrets: Record<string, string> = {}) => ({
  ...Object.fromEntries(inherited.flatMap(key => (process.env[key] ? [[key, process.env[key]]] : []))),
  ...adapterEnv,
  ...secrets,
});

/** Raw stdout of a child process; fails on spawn errors or a non-zero exit, and kills its process group on release. */
const output = (cmd: string, args: string[], cwd: string, env: Record<string, string>) =>
  Stream.asyncPush<Uint8Array, Error>(emit =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => emit.single(chunk));
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-stderrLimit);
        });
        const closed = new Promise<void>(resolve => {
          child.once('error', error => resolve(emit.fail(error)));
          child.once('close', code =>
            resolve(code === 0 ? emit.end() : emit.fail(new Error(stderr.trim() || `exited with code ${code}`)))
          );
        });
        return { child, closed };
      }),
      ({ child, closed }) =>
        Effect.promise(() => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {}
          return closed;
        })
    )
  );

/**
 * Spawns the adapter's command and streams its parsed output. Fails when the process cannot start or exits
 * non-zero; interrupting the stream kills the whole process group.
 */
export const agentEvents = (
  adapter: ExecutorAdapter,
  spec: RunSpec,
  secrets?: Record<string, string>
): Stream.Stream<AgentEvent, Error> =>
  Stream.suspend(() => {
    const { cmd, args, env } = adapter.command(spec);
    return output(cmd, args, spec.cwd, agentEnv(env, secrets)).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapConcat(adapter.parseLine)
    );
  });

/**
 * Runs one stored run to completion: marks it running, appends every event, and records the final status.
 * Never fails; interruption records `cancelled` after the process group is killed.
 */
export const runJob = (options: {
  adapter: ExecutorAdapter;
  spec: RunSpec;
  timeoutMinutes: number;
  store: Store;
  runId: string;
  secrets?: Record<string, string>;
  onEvent?: (record: EventRecord) => void;
}): Effect.Effect<Run> =>
  Effect.suspend(() => {
    const { adapter, spec, timeoutMinutes, store, runId, secrets, onEvent } = options;
    const save = (patch: Partial<Omit<Run, 'id'>>) => Effect.promise(() => store.update(runId, patch));
    const finish = (patch: Partial<Omit<Run, 'id'>>) => save({ ...patch, endedAt: new Date().toISOString() });

    let seq = 0;
    let end: Extract<AgentEvent, { type: 'end' }> | undefined;
    let firstError: string | undefined;
    const record = (event: AgentEvent) => {
      if (event.type === 'end') end = event;
      if (event.type === 'error') firstError ??= event.message;
      const entry = { ts: new Date().toISOString(), seq: seq++, event };
      onEvent?.(entry);
      return Effect.promise(() => store.append(runId, entry));
    };

    const reason = () => firstError ?? (end && !end.ok ? end.result : undefined);
    const usage = () => ({
      ...(end?.costUsd !== undefined && { costUsd: end.costUsd }),
      ...(end?.turns !== undefined && { turns: end.turns }),
    });

    return save({ status: 'running', startedAt: new Date().toISOString() }).pipe(
      Effect.zipRight(
        agentEvents(adapter, spec, secrets).pipe(
          Stream.runForEach(record),
          Effect.timeout(Duration.minutes(timeoutMinutes))
        )
      ),
      Effect.matchEffect({
        onSuccess: () =>
          end?.ok
            ? finish({ status: 'succeeded', ...usage() })
            : finish({
                status: 'failed',
                ...usage(),
                error: reason() ?? (end ? 'agent reported failure' : 'agent exited without a result'),
              }),
        onFailure: e =>
          Cause.isTimeoutException(e)
            ? finish({ status: 'timed-out', ...usage(), error: `timed out after ${timeoutMinutes} minutes` })
            : finish({ status: 'failed', ...usage(), error: reason() ?? e.message }),
      }),
      Effect.onInterrupt(() => finish({ status: 'cancelled', ...usage() }))
    );
  });

const scriptOutputLimit = 8192;

/**
 * Runs `script` with `sh -c` in `cwd` and the minimal agent env. Resolves to whether it exited 0 within the timeout,
 * with the tail of its combined output; never rejects.
 */
export const runScript = (script: string, cwd: string, timeoutMinutes: number) =>
  new Promise<{ ok: boolean; output: string }>(resolve => {
    const child = spawn('sh', ['-c', script], {
      cwd,
      env: agentEnv({}),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    let timedOut = false;
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-scriptOutputLimit);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMinutes * 60_000);
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.once('close', code => {
      clearTimeout(timer);
      const tail = timedOut ? `\ntimed out after ${timeoutMinutes} minutes` : '';
      resolve({ ok: code === 0 && !timedOut, output: (output + tail).trim() });
    });
  });

/** A limiter allowing at most `n` wrapped effects to run at once; waiting runs stay `queued`. */
export const limiter = (n = 1) => Effect.map(Effect.makeSemaphore(n), semaphore => semaphore.withPermits(1));
