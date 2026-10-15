import { Data, Effect, Stream } from 'effect';

/** A function whose body is not written yet. */
export class NotImplemented extends Data.TaggedError('NotImplemented')<{ name: string }> {}

/** Dies with `NotImplemented`, so a stub keeps the type of the function it stands in for. */
export const todo = (name: string) => Effect.die(new NotImplemented({ name }));

/** `todo` as a stream. */
export const todoStream = (name: string) => Stream.die(new NotImplemented({ name }));
