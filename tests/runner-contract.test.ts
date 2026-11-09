import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Exit, Layer, type Scope } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeModalRunner } from '../examples/plugins/modal/modal.ts';
import { sandboxImage } from '../src/docker.ts';
import { makeSandbox } from '../src/mirror.ts';
import { boxRunner } from '../src/remote.ts';
import { type Command, Sandbox } from '../src/sandbox.ts';
import { dockerSandbox } from './docker-fixtures.ts';
import { startBoxServer } from './doubles/box.ts';
import { makeFakeModal } from './doubles/modal.ts';
import { git, tmp } from './kit.ts';

const origin = () => {
  const dir = tmp('origin');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'main\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'main');
  return dir;
};

const docker = () =>
  process.env.AGENTGRAPH_E2E === '1' &&
  spawnSync('docker', ['image', 'inspect', sandboxImage], { encoding: 'utf8' }).status === 0;

const sh = (dir: string, script: string, more: Partial<Command> = {}): Command => ({
  cmd: 'sh',
  args: ['-c', script],
  dir,
  env: {},
  network: 'none',
  minutes: 1,
  ...more,
});

const boxes = tmp('boxes');
const modal = makeFakeModal(tmp('modal'));
let server: Awaited<ReturnType<typeof startBoxServer>>;
beforeAll(async () => {
  server = await startBoxServer(boxes);
});
afterAll(async () => {
  modal.stop();
  await server.close();
  rmSync(boxes, { recursive: true, force: true });
});

const runners: [string, boolean, (data: string, origin: string) => Layer.Layer<Sandbox>][] = [
  ['local', !docker(), (data, origin) => dockerSandbox({ data, origin, cache: '' })],
  [
    'box',
    false,
    (data, origin) => makeSandbox({ data, origin }).pipe(Layer.provide(boxRunner({ url: server.url, data }))),
  ],
  [
    'modal',
    false,
    (data, origin) =>
      makeSandbox({ data, origin }).pipe(
        Layer.provide(
          Layer.orDie(makeModalRunner(modal.client, { image: 'unused' }, { data }, { urls: [], direct: [] }))
        )
      ),
  ],
];

describe.each(runners)('the %s runner', (_name, skip, make) => {
  const use = <A, E>(f: (s: Sandbox['Service'], dir: string) => Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromiseExit(
      Sandbox.pipe(
        Effect.flatMap(s => Effect.flatMap(s.checkout('main'), work => f(s, work.dir))),
        Effect.scoped,
        Effect.provide(make(tmp('data'), origin()))
      )
    );

  it.skipIf(skip)('passes output and the exit code through, and brings written files back', async () => {
    const exit = await use((s, dir) =>
      Effect.gen(function* () {
        const first = yield* s.exec(sh(dir, 'echo out; echo b > b.txt; exit 3'));
        const second = yield* s.exec(sh(dir, 'cat b.txt'));
        return { first, second, host: readFileSync(join(dir, 'b.txt'), 'utf8') };
      })
    );
    expect(exit).toEqual(
      Exit.succeed({
        first: expect.objectContaining({ code: 3, output: 'out\n' }),
        second: expect.objectContaining({ code: 0, output: 'b\n' }),
        host: 'b\n',
      })
    );
  });

  it.skipIf(skip)('never lets a read-only command change the work tree', async () => {
    const exit = await use((s, dir) =>
      Effect.gen(function* () {
        const out = yield* s.exec(sh(dir, 'echo x > a.txt', { readonly: true }));
        return { failed: out.code !== 0, file: readFileSync(join(dir, 'a.txt'), 'utf8') };
      })
    );
    expect(exit).toEqual(Exit.succeed({ failed: true, file: 'main\n' }));
  });
});
