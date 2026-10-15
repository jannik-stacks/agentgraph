import { Context, Data, Layer, type Effect, type Scope, type Stream } from 'effect';
import type { Verdict } from './check.ts';
import type { Applied } from './forge.ts';
import type { AgentEvent } from './session.ts';
import { todo, todoStream } from './todo.ts';
import type { Outcome, Run } from './workflow.ts';

/** One line of a run's trace. */
export type Trace = { at: string; step: string } & (
  | { event: AgentEvent }
  | { outcome: Outcome }
  | { verdict: Verdict }
  | { applied: Applied }
);

export class StoreError extends Data.TaggedError('StoreError')<{ path: string; cause: unknown }> {}

/** Runs, traces and run files in the data dir. */
export class Store extends Context.Tag('bothub/Store')<
  Store,
  {
    get: (id: string) => Effect.Effect<Run | undefined, StoreError>;
    list: (filter?: Partial<Pick<Run, 'workflow' | 'thread' | 'status'>>) => Effect.Effect<Run[], StoreError>;
    put: (run: Run) => Effect.Effect<void, StoreError>;
    trace: (id: string, ...lines: Trace[]) => Effect.Effect<void, StoreError>;
    read: (id: string, from?: number) => Stream.Stream<Trace, StoreError>;
    lock: (name: string) => Effect.Effect<void, StoreError, Scope.Scope>;
  }
>() {}

/** A run is a JSON file and its trace a JSONL file under `dir`. */
export const fileStore = (_dir: string): Layer.Layer<Store> =>
  Layer.succeed(Store, {
    get: () => todo('fileStore.get'),
    list: () => todo('fileStore.list'),
    put: () => todo('fileStore.put'),
    trace: () => todo('fileStore.trace'),
    read: () => todoStream('fileStore.read'),
    lock: () => todo('fileStore.lock'),
  });
