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
