import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Context, Data, Effect, Layer, Stream, type Scope } from 'effect';
import type { Harness } from './hub.ts';
import type { Run } from './workflow.ts';

export type SessionSpec = {
  harness: Harness;
  model?: string;
  system: string;
  prompt: string;
  dir: string;
  tools: string[];
  bot: string;
  minutes: number;
  resume?: Run['sessions'][string];
};

/** What a session does, as the harness reports it. `end` comes once the harness exits; with `ended: 'error'` and no reply, `final` holds the harness's error. */
export type AgentEvent =
  | { type: 'start'; session: string; model: string; home: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: unknown;
      output?: string;
      ok?: boolean;
      exit?: number;
      denied?: true;
    }
  | { type: 'usage'; input: number; output: number; usd?: number }
  | { type: 'end'; final: string; ended: 'stop' | 'cap' | 'error'; exit: number };

export class SessionStop extends Data.TaggedError('SessionStop')<{
  reason: 'timeout' | 'stalled' | 'budget' | 'provider' | 'human' | 'sandbox';
  detail?: string;
}> {}

/** Runs one harness session in the sandbox and streams what it does. The harness exiting ends it. */
export class Session extends Context.Tag('bothub/Session')<
  Session,
  { open: (spec: SessionSpec) => Stream.Stream<AgentEvent, SessionStop, Scope.Scope> }
>() {}

const written = (dir: string, event: AgentEvent) =>
  event.type === 'tool' && event.name === 'write'
    ? Effect.promise(async () => {
        const { path, content } = event.input as { path: string; content: string };
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), content);
      })
    : Effect.void;

/**
 * Plays back one list of events per session opened, for tests. A `tool` event named `write` with `{ path, content }`
 * writes that file into the session's dir before it is emitted. A list without an `end` gets one that stops cleanly
 * with the last text as the reply.
 */
export const scripted = (turns: AgentEvent[][]): Layer.Layer<Session> =>
  Layer.sync(Session, () => {
    let next = 0;
    return {
      open: spec => {
        const events = turns[next++];
        if (!events) return Stream.fail(new SessionStop({ reason: 'provider', detail: 'no scripted session left' }));
        const last = events.findLast(e => e.type === 'text');
        const end: AgentEvent[] = events.some(e => e.type === 'end')
          ? []
          : [{ type: 'end', final: last?.type === 'text' ? last.text : '', ended: 'stop', exit: 0 }];
        return Stream.fromIterable([...events, ...end]).pipe(Stream.tap(event => written(spec.dir, event)));
      },
    };
  });
