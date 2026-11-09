import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigProvider, Effect, Exit, Layer, type Scope } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import modal, { makeModalRunner, whyModalRefuses } from '../examples/plugins/modal/modal.ts';
import { makeSandbox } from '../src/mirror.ts';
import { type Command, Sandbox } from '../src/sandbox.ts';
import { makeFakeModal } from './doubles/modal.ts';
import { makeTestGraph } from './fixtures.ts';
import { git, tmp } from './kit.ts';

const fake = makeFakeModal(tmp('modal'));
afterAll(() => fake.stop());

const origin = () => {
  const dir = tmp('origin');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'main\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'main');
  return dir;
};

const gateway: { urls: string[]; direct: string[] } = { urls: ['https://localhost/v1'], direct: [] };
const use = <A, E>(
  network: 'models' | undefined,
  f: (s: Sandbox['Service'], dir: string) => Effect.Effect<A, E, Scope.Scope>
) => {
  const data = tmp('data');
  return Effect.runPromiseExit(
    Sandbox.pipe(
      Effect.flatMap(s =>
        Effect.flatMap(s.checkout('main', undefined, undefined, { ...(network && { network }) }), work =>
          f(s, work.dir)
        )
      ),
      Effect.scoped,
      Effect.provide(
        makeSandbox({ data, origin: origin() }).pipe(
          Layer.provide(Layer.orDie(makeModalRunner(fake.client, { image: 'unused' }, { data }, gateway)))
        )
      )
    )
  );
};

const sh = (dir: string, script: string, network: Command['network']): Command => ({
  cmd: 'sh',
  args: ['-c', script],
  dir,
  env: {},
  network,
  minutes: 1,
});

describe('the Modal runner', () => {
  it('blocks the network of a box whose graph has no model network, and lets the box go with its scope', async () => {
    const exit = await use(undefined, (s, dir) => Effect.map(s.exec(sh(dir, 'echo ok', 'none')), out => out.output));
    expect(exit).toEqual(Exit.succeed('ok\n'));
    expect(fake.boxes.at(-1)).toMatchObject({ params: { blockNetwork: true }, terminated: true });
  });

  it('lets a models box reach only the gateway, and runs no command without network there', async () => {
    const exit = await use('models', (s, dir) =>
      Effect.gen(function* () {
        const session = yield* s.exec(sh(dir, 'echo ok', 'proxy'));
        const quiet = yield* Effect.exit(s.exec(sh(dir, 'echo ok', 'none')));
        return { session: session.output, quiet: JSON.stringify(quiet) };
      })
    );
    expect(exit).toEqual(
      Exit.succeed({ session: 'ok\n', quiet: expect.stringContaining('runs no command without network') })
    );
    expect(fake.boxes.at(-1)!.params).toEqual(
      expect.objectContaining({ cidrAllowlist: expect.arrayContaining(['127.0.0.1/32']) })
    );
  });

  it('terminates boxes whose checkout is gone when it starts', async () => {
    const data = tmp('data');
    const gone = await fake.client.sandboxes.create({ appId: 'agentgraph' }, 'unused', {
      timeoutMs: 1,
      idleTimeoutMs: 1,
      blockNetwork: true,
    });
    const kept = join(data, 'kept');
    mkdirSync(kept, { recursive: true });
    await gone.setTags({ data, checkout: join(data, 'gone') });
    const live = await fake.client.sandboxes.create({ appId: 'agentgraph' }, 'unused', {
      timeoutMs: 1,
      idleTimeoutMs: 1,
      blockNetwork: true,
    });
    await live.setTags({ data, checkout: kept });
    await Effect.runPromise(
      Effect.scoped(Layer.build(makeModalRunner(fake.client, { image: 'unused' }, { data }, gateway)))
    );
    expect(fake.boxes.slice(-2).map(b => b.terminated)).toEqual([true, false]);
  });

  const graph = makeTestGraph('graph');
  const talks = { ...graph, checks: {}, setup: 'true' };
  const each = Object.fromEntries(
    Object.entries(graph.workflows).map(([name, w]) => [
      name,
      { ...w, steps: w.steps.map(step => ({ ...step, each: 'ls' })) },
    ])
  );
  it.each([
    ['sessions on the egress network', talks, gateway, 'set network: models'],
    [
      'commands without network beside sessions',
      { ...talks, network: 'models', workflows: each },
      gateway,
      'one network',
    ],
    [
      'a check that judges the lines of a command beside sessions',
      {
        ...talks,
        network: 'models',
        checks: {
          lines: {
            name: 'lines',
            path: 'checks/lines.md',
            body: '',
            version: '',
            mode: 'info',
            each: 'ls',
            agent: 'judge',
          },
        },
      },
      gateway,
      'one network',
    ],
    [
      'a gateway that is not public HTTPS',
      { ...talks, network: 'models' },
      { urls: ['http://gw.example'], direct: [] },
      'not http://gw.example',
    ],
    ['a Docker alias gateway', { ...talks, network: 'models' }, { urls: [], direct: ['gateway'] }, 'not gateway'],
    ['nothing in a models graph of sessions only', { ...talks, network: 'models' }, gateway, undefined],
    ['nothing in a graph of commands only', { ...graph, workflows: {} }, gateway, undefined],
  ] satisfies [string, typeof graph, typeof gateway, string | undefined][])(
    'refuses %s at check time',
    (_name, g, at, refused) => {
      const why = whyModalRefuses(at)(g);
      if (refused === undefined) expect(why).toBeUndefined();
      else expect(why).toContain(refused);
    }
  );

  it('needs Modal tokens from the instance env, and says so before anything starts', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Layer.build(modal.runner!({ data: tmp('data') }, { image: 'unused' }))).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} }))
      )
    );
    expect(JSON.stringify(exit)).toContain('the modal runner needs');
  });

  it.skipIf(!process.env.MODAL_TOKEN_ID)(
    'runs a command in a live Modal box',
    async () => {
      const data = tmp('data');
      const layer = makeSandbox({ data, origin: origin() }).pipe(
        Layer.provide(
          Layer.orDie(
            modal.runner!(
              { data, direct: [] },
              { image: process.env.MODAL_IMAGE ?? 'buildpack-deps:bookworm-scm', app: 'agentgraph-smoke' }
            )
          )
        )
      );
      const exit = await Effect.runPromiseExit(
        Sandbox.pipe(
          Effect.flatMap(s => Effect.flatMap(s.checkout('main'), work => s.exec(sh(work.dir, 'cat a.txt', 'none')))),
          Effect.scoped,
          Effect.provide(layer)
        )
      );
      expect(exit).toEqual(Exit.succeed(expect.objectContaining({ code: 0, output: 'main\n' })));
    },
    300_000
  );
});
