import { Context, Data, type Effect, type Redacted, type Stream, type Scope } from 'effect';
import type { Hub } from './hub.ts';

/** One command in the sandbox: `dir` is its working directory, `home` its `HOME` when given. */
export type Command = {
  cmd: string;
  args: string[];
  dir: string;
  /** The hub directory, readable by the command as `$AGENTGRAPH_HUB`, never writable. */
  hub?: string;
  home?: string;
  env: Record<string, string>;
  secrets?: Record<string, Redacted.Redacted>;
  /** `open` reaches any host. */
  network: 'none' | 'proxy' | 'open';
  minutes: number;
};

export type Exit = { code: number; output: string };

/**
 * A checkout: the work tree `dir`, the commit `base` its change is measured from, and `git`, the repo and index host git
 * uses for it. On an existing branch `base` is where the branch forks from the ref, and `head` is the branch commit the
 * files start from.
 * `git` names only paths the host keeps out of the sandbox's reach. `news` is a file outside `dir` that only the host
 * writes; the sandbox reads it at the same path.
 */
export type Checkout = {
  dir: string;
  base: string;
  head?: string;
  saved?: string;
  published?: string;
  /** The checkout starts from a sandbox setup that already ran the hub's setup on these files. */
  ready?: boolean;
  /** The sandbox setup the checkout starts from, how it was built, and whether it was built from the checkout's own files. */
  env?: { key: string; mode: 'deps' | 'tree'; match: boolean };
  git: { GIT_DIR: string; GIT_WORK_TREE: string; GIT_INDEX_FILE?: string };
  news: string;
  /** How many files the checkout's commands wrote over the shared cache so far, when the sandbox can tell. */
  written?: () => Promise<number | undefined>;
};

export class SandboxError extends Data.TaggedError('SandboxError')<{
  reason: 'timeout' | 'stalled' | 'infra';
  detail: string;
}> {}

/**
 * Where a run's checkout lives and where its scripts and harnesses run. Docker, or the host in tests. With `keep`, a
 * checkout starts from the files last kept under that ref, on the run branch when it exists, else on their base.
 * It keeps its own files there as one local commit when its scope closes. Every command in a checkout runs in the
 * `image` and on the `network` of the `hub` it was made for, starting from that hub's sandbox setup at the base when there is one.
 */
export class Sandbox extends Context.Tag('agentgraph/Sandbox')<
  Sandbox,
  {
    checkout: (
      ref: string,
      branch?: string,
      keep?: string,
      hub?: Pick<Hub, 'image' | 'network' | 'toolchain' | 'setup'> & Partial<Pick<Hub, 'repo'>>
    ) => Effect.Effect<Checkout, SandboxError, Scope.Scope>;
    exec: (command: Command) => Effect.Effect<Exit, SandboxError, Scope.Scope>;
    lines: (command: Command) => Stream.Stream<string | Pick<Exit, 'code'>, SandboxError, Scope.Scope>;
  }
>() {}
