import { Config, Effect, Layer } from 'effect';
import { ensureDockerHost, dockerRunner } from './docker.ts';
import { makePlugin } from './plugin.ts';
import { boxRunner } from './remote.ts';
import { SandboxError } from './sandbox.ts';

export { makeBoxRunner } from './remote.ts';
export { Runner, SandboxError } from './sandbox.ts';
export type { RunnerHost } from './plugin.ts';

export const local = makePlugin({
  name: 'local',
  runner: host => dockerRunner(host).pipe(Layer.provide(Layer.effectDiscard(ensureDockerHost(host)))),
});

export const box = makePlugin({
  name: 'box',
  runner: host =>
    Layer.unwrap(
      Config.String('AGENTGRAPH_SANDBOX_URL').pipe(
        Effect.mapError(e => new SandboxError({ reason: 'infra', detail: `the box runner needs ${e.message}` })),
        Effect.map(url => boxRunner({ url, data: host.data }))
      )
    ),
});
