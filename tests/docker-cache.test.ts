import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Effect, Exit, type Layer, type Scope, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSandboxSetup, makeToolchainSetupCommands } from '../src/env.ts';
import { startHeartbeat } from '../src/owner.ts';
import { readEnvRefs } from '../src/disk.ts';
import { Sandbox } from '../src/sandbox.ts';
import { git, tmp, write } from './kit.ts';

const use = <A, E>(layer: Layer.Layer<Sandbox>, f: (s: Sandbox['Service']) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromiseExit(Sandbox.pipe(Effect.flatMap(f), Effect.scoped, Effect.provide(layer)));

import {
  dockerSandbox,
  makeDockerOrigin as origin,
  makeDockerCommand as command,
  makeDockerClient,
} from './docker-fixtures.ts';

describe('docker with a stand-in docker client', () => {
  const { log, layer, logged } = makeDockerClient();
  it.each([
    ['an untrusted base', 'feature', ''],
    ['a live overlay of the cache', 'main', 'live'],
  ])('keeps the build writes of %s out of the cache volume', async (_, ref, live) => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    writeFileSync(`${log}.live`, live && `agentgraph.lower=agentgraph-cache- agentgraph.layer=${startHeartbeat()}\n`);
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      s.checkout(ref, undefined, undefined, { repo: 'acme/trust', toolchain: 'true' })
    );
    writeFileSync(`${log}.live`, '');
    expect(readFileSync(`${log}.held`, 'utf8')).toBe('');
    expect(Exit.isSuccess(exit) && exit.value.env?.key).toBeTruthy();
    const text = readFileSync(all, 'utf8');
    const build = text.split('\n').find(l => l.includes('agentgraph.envbuild')) ?? '';
    const key = /agentgraph-lower-(\w+),dst=/.exec(build)?.[1];
    expect(/src=(\S+),dst=\/cache /.exec(build)?.[1]).toBe(`agentgraph-envbuild-${key}-c`);
    expect(build).not.toContain(`src=agentgraph-lower-${key}-c,`);
    expect(text).toMatch(
      new RegExp(
        `volume create --label agentgraph\\.layer=\\S+ --label agentgraph\\.lower=agentgraph-cache-acme-trust-\\w+ .*upperdir=/m/agentgraph-lower-${key}-c/upper.* agentgraph-envbuild-${key}-c`
      )
    );
    expect(text).toMatch(/volume rm -f agentgraph-envbuild-\w+-c\n/);
    expect(text).toMatch(/commit --change LABEL .* agentgraph\.layered=true /);
    expect(text).toMatch(
      new RegExp(
        `--label agentgraph\\.env=${key} .*lowerdir=/m/agentgraph-lower-${key}-c/upper:/m/agentgraph-cache-acme-trust-\\w+,upperdir=/m/agentgraph-layer-\\w+-c/upper`
      )
    );
  });

  it('keys and layers a base no trusted ref reaches apart from trusted ones for a direct caller', async () => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    const repo = origin();
    const setup = (base: string, trusted: string[]) =>
      readSandboxSetup({
        repo: 'acme/bench',
        origin: repo,
        image: 'base:1',
        git: join(repo, '.git'),
        base,
        cache: 'agentgraph-cache',
        toolchain: 'true',
        trusted,
      });
    const { env: untrusted } = await setup('feature', ['main']);
    const build = readFileSync(all, 'utf8')
      .split('\n')
      .find(l => l.includes('agentgraph.envbuild'));
    expect(/src=(\S+),dst=\/cache /.exec(build ?? '')?.[1]).toBe(`agentgraph-envbuild-${untrusted?.key}-c`);
    expect(untrusted?.layered).toBe(true);
    const { env: main } = await setup('main', ['main']);
    const { env: feature } = await setup('feature', ['main', 'feature']);
    expect(main?.layered).toBe(false);
    expect(feature?.key).toBe(main?.key);
    expect(untrusted?.key).not.toBe(main?.key);
  });

  it.each([
    ['a branch named origin/HEAD', ['branch', 'origin/HEAD', 'feature'], {}],
    ['a tag named origin/HEAD', ['tag', 'origin/HEAD', 'feature'], {}],
    [
      'a branch named like a workflow base template',
      ['branch', 'agentgraph/{parent}', 'feature'],
      { w: { base: 'agentgraph/{parent}' } },
    ],
    ['a workflow base on a bot branch', ['branch', 'agentgraph/next', 'feature'], { w: { base: 'agentgraph/next' } }],
    [
      'a workflow base another workflow writes',
      ['branch', 'fix-1', 'feature'],
      { w: { base: 'fix-1' }, v: { branch: 'fix-{number}' } },
    ],
  ])('keeps an unmerged base untrusted beside %s', async (_, made, workflows) => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    const repo = origin();
    git(repo, ...made);
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: repo }), s =>
      s.checkout('feature', undefined, undefined, {
        repo: 'acme/anchor',
        toolchain: 'true',
        workflows: workflows as never,
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(readFileSync(all, 'utf8')).toMatch(/src=agentgraph-envbuild-\w+-c,dst=\/cache /);
  });

  it.each([
    ['the image lookup fails for another reason', 'imgfail', '', 'Cannot connect to the Docker daemon'],
    ['a live checkout reads it', 'live', 'agentgraph.env= agentgraph.layer=', 'while a live checkout reads it'],
  ])('keeps an environment that looks missing while %s', async (_, file, line, error) => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    writeFileSync(`${log}.${file}`, line && `${line}${startHeartbeat()}\n`);
    try {
      const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
        s.checkout('main', undefined, undefined, { repo: 'acme/kept', toolchain: 'true' })
      );
      expect(JSON.stringify(exit)).toContain(error);
      expect(readFileSync(all, 'utf8')).not.toContain('volume rm -f agentgraph-lower-');
    } finally {
      rmSync(`${log}.${file}`, { force: true });
    }
  });

  it('trusts a base on a workflow base branch', async () => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      s.checkout('feature', undefined, undefined, {
        repo: 'acme/dev',
        toolchain: 'true',
        workflows: { w: { base: 'feature' } } as never,
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(readFileSync(all, 'utf8')).not.toContain('src=agentgraph-envbuild-');
  });

  it('releases the cache lock when the overlay query fails, so a retry builds', async () => {
    writeFileSync(`${log}.lsfail`, '');
    const sandbox = dockerSandbox({ data: tmp('data'), origin: origin() });
    const checkout = () =>
      use(sandbox, s => s.checkout('main', undefined, undefined, { repo: 'acme/retry', toolchain: 'true' }));
    expect(Exit.isFailure(await checkout())).toBe(true);
    expect(existsSync(`${log}.lsfail`)).toBe(false);
    expect(Exit.isSuccess(await checkout())).toBe(true);
  });

  it('records an uppercase cache prefix for every checkout of a data dir', async () => {
    const data = tmp('data');
    const exit = await use(dockerSandbox({ data, origin: origin(), cache: 'TeamCache' }), s =>
      Effect.all([1, 2].map(() => s.checkout('main', undefined, undefined, { repo: 'acme/x', toolchain: 'true' })))
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(readEnvRefs(data)).toEqual([
      expect.stringMatching(/^TeamCache-acme-x-[0-9a-f]{24}$/),
      expect.stringMatching(/^agentgraph-env\/acme-x:\w+$/),
    ]);
  });

  it('tells repos without a name apart by their origin', async () => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    for (const from of [origin(), origin()])
      await use(dockerSandbox({ data: tmp('data'), origin: from }), s =>
        s.checkout('main', undefined, undefined, { toolchain: 'true' })
      );
    const names = [...readFileSync(all, 'utf8').matchAll(/volume create --label agentgraph\.cache=(\S+)/g)].map(
      ([, name]) => name
    );
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names).toEqual(
      names.map(() => expect.stringMatching(/^agentgraph-cache-agentgraph-origin-\w+-[0-9a-f]{24}$/))
    );
  });

  it.each([false, true])('creates missing mountpoints for a read-only command (streamed: %s)', async streamed => {
    const repo = origin();
    write(repo, { 'package.json': '{}', 'packages/app/package.json': '{}' });
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'packages');
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: repo }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main', undefined, undefined, { setup: 'withdeps' });
        const task = command(work.dir, { readonly: true });
        yield* streamed ? Stream.runDrain(s.lines(task)) : s.exec(task);
        return {
          exists: ['node_modules', 'packages/app/node_modules'].map(p => existsSync(join(work.dir, p))),
          args: logged(),
        };
      })
    );
    expect(Exit.isSuccess(exit) && exit.value.exists).toEqual([true, true]);
    expect(Exit.isSuccess(exit) && exit.value.args.join(' ')).toMatch(
      /dst=\/work\/node_modules,volume-nocopy,readonly/
    );
  });

  it('reports a symlink mountpoint before starting the command', async () => {
    const outside = tmp('outside');
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main', undefined, undefined, { setup: 'withdeps' });
        symlinkSync(outside, join(work.dir, 'node_modules'));
        return yield* s.exec(command(work.dir, { readonly: true }));
      })
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('symlink mountpoint:');
    expect(readdirSync(outside)).toEqual([]);
  });

  it("builds a graph's sandbox setup once on the base's files with open network and starts every checkout from it", async () => {
    const repo = origin();
    writeFileSync(join(repo, 'Cargo.toml'), '[workspace]\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'rust');
    const builds = () =>
      readFileSync(`${log}.all`, 'utf8')
        .split('\n')
        .filter(l => l.includes('agentgraph.envbuild')).length;
    const before = existsSync(`${log}.all`) ? builds() : 0;
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: repo }), s =>
      Effect.gen(function* () {
        const graph = { toolchain: 'rustup target add wasm32-unknown-unknown' };
        const work = yield* s.checkout('main', undefined, undefined, graph);
        yield* s.checkout('main', undefined, undefined, graph);
        yield* s.checkout('main');
        return work.base;
      })
    );
    const base = Exit.isSuccess(exit) ? exit.value : '';
    const all = readFileSync(`${log}.all`, 'utf8');
    const text = all.slice(all.lastIndexOf('agentgraph.envbuild'));
    expect(text).toContain('--network bridge');
    for (const env of [
      'npm_config_cache=/cache/npm',
      'npm_config_store_dir=/cache/pnpm',
      'YARN_CACHE_FOLDER=/cache/yarn',
    ])
      expect(text).toContain(`-e ${env} `);
    expect(text).toContain(base);
    expect(readFileSync(`${log}.all`, 'utf8')).toMatch(/volume create .* agentgraph-layer-\w+-0\n/);
    expect(text).toContain('git checkout-index --stdin');
    expect(text).toMatch(/ deps Cargo\.toml /);
    expect(text.indexOf('flock 9')).toBeLessThan(text.indexOf('sh -ec "$3"'));
    expect(text).toContain('RUSTUP_AUTO_INSTALL=0 sh -ec "$4"');
    expect(text).toContain('type=volume,src=agentgraph-lower-');
    expect(text).toMatch(/dst=\/work /);
    expect(text.indexOf('cargo fetch')).toBeLessThan(text.indexOf('rustup target add'));
    expect(builds() - before).toBe(1);
    expect(readFileSync(`${log}.all`, 'utf8')).toMatch(
      /commit --change LABEL agentgraph\.env=\w+ agentgraph\.cache=agentgraph-cache-\S+ agentgraph\.layered=false agentgraph\.version=\d+ agentgraph\.lowerkb=5 agentgraph\.complete=true/
    );
  });

  it("layers a checkout's dependency dirs over the sandbox setup's copy, skips setup on base files and drops them after", async () => {
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main', undefined, undefined, { setup: 'withdeps' });
        yield* s.exec(command(work.dir));
        return { ready: work.ready, args: logged() };
      })
    );
    const { ready, args } = Exit.isSuccess(exit) ? exit.value : { ready: false, args: [] };
    expect(ready).toBe(true);
    const mount = args.find(a => a.includes('dst=/work/node_modules')) ?? '';
    expect(mount).toMatch(/^type=volume,src=agentgraph-layer-\w+-0-o,dst=\/work\/node_modules,volume-nocopy$/);
    const name = /src=([\w-]+)/.exec(mount)?.[1];
    const all = readFileSync(`${log}.all`, 'utf8');
    expect(all).toContain(`volume create --label agentgraph.layer=${process.pid}:`);
    expect(all).toContain('type=overlay');
    expect(all).toContain('mkdir -p /u/0/upper /u/0/work');
    expect(all).toMatch(new RegExp(`volume rm -f ${name} ${name!.slice(0, -4)}-c-o ${name!.slice(0, -2)} `));
    expect(args).toContain(`type=volume,src=${name!.slice(0, -4)}-c-o,dst=/cache,volume-nocopy`);
    const runs = all.split('\n').filter(l => l.startsWith('run '));
    expect(runs.length).toBeGreaterThan(2);
    for (const run of runs) expect(run).toMatch(/^run --log-driver none /);
  });

  it('starts a readonly checkout from the plain image without the sandbox setup or cache', async () => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main', undefined, undefined, { setup: 'withdeps', readonly: true });
        yield* s.exec(command(work.dir));
        return { work, args: logged() };
      })
    );
    const { work, args } = Exit.isSuccess(exit) ? exit.value : { work: undefined, args: [] };
    expect(work).toMatchObject({ dir: expect.any(String) });
    expect(work?.env).toBeUndefined();
    expect(args.some(a => a.includes('dst=/work/node_modules') || a.includes('dst=/cache'))).toBe(false);
    expect(readFileSync(all, 'utf8')).not.toContain('agentgraph.envbuild');
  });

  it('builds on the whole tree when setup fails on the skeleton, and goes there first for that family after', async () => {
    const saved = process.env.AGENTGRAPH_STATE;
    process.env.AGENTGRAPH_STATE = tmp('state');
    try {
      const repo = origin();
      git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature');
      const builds = () =>
        [
          ...(existsSync(`${log}.all`) ? readFileSync(`${log}.all`, 'utf8') : '').matchAll(
            /agentgraph\.envbuild[^]*? skelfail (deps|tree) /g
          ),
        ].map(m => m[1]);
      const before = builds().length;
      const exit = await use(dockerSandbox({ data: tmp('data'), origin: repo }), s =>
        Effect.gen(function* () {
          const first = yield* s.checkout('main', undefined, undefined, { setup: 'skelfail' });
          const second = yield* s.checkout('feature', undefined, undefined, { setup: 'skelfail' });
          return [first.env, second.env];
        })
      );
      const made = builds().slice(before);
      expect(made).toEqual(['deps', 'tree', 'tree']);
      expect(Exit.isSuccess(exit) && exit.value).toEqual([
        { key: expect.any(String), mode: 'tree', match: true },
        { key: expect.any(String), mode: 'tree', match: true },
      ]);
    } finally {
      if (saved === undefined) delete process.env.AGENTGRAPH_STATE;
      else process.env.AGENTGRAPH_STATE = saved;
    }
  });

  it('builds on every file when the toolchain fails on the skeleton', async () => {
    const saved = process.env.AGENTGRAPH_STATE;
    process.env.AGENTGRAPH_STATE = tmp('state');
    try {
      const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
        s.checkout('main', undefined, undefined, { toolchain: 'skeltool', setup: 'x' })
      );
      expect(Exit.isSuccess(exit) && exit.value.env).toEqual({ key: expect.any(String), mode: 'tree', match: true });
    } finally {
      if (saved === undefined) delete process.env.AGENTGRAPH_STATE;
      else process.env.AGENTGRAPH_STATE = saved;
    }
  });

  it('fails the checkout when the toolchain fails', async () => {
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      s.checkout('main', undefined, undefined, { toolchain: 'toolfail' })
    );
    expect(JSON.stringify(exit)).toContain('toolchain exited');
  });

  it('refuses to mount a docker socket', async () => {
    const exit = await use(layer, s => s.exec(command('/var/run/docker.sock')));
    expect(JSON.stringify(exit)).toContain('mount not allowed');
  });
});

const count = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);

describe('docker images and sandbox setups shared by concurrent callers', () => {
  const bin = tmp('bin');
  const state = tmp('docker-state');
  const path = process.env.PATH;
  const saved = process.env.AGENTGRAPH_STATE;
  beforeAll(() => {
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/bin/sh',
        `s=${state}`,
        `[ "$1" = network ] && { echo true; exit 0; }`,
        `for t; do :; done; t=$(echo "$t" | tr /: __)`,
        `case "$1" in rm|volume) exit 0;; commit) touch $s/committed-$t; exit 0;; esac`,
        `[ "$1" = build ] && { echo x >> $s/builds; sleep 0.3; touch $s/sandbox; exit 0; }`,
        `[ "$1" = image ] && case "$*" in`,
        `  *Labels*) [ -e $s/committed-$t ] || { echo "No such image" >&2; exit 1; }; echo '{"agentgraph.env":"k","agentgraph.mode":"deps","agentgraph.complete":"true"}'; exit 0;;`,
        `  *agentgraph-sandbox:local*) [ -e $s/sandbox ] || { echo "No such image" >&2; exit 1; }; echo sha256:base; exit 0;;`,
        `  *sha256*|*ghcr.io*) echo "No such image" >&2; exit 1;;`,
        `  *) echo sha256:base; exit 0;;`,
        `esac`,
        `case "$*" in *agentgraph.envbuild*)`,
        `  p=; for a; do [ "$p" = --name ] && n=$a; p=$a; done`,
        `  mkdir $s/busy-$n 2>/dev/null || exit 137; echo x >> $s/envbuilds; sleep 0.3; rmdir $s/busy-$n`,
        `  printf '@@ignored\\n@@untracked\\n@@lower\\n5\\n'; exit 0;;`,
        `esac`,
        `echo started`,
      ].join('\n')
    );
    chmodSync(join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}${delimiter}${path}`;
    process.env.AGENTGRAPH_STATE = tmp('state');
  });
  afterAll(() => {
    process.env.PATH = path;
    if (saved === undefined) delete process.env.AGENTGRAPH_STATE;
    else process.env.AGENTGRAPH_STATE = saved;
  });

  it('builds a missing sandbox image once for concurrent checkouts, then runs their commands', async () => {
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin(), cache: '' }), s =>
      Effect.all(
        [1, 2].map(() => Effect.flatMap(s.checkout('main'), work => s.exec(command(work.dir)))),
        { concurrency: 'unbounded' }
      )
    );
    expect(Exit.isSuccess(exit) && exit.value.map(e => e.output.trim())).toEqual(['started', 'started']);
    expect(count(join(state, 'builds'))).toBe(1);
  });

  it('fails with the command to fetch a missing image it cannot build', async () => {
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin(), cache: '' }), s =>
      s.checkout('main', undefined, undefined, { image: 'ghcr.io/x/sandbox:1' })
    );
    expect(JSON.stringify(exit)).toContain('Run `docker pull ghcr.io/x/sandbox:1` there.');
    expect(JSON.stringify(exit)).toContain('"reason":"host"');
  });

  it('builds one sandbox setup for two callers that start at once', async () => {
    const repo = origin();
    const spec = {
      image: 'base:1',
      git: join(repo, '.git'),
      base: 'main',
      cache: 'c',
      toolchain: 'true',
      origin: repo,
      trusted: ['main'],
    };
    const envs = await Promise.all([1, 2].map(() => readSandboxSetup({ ...spec, repo: 'one' })));
    expect(envs.map(e => e.env?.mode)).toEqual(['deps', 'deps']);
    expect(envs[0]!.cache).toBe(envs[1]!.cache);
    expect(count(join(state, 'envbuilds'))).toBe(1);
    const others = await Promise.all(
      ['two', 'three'].map(name => readSandboxSetup({ ...spec, repo: name, setup: 'x' }))
    );
    expect(others.map(e => e.env?.mode)).toEqual(['deps', 'deps']);
    expect(new Set([envs[0]!.cache, ...others.map(e => e.cache)]).size).toBe(3);
    expect(count(join(state, 'envbuilds'))).toBe(3);
  });

  it('refuses a cache prefix docker cannot name', async () => {
    const repo = origin();
    await expect(
      readSandboxSetup({
        repo: 'r',
        origin: repo,
        image: 'base:1',
        git: join(repo, '.git'),
        base: 'main',
        cache: '--x',
        trusted: [],
      })
    ).rejects.toThrow('volume name not allowed: --x');
  });
});

describe('makeToolchainSetupCommands', () => {
  it('installs the pinned Rust toolchain with clippy and rustfmt and fetches the locked crates', () => {
    expect(makeToolchainSetupCommands(['Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'README.md'])).toEqual([
      'command -v rustup >/dev/null || rustup-init -y -q --no-modify-path --default-toolchain none --profile minimal',
      'rustup toolchain install',
      'rustup component add clippy rustfmt',
      'cargo fetch --locked',
    ]);
  });

  it('falls back to stable without a toolchain file and fetches without a lockfile', () => {
    const lines = makeToolchainSetupCommands(['Cargo.toml']);
    expect(lines[1]).toBe('rustup default stable');
    expect(lines[3]).toBe('cargo fetch');
    expect(makeToolchainSetupCommands(['rust-toolchain.toml'])).toHaveLength(3);
  });

  it('installs nothing for a repo without a toolchain it knows', () => {
    expect(makeToolchainSetupCommands(['package.json', 'package-lock.json', '.nvmrc'])).toEqual([]);
  });
});
