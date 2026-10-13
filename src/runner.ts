import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { loadedMarker } from './harnesses/opencode-surfacer.ts';
import { Cause, Duration, Effect, Stream } from 'effect';
import {
  bothubArg,
  bothubPaths,
  containerEnv,
  containerName,
  depsMounts,
  dockerRun,
  gitMounts,
  inside,
  sandboxConfig,
  SandboxError,
  sandboxReady,
  specInside,
} from './sandbox.ts';
import type { EventRecord, Run, Store } from './store.ts';
import type { AgentEvent, HarnessAdapter, RunSpec } from './types.ts';

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
 * A command inside a run container with `worktree` at `/work`, read-only with `readonly`. `home` is mounted as
 * `/home/agent` (otherwise `HOME` is the container's tmpfs `/tmp`); secrets travel by name, and the docker client gets
 * the host allowlist.
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
  stdin,
  readonly = false,
}: {
  name: string;
  worktree: string;
  home?: string | undefined;
  mounts?: Parameters<typeof dockerRun>[0]['mounts'];
  env: Record<string, string>;
  secrets?: Record<string, string>;
  cmd: string;
  args: string[];
  stdin?: boolean;
  readonly?: boolean;
}): Promise<Command> => {
  const config = sandboxConfig();
  await sandboxReady(config);
  const container = containerName(name);
  const run = dockerRun({
    config,
    name: container,
    worktree,
    home,
    mounts: [...mounts, ...(await gitMounts(worktree, readonly)), ...(await depsMounts(worktree, readonly))],
    env: { ...containerEnv(), ...(home ? homeEnv(inside.home, inside.tmp) : { HOME: inside.tmp }), ...env },
    ...(secrets && { secrets }),
    cmd,
    args,
    ...(stdin && { stdin }),
    readonly,
  });
  return { ...run, env: agentEnv(run.env), cwd: worktree, stop: removeContainer(container) };
};

/**
 * The adapter's command inside a run container: the spec as seen from `/work`, the run home at `/home/agent` and
 * the sandbox's model proxy URL.
 */
export const containedCommand = (
  adapter: HarnessAdapter,
  spec: RunSpec,
  secrets: Record<string, string> = {},
  home?: string,
  readonly = false
) => {
  const { spec: seen, mounts } = specInside(spec);
  const { cmd, args, env } = adapter.command(seen);
  return contained({
    name: adapter.name,
    worktree: spec.cwd,
    home,
    readonly,
    mounts,
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, bothubPaths(value)])),
    secrets: { ...secrets, BOTHUB_LLM_BASE_URL: sandboxConfig().llmUrl },
    cmd,
    args: args.map(bothubArg),
  });
};

/** What a script sees besides its worktree: the `hub` directory, read-only, and whether the worktree is `readonly`. */
export type ScriptAccess = { hub?: string | undefined; readonly?: boolean };

/**
 * How commands are started. Every real run uses `sandboxed`; `startFailed` tells whether an error before any output
 * means the launcher itself failed.
 */
export type Launcher = {
  agent: (
    adapter: HarnessAdapter,
    spec: RunSpec,
    secrets?: Record<string, string>,
    home?: ReturnType<typeof homeEnv>,
    readonly?: boolean
  ) => Promise<Command>;
  script: (script: string, cwd: string, env: Record<string, string>, access?: ScriptAccess) => Promise<Command>;
  startFailed: (error: Error & { exitCode?: number; code?: unknown }) => boolean;
};

/** Starts every command in a hardened run container; fails when the sandbox is unavailable. */
export const sandboxed: Launcher = {
  agent: (adapter, spec, secrets, home, readonly) => containedCommand(adapter, spec, secrets, home?.HOME, readonly),
  script: (script, cwd, env, { hub, readonly } = {}) =>
    contained({
      name: 'script',
      worktree: cwd,
      mounts: hub ? [{ src: hub, dst: inside.hub, readonly: true }] : [],
      env: { ...env, ...(hub && { BOTHUB_HUB: inside.hub }) },
      cmd: 'sh',
      args: ['-c', script],
      stdin: true,
      ...(readonly && { readonly }),
    }),
  startFailed: error => error.exitCode === 125 || typeof error.code === 'string',
};

/**
 * Starts commands directly on this machine with a private home and an allowlisted env, without isolation. Only for
 * tests and the simulator, whose harnesses are scripted and run no agent.
 */
export const unsandboxed: Launcher = {
  agent: async (adapter, spec, secrets, home) => {
    const { cmd, args, env } = adapter.command(spec);
    return { cmd, args, cwd: spec.cwd, env: agentEnv(env, secrets, home) };
  },
  script: async (script, cwd, env, { hub } = {}) => ({
    cmd: 'sh',
    args: ['-c', script],
    cwd,
    env: agentEnv({ ...env, ...(hub && { BOTHUB_HUB: hub }) }),
  }),
  startFailed: () => false,
};

/**
 * Starts the adapter's command through `launch` and streams its parsed output. Fails when the process cannot start
 * or exits non-zero; interrupting the stream kills the process group and the container.
 */
export const agentEvents = (
  adapter: HarnessAdapter,
  spec: RunSpec,
  secrets?: Record<string, string>,
  home?: ReturnType<typeof homeEnv>,
  launch: Launcher = sandboxed,
  readonly = false
): Stream.Stream<AgentEvent, Error> =>
  Stream.unwrap(
    Effect.tryPromise({
      try: () => launch.agent(adapter, spec, secrets, home, readonly),
      catch: e => (e instanceof SandboxError ? e : new SandboxError((e as Error).message)),
    }).pipe(
      Effect.map(command => {
        let started = !adapter.start;
        const parse = (line: string) => {
          const events = adapter.parseLine(line);
          if (started) return events;
          started = true;
          return [...(adapter.start?.(spec) ?? []), ...events];
        };
        return output(command).pipe(Stream.decodeText(), Stream.splitLines, Stream.mapConcat(parse));
      })
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
 * The harness gets the run's own `home/`, kept afterwards, and `tmp/`, removed afterwards, and runs in the sandbox.
 * Secret values are masked in stored events, errors and the home's files. A run caught in a loop
 * (see `stuckWatch`) is stopped with `stuck: …`; a sandbox that is unavailable or a container that never started fails with
 * `sandbox-failed: …`, and nothing runs on the host.
 * Never fails; interruption records `cancelled` after the process group is killed.
 */
export const runJob = (options: {
  adapter: HarnessAdapter;
  spec: RunSpec;
  timeoutMinutes: number;
  store: Store;
  runId: string;
  secrets?: Record<string, string>;
  onEvent?: (record: EventRecord) => void;
  launch?: Launcher;
  readonly?: boolean;
}): Effect.Effect<Run> =>
  Effect.suspend(() => {
    const { adapter, spec, timeoutMinutes, store, runId, secrets, onEvent, launch = sandboxed, readonly } = options;
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
      e instanceof SandboxError || (seq === 0 && launch.startFailed(e));

    const reason = () => firstError ?? (end && !end.ok ? end.result : undefined);
    const usage = () => ({
      ...(end?.costUsd !== undefined && { costUsd: end.costUsd }),
      ...(end?.turns !== undefined && { turns: end.turns }),
    });

    const home = homeEnv(store.home(runId), store.tmp(runId));
    const unloaded = () =>
      Effect.promise(async () => {
        const missing: string[] = [];
        for (const id of adapter.plugins?.(spec) ?? [])
          if (!(await stat(loadedMarker(home.HOME, id)).catch(() => undefined))) missing.push(id);
        return missing;
      });
    return save({ status: 'running', startedAt: new Date().toISOString() }).pipe(
      Effect.zipRight(Effect.tryPromise({ try: () => makeHome(home), catch: e => e as Error })),
      Effect.zipRight(
        agentEvents(adapter, spec, secrets, home, launch, readonly).pipe(
          Stream.runForEach(record),
          Effect.timeout(Duration.minutes(timeoutMinutes))
        )
      ),
      Effect.matchEffect({
        onSuccess: () =>
          end?.ok
            ? Effect.flatMap(unloaded(), missing =>
                missing.length
                  ? finish({ status: 'failed', ...usage(), error: `plugin ${missing.join(', ')} did not load` })
                  : finish({ status: 'succeeded', ...usage() })
              )
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
const scriptRawLimit = 64 << 10;
const scriptStdoutLimit = 4 << 20;

/** How a script ended: exited 0 or not, its output tail and stdout, and whether it never ran or ran out of time. */
export type ScriptResult = { ok: boolean; output: string; stdout: string; sandboxFailed?: true; timedOut?: true };

/**
 * Runs `script` with `sh -c` in a run container with `cwd` as its worktree, read-only with `readonly`, and the
 * minimal agent env plus `env`. A `hub` directory is mounted read-only and named by `BOTHUB_HUB`, so a script can
 * run the hub's own scripts. `input` is written to its stdin. Resolves to whether it exited 0 within the timeout,
 * with the tail of its combined output with terminal colors stripped, and its stdout up to 4 MB; a sandbox that is
 * unavailable resolves to `sandbox-failed: …` without running anything. Never rejects.
 */
export const runScript = async (
  script: string,
  cwd: string,
  timeoutMinutes: number,
  env: Record<string, string> = {},
  launch: Launcher = sandboxed,
  { input = '', ...access }: ScriptAccess & { input?: string } = {}
): Promise<ScriptResult> => {
  const failed = (message: string): ScriptResult => ({
    ok: false,
    output: `sandbox-failed: ${message}`,
    stdout: '',
    sandboxFailed: true,
  });
  const command = await launch.script(script, cwd, env, access).catch((error: Error) => error);
  if (command instanceof Error) return failed(command.message);
  return new Promise<ScriptResult>(resolve => {
    const child = spawn(command.cmd, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    let raw = '';
    let cut = false;
    let stdout = '';
    let timedOut = false;
    const add = (chunk: Buffer) => {
      raw += chunk.toString();
      if (raw.length <= scriptRawLimit) return;
      raw = raw.slice(-scriptRawLimit);
      cut = true;
    };
    const shown = () =>
      stripVTControlCharacters(cut ? raw.slice(raw.indexOf('\n') + 1) : raw).slice(-scriptOutputLimit);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < scriptStdoutLimit) stdout += chunk.toString();
      add(chunk);
    });
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child.pid);
      command.stop?.();
    }, timeoutMinutes * 60_000);
    child.once('error', error => {
      clearTimeout(timer);
      resolve(launch.startFailed(error) ? failed(error.message) : { ok: false, output: error.message, stdout: '' });
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 125 && launch.startFailed({ name: 'exit', message: '', exitCode: 125 }))
        return resolve(failed(shown().trim() || 'the container did not start'));
      const tail = timedOut ? `\ntimed out after ${timeoutMinutes} minutes` : '';
      resolve({
        ok: code === 0 && !timedOut,
        output: (shown() + tail).trim(),
        stdout,
        ...(timedOut && { timedOut }),
      });
    });
  });
};

/** A limiter allowing at most `n` wrapped effects to run at once (4 by default); waiting runs stay `queued`. */
export const limiter = (n = 4) => Effect.map(Effect.makeSemaphore(n), semaphore => semaphore.withPermits(1));
