import { Effect, Layer, Schedule } from 'effect';
import { tick } from './engine.ts';
import { loadHub } from './hub.ts';
import { layers, settings } from './services.ts';

const main = Effect.gen(function* () {
  const s = yield* settings;
  const once = loadHub(s.hub).pipe(
    Effect.flatMap(tick),
    Effect.catchAll(e => Effect.logError(e))
  );
  yield* Effect.repeat(once, Schedule.spaced(`${s.every} minutes`));
});

/** Reads the settings, builds the services and ticks every `every` minutes. The only place that leaves Effect. */
export const start = (): Promise<void> =>
  Effect.runPromise(main.pipe(Effect.provide(Layer.unwrapEffect(Effect.map(settings, layers)))));
