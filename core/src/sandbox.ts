import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { Context, Data, Effect, Layer, Redacted, Stream, type Scope } from 'effect';

/** One command in the sandbox: `dir` is its working directory, `home` its `HOME` when given. */
export type Command = {
  cmd: string;
  args: string[];
  dir: string;
  home?: string;
  env: Record<string, string>;
  secrets?: Record<string, Redacted.Redacted>;
  network: 'none' | 'proxy';
  minutes: number;
};

export type Exit = { code: number; output: string };

export class SandboxError extends Data.TaggedError('SandboxError')<{
  reason: 'timeout' | 'stalled' | 'infra';
  detail: string;
}> {}

/** Where a run's worktree lives and where its scripts and harnesses run. Docker, or the host in tests. */
export class Sandbox extends Context.Tag('bothub/Sandbox')<
  Sandbox,
  {
    checkout: (ref: string, branch?: string) => Effect.Effect<{ dir: string; base: string }, SandboxError, Scope.Scope>;
    exec: (command: Command) => Effect.Effect<Exit, SandboxError, Scope.Scope>;
    lines: (command: Command) => Stream.Stream<string, SandboxError, Scope.Scope>;
  }
>() {}

const git = promisify(execFile);

const spawned = (command: Command) =>
  spawn(command.cmd, command.args, {
    cwd: command.dir,
    env: {
      ...process.env,
      ...command.env,
      ...(command.home !== undefined && { HOME: command.home }),
      ...Object.fromEntries(Object.entries(command.secrets ?? {}).map(([k, v]) => [k, Redacted.value(v)])),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const late = (command: Command) =>
  new SandboxError({ reason: 'timeout', detail: `${command.cmd} ran past ${command.minutes} minutes` });

/** Commands on the host, with clones of the local git repo `repo` as worktrees. No network rules; for tests. */
export const host = (repo: string): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
    checkout: (ref, branch) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const dir = await mkdtemp(join(tmpdir(), 'bothub-work-'));
            const run = (...args: string[]) => git('git', args, { cwd: dir }).then(r => r.stdout.trim());
            await git('git', ['clone', '-q', repo, dir]);
            const base = await run('rev-parse', '--verify', `origin/${ref}`).catch(() =>
              run('rev-parse', '--verify', ref)
            );
            if (branch) {
              const remote = await run('rev-parse', '--verify', `origin/${branch}`).catch(() => undefined);
              await run('checkout', '-q', '-B', branch, remote ?? base);
            } else await run('checkout', '-q', '--detach', base);
            return { dir, base };
          },
          catch: e => new SandboxError({ reason: 'infra', detail: `checkout ${ref}: ${(e as Error).message}` }),
        }),
        ({ dir }) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
      ),
    exec: command =>
      Effect.async<Exit, SandboxError>(resume => {
        const child = spawned(command);
        let output = '';
        const collect = (chunk: Buffer) => void (output += chunk.toString());
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resume(Effect.fail(late(command)));
        }, command.minutes * 60_000);
        child.on('error', e => {
          clearTimeout(timer);
          resume(Effect.fail(new SandboxError({ reason: 'infra', detail: e.message })));
        });
        child.on('close', code => {
          clearTimeout(timer);
          resume(Effect.succeed({ code: code ?? 1, output }));
        });
        return Effect.sync(() => {
          clearTimeout(timer);
          child.kill('SIGKILL');
        });
      }),
    lines: command =>
      Stream.async<string, SandboxError>(emit => {
        const child = spawned(command);
        createInterface({ input: child.stdout }).on('line', line => void emit.single(line));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          void emit.fail(late(command));
        }, command.minutes * 60_000);
        child.on('error', e => void emit.fail(new SandboxError({ reason: 'infra', detail: e.message })));
        child.on('close', () => {
          clearTimeout(timer);
          void emit.end();
        });
        return Effect.sync(() => {
          clearTimeout(timer);
          child.kill('SIGKILL');
        });
      }),
  });
