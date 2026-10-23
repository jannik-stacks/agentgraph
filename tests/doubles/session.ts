import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { Session } from '../../src/session.ts';
import { SessionStop, type SessionEvent } from '../../src/trace.ts';

const written = (dir: string, event: SessionEvent) =>
  event.type === 'tool' && event.name === 'write'
    ? Effect.promise(async () => {
        const { path, content } = event.input as { path: string; content: string };
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), content);
      })
    : Effect.void;

/**
 * Plays back one list of events per session opened. A `tool` event named `write` with `{ path, content }`
 * writes that file into the session's dir before it is emitted. A list without an `end` gets one that stops cleanly
 * with the last text as the reply.
 */
export const scripted = (turns: SessionEvent[][]): Layer.Layer<Session> =>
  Layer.sync(Session, () => {
    let next = 0;
    return {
      open: spec => {
        const events = turns[next++];
        if (!events) return Stream.fail(new SessionStop({ reason: 'provider', detail: 'no scripted session left' }));
        const last = events.findLast(e => e.type === 'text');
        const end: SessionEvent[] = events.some(e => e.type === 'end')
          ? []
          : [{ type: 'end', final: last?.type === 'text' ? last.text : '', ended: 'stop', exit: 0 }];
        return Stream.fromIterable([...events, ...end]).pipe(Stream.tap(event => written(spec.dir, event)));
      },
    };
  });
