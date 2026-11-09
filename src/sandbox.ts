import { Context, Data, type Effect, type Stream, type Scope } from 'effect';
import type { Graph } from './folder.ts';
import { type Checkout, type Command, type Exit } from './types.ts';

export class SandboxError extends Data.TaggedError('SandboxError')<{
  reason: 'timeout' | 'stalled' | 'infra' | 'host';
  detail: string;
}> {
  override get message() {
    return this.detail || this.reason;
  }
}

export const inside = {
  work: '/work',
  home: '/home/agent',
  tmp: '/tmp',
  scratch: '/scratch',
  graph: '/graph',
  cache: '/cache',
  news: '/news',
};

/**
 * Where a run's checkout lives and where its scripts and harnesses run. Docker, or the host in tests. With `keep`, a
 * checkout starts from the files last kept under that ref, on the run branch when it exists, else on their base.
 * Without a `ref` it is an empty folder with no git and an empty `base`.
 * It keeps its own files there as one local commit when its scope closes. Every command in a checkout runs in the
 * `image` and on the `network` of the `graph` it was made for, starting from that graph's sandbox setup at the base when there is one.
 */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    tools?: (
      dir: string
    ) => Effect.Effect<{ subnet: string } & Pick<NonNullable<Command['tools']>, 'host'>, SandboxError>;
    readBranches: () => Effect.Effect<string[], SandboxError>;
    readHead: (ref: string) => Effect.Effect<string, SandboxError>;
    removeBranch: (branch: string, base: string | undefined, head?: string) => Effect.Effect<void, SandboxError>;
    checkout: (
      ref: string | undefined,
      branch?: string,
      keep?: string,
      graph?: Pick<Graph, 'image' | 'network' | 'toolchain' | 'setup'> &
        Partial<Pick<Graph, 'repo' | 'workflows'>> & { readonly?: boolean }
    ) => Effect.Effect<Checkout, SandboxError, Scope.Scope>;
    exec: (command: Command) => Effect.Effect<Exit, SandboxError, Scope.Scope>;
    lines: (command: Command) => Stream.Stream<string | Pick<Exit, 'code' | 'used'>, SandboxError, Scope.Scope>;
  }
>()('agentgraph/Sandbox') {}

export type Box = Pick<Sandbox['Service'], 'lines' | 'tools'> & Pick<Checkout, 'ready' | 'env' | 'written' | 'image'>;

export class Runner extends Context.Service<
  Runner,
  {
    open: (
      work: Omit<Checkout, 'ready' | 'env' | 'written' | 'image'>,
      graph?: Parameters<Sandbox['Service']['checkout']>[3]
    ) => Effect.Effect<Box, SandboxError, Scope.Scope>;
    whyRefused?: (graph: Graph) => string | undefined;
  }
>()('agentgraph/Runner') {}
