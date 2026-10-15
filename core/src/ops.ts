import type { Effect, Schema } from 'effect';
import type { Services } from './services.ts';
import { todo } from './todo.ts';

/** One operation; the CLI, the HTTP routes and the MCP tools come from one table of these. */
export type Op<I, O> = {
  summary: string;
  input: Schema.Schema<I>;
  output: Schema.Schema<O>;
  writes: boolean;
  run: (input: I) => Effect.Effect<O, unknown, Services>;
};

export const ops: Record<string, Op<any, any>> = {};

export const cli = (_table: typeof ops): Effect.Effect<void, never, Services> => todo('cli');

export const http =
  (_table: typeof ops) =>
  (_req: Request): Effect.Effect<Response, never, Services> =>
    todo('http');

export const mcp = (_table: typeof ops): Effect.Effect<void, never, Services> => todo('mcp');
