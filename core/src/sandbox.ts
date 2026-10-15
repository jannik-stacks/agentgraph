import { Context, Data, Layer, type Effect, type Redacted, type Scope, type Stream } from 'effect';
import { todo, todoStream } from './todo.ts';

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

const stub = (name: string): Sandbox['Type'] => ({
  checkout: () => todo(`${name}.checkout`),
  exec: () => todo(`${name}.exec`),
  lines: () => todoStream(`${name}.lines`),
});

/** Commands on the host, for tests. */
export const host: Layer.Layer<Sandbox> = Layer.succeed(Sandbox, stub('host'));
