import { execFile, spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  type Box,
} from './sandbox.ts';
import type { Defined } from './config.ts';
import type { Bot } from './schema.ts';
import type { EventRecord, Run, Stopped, Store } from './store.ts';
import type { AgentEvent, HarnessAdapter, RunSpec } from './types.ts';

/** Errors that mean the provider refused the run for now: rate and usage limits, quotas, overload. */
export const providerLimit = /\b(429|rate[ -]?limit|usage limit|quota|overloaded)\b/i;

/**
 * Errors a later run may not meet: provider limits and overload, server errors, dropped or idle connections and
 * tool calls the model server could not parse.
 */
export const providerFault = new RegExp(
  `${providerLimit.source}|\\b(?:(?:http|status)[ :]*5\\d\\d|internal server error|service unavailable|bad gateway|terminated|econnreset|econnrefused|socket hang up|fetch failed|other side closed|idle timeout|timed? ?out|midstreamfallbackerror|error parsing tool call|xml syntax error|unexpected response from ollama|no deployments available)\\b`,
  'i'
);

/**
 * When a provider limit resets, read from a `Limit resets at: <UTC date and time>` line in its error, or from a
 * `retry-after: <seconds>` or `try again in <seconds>` in it.
 */
export const resetOf = (error = '', now = Date.now()) => {
  const at = /resets? at:?\s*(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/i.exec(error);
  if (at) return new Date(`${at[1]}T${at[2]}Z`);
  const after = /(?:retry[- ]after|try again in):?\s*(\d+(?:\.\d+)?)/i.exec(error);
  return after ? new Date(now + Number(after[1]) * 1000) : undefined;
};

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

/** Creates every directory `homeEnv` points at, then the files and links the harness finds in its home. */
const makeHome = async (env: ReturnType<typeof homeEnv>, { home = {}, links = {} }: HarnessAdapter) => {
  await Promise.all(Object.values(env).map(dir => mkdir(dir, { recursive: true })));
  for (const [path, text] of Object.entries(home)) {
    await mkdir(dirname(join(env.HOME, path)), { recursive: true });
    await writeFile(join(env.HOME, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    await rm(join(env.HOME, path), { recursive: true, force: true });
    await mkdir(dirname(join(env.HOME, path)), { recursive: true });
    await symlink(target, join(env.HOME, path));
  }
};

/** The spec to run: with the earlier run's sessions copied into the new home, or without a session to continue. */
const handOver = async (adapter: HarnessAdapter, spec: RunSpec, home: string): Promise<RunSpec> => {
  const { session, ...rest } = spec;
  if (!session || !adapter.sessions) return rest;
  const from = join(session.home, adapter.sessions);
  if (!(await stat(from).catch(() => undefined))) return rest;
  await cp(from, join(home, adapter.sessions), { recursive: true });
  return spec;
};

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

type Command = {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stop?: () => void;
  busy?: () => Promise<boolean>;
};

/** Removes a container whatever state it is in; killing the docker client alone would leave it running. */
const removeContainer = (name: string) => () => void execFile('docker', ['rm', '-f', name], () => {});

/**
 * Whether a container's tools did work since the last call: the processes below the harness (parent pid above 1, which
 * leaves out the init, the harness itself and the probe) differ in pid or CPU time. A harness waiting on a model call
 * with no tool running is idle; so is a failed probe or one that takes over 30 seconds. The first call with tools
 * running says busy.
 */
export const busyProbe = (container: string) => {
  let last: string | undefined;
  return () =>
    new Promise<boolean>(resolve =>
      execFile('docker', ['exec', container, 'ps', '-eo', 'pid=,ppid=,time='], { timeout: 30_000 }, (error, stdout) => {
        if (error) return resolve(false);
        const seen = stdout
          .split('\n')
          .filter(line => Number(line.trim().split(/\s+/)[1]) > 1)
          .join('\n');
        resolve(seen !== '' && seen !== last);
        last = seen;
      })
    );
};

const kill = (pid: number | undefined) => {
  try {
    if (pid) process.kill(-pid, 'SIGKILL');
  } catch {}
};

type Exited = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };

/**
 * Starts `command` in its own process group, writing `input` to its stdin when given. `closed` resolves once it
 * exits or fails to start; `stop` kills the group and runs the command's own `stop`.
 */
const start = (
  command: Command,
  on: { stdout: (chunk: Buffer) => void; stderr: (chunk: Buffer) => void },
  input?: string
) => {
  const child = spawn(command.cmd, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
  child.stdout?.on('data', on.stdout);
  child.stderr?.on('data', on.stderr);
  const closed = new Promise<Exited>(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stop = () => {
    kill(child.pid);
    command.stop?.();
  };
  return { closed, stop };
};

/** Raw stdout of a child process; fails on spawn errors or a non-zero exit, and stops it on release. */
const output = (command: Command, sink?: (text: string) => void) =>
  Stream.asyncPush<Uint8Array, Error>(emit =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let stderr = '';
        const { closed, stop } = start(command, {
          stdout: chunk => emit.single(chunk),
          stderr: chunk => {
            sink?.(chunk.toString());
            stderr = (stderr + chunk.toString()).slice(-stderrLimit);
          },
        });
        const ended = closed.then(exit =>
          'error' in exit
            ? emit.fail(exit.error)
            : exit.code === 0
              ? emit.end()
              : emit.fail(
                  Object.assign(new Error(stderr.trim() || `exited with code ${exit.code}`), {
                    exitCode: exit.code,
                    signal: exit.signal,
                  })
                )
        );
        return { ended, stop };
      }),
      ({ ended, stop }) =>
        Effect.promise(() => {
          stop();
          return ended;
        })
    )
  );

/**
 * A command inside a run container with `worktree` at `/work`, read-only with `readonly`. `home` is mounted as
 * `/home/agent` (otherwise `HOME` is the container's tmpfs `/tmp`), and `env` cannot move it; secrets travel by name, and the docker client gets
 * the host allowlist. `box` is what the hub changes in the container.
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
  box = {},
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
  box?: Box;
}): Promise<Command> => {
  const config = { ...sandboxConfig(), ...box.config };
  await sandboxReady(config, box.open);
  const container = containerName(name);
  const run = dockerRun({
    config,
    name: container,
    worktree,
    home,
    mounts: [...mounts, ...(await gitMounts(worktree, readonly)), ...(await depsMounts(worktree, readonly))],
    env: {
      ...box.env,
      ...containerEnv(process.env, box.open),
      ...env,
      ...(home ? homeEnv(inside.home, inside.tmp) : { HOME: inside.tmp }),
    },
    ...(secrets && { secrets }),
    cmd,
    args,
    ...(stdin && { stdin }),
    readonly,
    open: !!box.open,
    cache: box.cache,
  });
  return {
    ...run,
    env: agentEnv(run.env),
    cwd: worktree,
    stop: removeContainer(container),
    busy: busyProbe(container),
  };
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
  readonly = false,
  box?: Box
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
    ...(box && { box }),
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

/**
 * Starts every command in a hardened run container, changed by the `box` it resolves first; fails when the sandbox is
 * unavailable.
 */
export const sandboxedWith = (box: () => Promise<Box> = async () => ({})): Launcher => ({
  agent: async (adapter, spec, secrets, home, readonly) =>
    containedCommand(adapter, spec, secrets, home?.HOME, readonly, await box()),
  script: async (script, cwd, env, { hub, readonly } = {}) =>
    contained({
      name: 'script',
      worktree: cwd,
      mounts: hub ? [{ src: hub, dst: inside.hub, readonly: true }] : [],
      env: { ...env, ...(hub && { BOTHUB_HUB: inside.hub }) },
      cmd: 'sh',
      args: ['-c', script],
      stdin: true,
      ...(readonly && { readonly }),
      box: await box(),
    }),
  startFailed: error => error.exitCode === 125 || typeof error.code === 'string',
});

/** Starts every command in the base sandbox. */
export const sandboxed = sandboxedWith();

/**
 * Starts commands directly on this machine with a private home and an allowlisted env, without isolation; scripts get
 * the system temp directory as `HOME` and `TMPDIR`. Only for tests and the simulator, whose harnesses are scripted and
 * run no agent.
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
    env: agentEnv({ ...env, ...(hub && { BOTHUB_HUB: hub }), HOME: tmpdir(), TMPDIR: tmpdir() }),
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
  readonly = false,
  sink?: (text: string) => void
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
          const first = adapter.start?.(spec, line) ?? [];
          started = first.length > 0;
          return [...first, ...events];
        };
        return output(command, sink).pipe(Stream.decodeText(), Stream.splitLines, Stream.mapConcat(parse));
      })
    )
  );

/** Replaces every secret value (8 characters or longer) in a text with `***`. */
export const masker = (values: string[]) => {
  const hidden = [...new Set(values.filter(value => value.length >= 8))];
  return (text: string) => hidden.reduce((masked, value) => masked.replaceAll(value, '***'), text);
};

/**
 * Appends text to `file` in order, masking whole lines, so a secret split across two texts is masked too; `close`
 * writes the unfinished last line and ends the file. The file is created on the first text.
 */
const maskedLog = (file: string, mask: (text: string) => string) => {
  let out: WriteStream | undefined;
  let rest = '';
  const write = (text: string) =>
    (out ??= createWriteStream(file, { flags: 'a' }).on('error', () => {})).write(mask(text));
  return {
    add: (text: string) => {
      const end = (rest += text).lastIndexOf('\n') + 1;
      if (!end) return;
      write(rest.slice(0, end));
      rest = rest.slice(end);
    },
    close: () =>
      new Promise<void>(done => {
        if (rest) write(rest);
        rest = '';
        if (!out || out.closed) return done();
        out.end().once('close', () => done());
      }),
  };
};

const scrubLimit = 8 << 20;

/** Masks secrets in place in every file under `dir` that contains one, a binary file without moving a byte. Never throws. */
const scrub = async (dir: string, secrets: string[]) => {
  const mask = masker(secrets);
  const hidden = secrets.filter(value => value.length >= 8).map(value => Buffer.from(value).toString('latin1'));
  const sameLength = (bytes: string) =>
    hidden.reduce((out, value) => out.replaceAll(value, '*'.repeat(value.length)), bytes);
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter(entry => entry.isFile())
      .map(async entry => {
        const file = join(entry.parentPath, entry.name);
        if ((await stat(file)).size > scrubLimit) return;
        const content = await readFile(file);
        const binary = content.includes(0);
        const text = content.toString(binary ? 'latin1' : 'utf8');
        const masked = binary ? sameLength(text) : mask(text);
        if (masked !== text) await writeFile(file, masked, binary ? 'latin1' : 'utf8');
      })
  ).catch(() => {});
};

const stuckPairs = 4;
const stuckErrors = 3;
const stuckRepeats = 3;
const edits = /edit|write|patch/i;
const writes =
  /(^|[^\d&])>(?!&|\s*\/dev\/null)|\b(sed|perl) -i|\btee\b|\bgit (apply|checkout|restore|stash|reset)\b|\b(mv|cp|rm|touch|patch)\b/;

/**
 * Watches a run's events for a loop: the same tool call with the same result 4 times in a row, the same error 3 times
 * in a row, or the same shell command run again 3 times with nothing edited since its first run. Returns the reason
 * once it sees one.
 */
export const stuckWatch = () => {
  const calls = new Map<string, string>();
  const streak = { pair: '', pairs: 0, error: '', errors: 0 };
  const repeats = new Map<string, number>();
  return (event: AgentEvent): string | undefined => {
    if (event.type === 'tool_call') {
      calls.set(event.id, JSON.stringify([event.tool, event.input]));
      const input = event.input as { command?: unknown } | undefined;
      const command = /^bash$/i.test(event.tool) && typeof input?.command === 'string' ? input.command : undefined;
      if (edits.test(event.tool) || (command && writes.test(command))) repeats.clear();
      if (command) {
        const n = repeats.has(command) ? repeats.get(command)! + 1 : 0;
        repeats.set(command, n);
        if (n >= stuckRepeats) return `the same command ${n + 1} times with no edit between: ${command.slice(0, 200)}`;
      }
    }
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

/** How long a silent run that still shows work is waited for. */
const busyLimit = 30 * 60_000;

class Stalled extends Error {}
class Withdrawn extends Error {}
class HumanStop extends Error {}

/** The system prompt and prompt a harness gets, as `prompt.md` in the run directory. */
export const promptFile = ({ system, prompt }: Pick<RunSpec, 'system' | 'prompt'>) =>
  `# System\n\n${system}\n\n# Prompt\n\n${prompt}\n`;

/** What `until` resolves with when a human stops the run. */
export const stoppedByHuman = Symbol('stopped by a human');

/**
 * Runs one stored run to completion: marks it running, appends every event, and records the final status.
 * The harness gets the run's own `home/`, kept afterwards, and `tmp/`, removed afterwards, and runs in the sandbox.
 * What it was asked is kept as `prompt.md` (see `promptFile`).
 * Secret values are masked in stored events, errors and the home's files; `env` reaches the harness unmasked. A run caught in a loop
 * (see `stuckWatch`) is stopped with `stuck: …`; a sandbox that is unavailable or a container that never started fails with
 * `sandbox-failed: …`, and nothing runs on the host. A harness silent for `stallMinutes` fails as stalled, unless its
 * sandbox still shows work (a long tool), which is waited out for up to 30 minutes. One whose tool
 * call stays open that long while only usage events come fails the same way. A run is cancelled as withdrawn once `until`
 * resolves with a reason. Each of these, a timeout and a provider fault (see `providerFault`) are recorded as the
 * run's `stopped`.
 * Never fails; interruption records `cancelled` after the process group is killed.
 */
export const runJob = (options: {
  adapter: HarnessAdapter;
  spec: RunSpec;
  timeoutMinutes: number;
  store: Store;
  runId: string;
  secrets?: Record<string, string>;
  env?: Record<string, string>;
  onEvent?: (record: EventRecord) => void;
  launch?: Launcher;
  readonly?: boolean;
  stallMinutes?: number;
  until?: Effect.Effect<string | typeof stoppedByHuman>;
}): Effect.Effect<Run> =>
  Effect.suspend(() => {
    const { adapter, spec, timeoutMinutes, store, runId, secrets, onEvent, launch = sandboxed, readonly } = options;
    const { stallMinutes, until, env } = options;
    let busy: Command['busy'];
    const launcher: Launcher = {
      ...launch,
      agent: async (...args) => {
        const command = await launch.agent(...args);
        busy = command.busy;
        return command;
      },
    };
    const save = (patch: Partial<Omit<Run, 'id'>>) => Effect.promise(() => store.update(runId, patch));
    const finish = (patch: Partial<Omit<Run, 'id'>>) => {
      const stopped = patch.stopped ?? (providerFault.test(patch.error ?? '') ? 'provider' : undefined);
      const failed = patch.status !== 'succeeded';
      return save({
        ...patch,
        ...(stopped && { stopped }),
        ...(failed && exit && { exit }),
        endedAt: new Date().toISOString(),
      });
    };

    const mask = masker(Object.values(secrets ?? {}));
    const stderr = maskedLog(join(store.home(runId), '..', 'stderr.log'), mask);
    const watch = stuckWatch();
    let seq = 0;
    let end: Extract<AgentEvent, { type: 'end' }> | undefined;
    let firstError: string | undefined;
    let stuck: string | undefined;
    let exit: Run['exit'];
    const tools = new Set<string>();
    let alive = Date.now();
    const silence = (ms: number): Effect.Effect<never, Stalled> =>
      Effect.suspend(() => {
        const left = alive + ms - Date.now();
        if (left > 0) return Effect.flatMap(Effect.sleep(left), () => silence(ms));
        if (!busy || Date.now() - alive >= busyLimit) return Effect.fail(new Stalled());
        return Effect.promise(busy).pipe(
          Effect.flatMap(working =>
            working ? Effect.flatMap(Effect.sleep(Math.min(ms, 60_000)), () => silence(ms)) : Effect.fail(new Stalled())
          )
        );
      });
    const record = (raw: AgentEvent) => {
      const event = JSON.parse(mask(JSON.stringify(raw))) as AgentEvent;
      if (event.type === 'tool_call') tools.add(event.id);
      if (event.type === 'tool_result') tools.delete(event.id);
      if (event.type !== 'usage' || !tools.size) alive = Date.now();
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
      Effect.zipRight(
        Effect.tryPromise({
          try: async () => {
            await makeHome(home, adapter);
            await writeFile(join(store.home(runId), '..', 'prompt.md'), mask(promptFile(spec)));
            return handOver(adapter, spec, home.HOME);
          },
          catch: e => e as Error,
        })
      ),
      Effect.flatMap(spec =>
        agentEvents(adapter, spec, { ...env, ...secrets }, home, launcher, readonly, stderr.add).pipe(
          events => (stallMinutes ? Stream.interruptWhen(events, silence(stallMinutes * 60_000)) : events),
          events =>
            until
              ? Stream.interruptWhen(
                  events,
                  Effect.flatMap(until, why =>
                    Effect.fail(why === stoppedByHuman ? new HumanStop() : new Withdrawn(why))
                  )
                )
              : events,
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
          const { exitCode, signal } = e as { exitCode?: number | null; signal?: string | null };
          if (exitCode != null || signal)
            exit = { ...(exitCode != null && { code: exitCode }), ...(signal && { signal }) };
          if (Cause.isTimeoutException(e))
            return finish({
              status: 'timed-out',
              stopped: 'timeout',
              ...usage(),
              error: `timed out after ${timeoutMinutes} minutes`,
            });
          if (stuck) return finish({ status: 'failed', stopped: 'stuck', ...usage(), error: `stuck: ${stuck}` });
          if (e instanceof Stalled)
            return finish({
              status: 'failed',
              stopped: 'stalled',
              ...usage(),
              error: `stalled: no agent event for ${stallMinutes} minutes`,
            });
          if (e instanceof HumanStop)
            return finish({ status: 'cancelled', stopped: 'human', ...usage(), error: 'stopped by a human' });
          if (e instanceof Withdrawn)
            return finish({ status: 'cancelled', stopped: 'withdrawn', ...usage(), error: `withdrawn: ${e.message}` });
          if (sandboxFailed(e))
            return finish({ status: 'failed', stopped: 'sandbox', error: `sandbox-failed: ${mask(e.message)}` });
          return finish({ status: 'failed', ...usage(), error: mask(reason() ?? e.message) });
        },
      }),
      Effect.onInterrupt(() => finish({ status: 'cancelled', ...usage() })),
      Effect.ensuring(
        Effect.promise(() =>
          Promise.all([
            stderr.close(),
            rm(home.TMPDIR, { recursive: true, force: true }),
            scrub(home.HOME, Object.values(secrets ?? {})),
          ])
        )
      )
    );
  });

const scriptOutputLimit = 8192;
const scriptRawLimit = 64 << 10;
const scriptStdoutLimit = 4 << 20;

/** How a script ended: exited 0 or not, its output tail and stdout, and whether it never ran or ran out of time. */
export type ScriptResult = {
  ok: boolean;
  output: string;
  stdout: string;
  stopped?: Extract<Stopped, 'sandbox' | 'timeout'>;
};

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
    stopped: 'sandbox',
  });
  const command = await launch.script(script, cwd, env, access).catch((error: Error) => error);
  if (command instanceof Error) return failed(command.message);
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
  const shown = () => stripVTControlCharacters(cut ? raw.slice(raw.indexOf('\n') + 1) : raw).slice(-scriptOutputLimit);
  const { closed, stop } = start(
    command,
    {
      stdout: chunk => {
        if (stdout.length < scriptStdoutLimit) stdout += chunk.toString();
        add(chunk);
      },
      stderr: add,
    },
    input
  );
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMinutes * 60_000);
  const exit = await closed;
  clearTimeout(timer);
  if ('error' in exit)
    return launch.startFailed(exit.error)
      ? failed(exit.error.message)
      : { ok: false, output: exit.error.message, stdout: '' };
  if (exit.code === 125 && launch.startFailed({ name: 'exit', message: '', exitCode: 125 }))
    return failed(shown().trim() || 'the container did not start');
  const tail = timedOut ? `\ntimed out after ${timeoutMinutes} minutes` : '';
  return {
    ok: exit.code === 0 && !timedOut,
    output: (shown() + tail).trim(),
    stdout,
    ...(timedOut ? { stopped: 'timeout' as const } : {}),
  };
};

/**
 * A limiter for agent sessions: at most `n` job sessions run at once (4 by default), and at most `n` check sessions in
 * a pool of their own, so an attempt's checks never wait behind other jobs' sessions. A bot with a `concurrency` also
 * runs at most that many sessions at once, jobs and checks together. Waiting runs stay `queued`.
 */
export const limiter = (n = 4) =>
  Effect.sync(() => {
    const pools = { job: Effect.unsafeMakeSemaphore(n), check: Effect.unsafeMakeSemaphore(n) };
    const bots = new Map<string, Effect.Semaphore>();
    const capOf = ({ name, concurrency }: Pick<Defined<Bot>, 'name' | 'concurrency'>) => {
      const key = `${name}:${concurrency}`;
      const cap = bots.get(key) ?? Effect.unsafeMakeSemaphore(concurrency ?? n);
      bots.set(key, cap);
      return cap;
    };
    return <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      { bot, check = false }: { bot?: Pick<Defined<Bot>, 'name' | 'concurrency'>; check?: boolean } = {}
    ) => {
      const pooled = pools[check ? 'check' : 'job'].withPermits(1)(effect);
      return bot?.concurrency ? capOf(bot).withPermits(1)(pooled) : pooled;
    };
  });
