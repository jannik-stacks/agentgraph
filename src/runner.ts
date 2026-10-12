import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cause, Duration, Effect, Stream } from 'effect';
import {
  bothubArg,
  containerEnv,
  containerName,
  dockerRun,
  gitMounts,
  inside,
  sandboxDefaults,
  sandboxFrom,
  specInside,
  type Sandbox,
} from './sandbox.ts';
import type { EventRecord, Run, Store } from './store.ts';
import type { AgentEvent, ExecutorAdapter, RunSpec } from './types.ts';

const inherited = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER', 'TERM'];
const stderrLimit = 4096;

/**
 * A private home for one run: `HOME` and the XDG base directories all live under `home`, so harness
 * sessions and transcripts stay out of the operator's home directory.
 */
export const homeEnv = (home: string, tmp: string) => ({
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  XDG_CACHE_HOME: join(home, '.cache'),
  TMPDIR: tmp,
});

/** Creates every directory `homeEnv` points at. */
const makeHome = (env: ReturnType<typeof homeEnv>) =>
  Promise.all(Object.values(env).map(dir => mkdir(dir, { recursive: true })));

/**
 * The child's environment: an allowlist of the host env, then the run's private home, then the adapter's env, then
 * explicit secrets.
 */
export const agentEnv = (
  adapterEnv: Record<string, string>,
  secrets: Record<string, string> = {},
  home: Record<string, string> = {}
) => ({
  ...Object.fromEntries(inherited.flatMap(key => (process.env[key] ? [[key, process.env[key]]] : []))),
  ...home,
  ...adapterEnv,
  ...secrets,
});

type Command = { cmd: string; args: string[]; env: Record<string, string>; cwd: string; stop?: () => void };

/** Removes a container whatever state it is in; killing the docker client alone would leave it running. */
const removeContainer = (name: string) => () => void execFile('docker', ['rm', '-f', name], () => {});

const kill = (pid: number | undefined) => {
  try {
    if (pid) process.kill(-pid, 'SIGKILL');
  } catch {}
};

/**
 * Raw stdout of a child process; fails on spawn errors or a non-zero exit, and kills its process group (and runs
 * `stop`) on release.
 */
const output = ({ cmd, args, cwd, env, stop }: Command) =>
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
            resolve(
              code === 0
                ? emit.end()
                : emit.fail(Object.assign(new Error(stderr.trim() || `exited with code ${code}`), { exitCode: code }))
            )
          );
        });
        return { child, closed };
      }),
      ({ child, closed }) =>
        Effect.promise(() => {
          kill(child.pid);
          stop?.();
          return closed;
        })
    )
  );

/**
 * A command inside a run container with `worktree` at `/work`. `home` is mounted as `/home/agent` (otherwise
 * `HOME` is the container's tmpfs `/tmp`); secrets travel by name, and the docker client gets the host allowlist.
 */
const contained = async ({
  name,
  worktree,
  home,
  mounts = [],
  env,
  secrets,
  cmd,
  args,
}: {
  name: string;
  worktree: string;
  home?: string | undefined;
  mounts?: Parameters<typeof dockerRun>[0]['mounts'];
  env: Record<string, string>;
  secrets?: Record<string, string>;
  cmd: string;
  args: string[];
}): Promise<Command> => {
  const container = containerName(name);
  const run = dockerRun({
    name: container,
    worktree,
    home,
    mounts: [...mounts, ...(await gitMounts(worktree))],
    env: { ...containerEnv(), ...(home ? homeEnv(inside.home, inside.tmp) : { HOME: inside.tmp }), ...env },
    ...(secrets && { secrets }),
    cmd,
    args,
  });
  return { ...run, env: agentEnv(run.env), cwd: worktree, stop: removeContainer(container) };
};

/**
 * The adapter's command inside a run container: the spec as seen from `/work`, the run home at `/home/agent` and
 * the sandbox's model proxy URL.
 */
export const containedCommand = (
  adapter: ExecutorAdapter,
  spec: RunSpec,
  secrets: Record<string, string> = {},
  home?: string
) => {
  const { spec: seen, mounts } = specInside(spec);
  const { cmd, args, env } = adapter.command(seen);
  return contained({
    name: adapter.name,
    worktree: spec.cwd,
    home,
    mounts,
    env,
    secrets: { ...secrets, BOTHUB_LLM_BASE_URL: sandboxDefaults().llmUrl },
    cmd,
    args: args.map(bothubArg),
  });
};

/**
 * Spawns the adapter's command, on the host or in a run container, and streams its parsed output. Fails when the
 * process cannot start or exits non-zero; interrupting the stream kills the process group and the container.
 */
export const agentEvents = (
  adapter: ExecutorAdapter,
  spec: RunSpec,
  secrets?: Record<string, string>,
  home?: ReturnType<typeof homeEnv>,
  sandbox: Sandbox = 'host'
): Stream.Stream<AgentEvent, Error> =>
  Stream.unwrap(
    Effect.promise(async (): Promise<Command> => {
      if (sandbox === 'docker') return containedCommand(adapter, spec, secrets, home?.HOME);
      const { cmd, args, env } = adapter.command(spec);
      return { cmd, args, cwd: spec.cwd, env: agentEnv(env, secrets, home) };
    }).pipe(
      Effect.map(command =>
        output(command).pipe(Stream.decodeText(), Stream.splitLines, Stream.mapConcat(adapter.parseLine))
      )
    )
  );

/** Replaces every secret value (8 characters or longer) in a text with `***`. */
export const masker = (values: string[]) => {
  const hidden = [...new Set(values.filter(value => value.length >= 8))];
  return (text: string) => hidden.reduce((masked, value) => masked.replaceAll(value, '***'), text);
};

const scrubLimit = 8 << 20;

/** Masks secrets in place in every file under `dir` that contains one. Never throws. */
const scrub = async (dir: string, mask: (text: string) => string) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter(entry => entry.isFile())
      .map(async entry => {
        const file = join(entry.parentPath, entry.name);
        if ((await stat(file)).size > scrubLimit) return;
        const text = await readFile(file, 'utf8');
        const masked = mask(text);
        if (masked !== text) await writeFile(file, masked);
      })
  ).catch(() => {});
};

const stuckPairs = 4;
const stuckErrors = 3;

/**
 * Watches a run's events for a loop: the same tool call with the same result 4 times in a row, or the same error 3
 * times in a row. Returns the reason once it sees one.
 */
export const stuckWatch = () => {
  const calls = new Map<string, string>();
  const streak = { pair: '', pairs: 0, error: '', errors: 0 };
  return (event: AgentEvent): string | undefined => {
    if (event.type === 'tool_call') calls.set(event.id, JSON.stringify([event.tool, event.input]));
    if (event.type === 'tool_result') {
      const pair = JSON.stringify([calls.get(event.id), event.ok, event.output]);
      streak.pairs = pair === streak.pair ? streak.pairs + 1 : 1;
      streak.pair = pair;
      if (streak.pairs >= stuckPairs) return `the same tool call and result ${stuckPairs} times in a row`;
    }
    if (event.type === 'error') {
      streak.errors = event.message === streak.error ? streak.errors + 1 : 1;
      streak.error = event.message;
      if (streak.errors >= stuckErrors) return `the same error ${stuckErrors} times in a row: ${event.message}`;
    }
  };
};

/**
 * Runs one stored run to completion: marks it running, appends every event, and records the final status.
 * The harness gets the run's own `home/`, kept afterwards, and `tmp/`, removed afterwards. `sandbox` defaults to
 * `BOTHUB_SANDBOX`. Secret values are masked in stored events, errors and the home's files. A run caught in a loop
 * (see `stuckWatch`) is stopped with `stuck: …`; a container that never started fails with `sandbox-failed: …`.
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
  sandbox?: Sandbox;
}): Effect.Effect<Run> =>
  Effect.suspend(() => {
    const { adapter, spec, timeoutMinutes, store, runId, secrets, onEvent, sandbox = sandboxFrom() } = options;
    const save = (patch: Partial<Omit<Run, 'id'>>) => Effect.promise(() => store.update(runId, patch));
    const finish = (patch: Partial<Omit<Run, 'id'>>) => save({ ...patch, endedAt: new Date().toISOString() });

    const mask = masker(Object.values(secrets ?? {}));
    const watch = stuckWatch();
    let seq = 0;
    let end: Extract<AgentEvent, { type: 'end' }> | undefined;
    let firstError: string | undefined;
    let stuck: string | undefined;
    const record = (raw: AgentEvent) => {
      const event = JSON.parse(mask(JSON.stringify(raw))) as AgentEvent;
      if (event.type === 'end') end = event;
      if (event.type === 'error') firstError ??= event.message;
      const entry = { ts: new Date().toISOString(), seq: seq++, event };
      onEvent?.(entry);
      stuck ??= watch(event);
      return Effect.promise(() => store.append(runId, entry)).pipe(
        Effect.zipRight(stuck ? Effect.fail(new Error(stuck)) : Effect.void)
      );
    };
    const sandboxFailed = (e: Error & { exitCode?: number; code?: unknown }) =>
      sandbox === 'docker' && seq === 0 && (e.exitCode === 125 || typeof e.code === 'string');

    const reason = () => firstError ?? (end && !end.ok ? end.result : undefined);
    const usage = () => ({
      ...(end?.costUsd !== undefined && { costUsd: end.costUsd }),
      ...(end?.turns !== undefined && { turns: end.turns }),
    });

    const home = homeEnv(store.home(runId), store.tmp(runId));
    return save({ status: 'running', startedAt: new Date().toISOString() }).pipe(
      Effect.zipRight(Effect.tryPromise({ try: () => makeHome(home), catch: e => e as Error })),
      Effect.zipRight(
        agentEvents(adapter, spec, secrets, home, sandbox).pipe(
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
        onFailure: e => {
          if (Cause.isTimeoutException(e))
            return finish({ status: 'timed-out', ...usage(), error: `timed out after ${timeoutMinutes} minutes` });
          if (stuck) return finish({ status: 'failed', ...usage(), error: `stuck: ${stuck}` });
          if (sandboxFailed(e)) return finish({ status: 'failed', error: `sandbox-failed: ${mask(e.message)}` });
          return finish({ status: 'failed', ...usage(), error: mask(reason() ?? e.message) });
        },
      }),
      Effect.onInterrupt(() => finish({ status: 'cancelled', ...usage() })),
      Effect.ensuring(
        Effect.promise(() => Promise.all([rm(home.TMPDIR, { recursive: true, force: true }), scrub(home.HOME, mask)]))
      )
    );
  });

const scriptOutputLimit = 8192;

/**
 * Runs `script` with `sh -c` in `cwd` with the minimal agent env plus `env`, in a run container when `sandbox` (default
 * `BOTHUB_SANDBOX`) is `docker`. Resolves to whether it exited 0 within the timeout, with the tail of its combined
 * output; never rejects.
 */
export const runScript = async (
  script: string,
  cwd: string,
  timeoutMinutes: number,
  env: Record<string, string> = {},
  sandbox = sandboxFrom()
) => {
  const command: Command =
    sandbox === 'docker'
      ? await contained({ name: 'script', worktree: cwd, env, cmd: 'sh', args: ['-c', script] })
      : { cmd: 'sh', args: ['-c', script], cwd, env: agentEnv(env) };
  return new Promise<{ ok: boolean; output: string }>(resolve => {
    const child = spawn(command.cmd, command.args, {
      cwd: command.cwd,
      env: command.env,
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
      kill(child.pid);
      command.stop?.();
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
};

/** A limiter allowing at most `n` wrapped effects to run at once; waiting runs stay `queued`. */
export const limiter = (n = 1) => Effect.map(Effect.makeSemaphore(n), semaphore => semaphore.withPermits(1));
