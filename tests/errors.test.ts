import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { SandboxError } from '../src/sandbox.ts';
import { StoreError } from '../src/store.ts';

it.each([
  [new StoreError({ path: 'runs/1/run.json', cause: new Error('EACCES') }), 'runs/1/run.json: EACCES'],
  [
    new StoreError({ path: 'runs/1/run.json', cause: Object.create(null) }),
    'runs/1/run.json: [Object: null prototype] {}',
  ],
  [new SandboxError({ reason: 'timeout', detail: 'no output for 10 minutes' }), 'no output for 10 minutes'],
  [new SandboxError({ reason: 'infra', detail: '' }), 'infra'],
])('a failed run rejects with a message: %s', async (error, message) => {
  await expect(Effect.runPromise(Effect.fail(error))).rejects.toThrow(message);
});
