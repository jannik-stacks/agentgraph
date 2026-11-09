import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { Effect, Exit, Layer, Logger, Redacted, type Scope, Stream } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';
import { dockerArgs, readImage } from '../src/docker.ts';
import { ensureInstance } from '../src/instance.ts';
import { commitCheckoutOnce } from '../src/git.ts';
import {
  dependencyDirs,
  discard,
  createSharedMounts,
  writeCheckoutOwner,
  findDeadCheckouts,
  readDependencySkeleton,
  removeOrphanedVolumes,
  written,
} from '../src/env.ts';
import { isOwnerRunning, startHeartbeat } from '../src/owner.ts';
import { harnessSession } from '../src/harnesses.ts';
import { Sandbox } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fakeDocker, faked, harnesses, plant } from './fixtures.ts';
import { git, tmp, write } from './kit.ts';

const use = <A, E>(layer: Layer.Layer<Sandbox>, f: (s: Sandbox['Service']) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromiseExit(Sandbox.pipe(Effect.flatMap(f), Effect.scoped, Effect.provide(layer)));

const sortOutputLines = <A extends { output: string }, E>(exit: Exit.Exit<A, E>) =>
  Exit.map(exit, e => ({ ...e, output: e.output.split('\n').toSorted().join('\n') }));

import {
  dockerSandbox,
  makeDockerOrigin as origin,
  makeDockerCommand as command,
  makeDockerClient,
} from './docker-fixtures.ts';

describe('docker with a stand-in docker client', () => {
  const { log, layer, logged } = makeDockerClient();
  it('still keeps default Docker resources and tmpfs', () => {
    const args = dockerArgs(command('/work'), 'image', 'name', { mounts: [] });
    expect(args[args.indexOf('--memory') + 1]).toBe('4g');
    expect(args[args.indexOf('--memory-swap') + 1]).toBe('4g');
    expect(args[args.indexOf('--cpus') + 1]).toBe('1.5');
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,exec,nosuid,nodev,size=1g');
  });

  it.each([
    [{ memory: '8g' }, '8g', '1.5'],
    [{ cpus: 4 }, '4g', '4'],
    [{ memory: '16g', cpus: 8 }, '16g', '8'],
  ] as const)('passes command limits %j to Docker without growing tmpfs', (limits, memory, cpus) => {
    const args = dockerArgs(command('/work', { limits }), 'image', 'name', { mounts: [] });
    expect(args[args.indexOf('--memory') + 1]).toBe(memory);
    expect(args[args.indexOf('--memory-swap') + 1]).toBe(memory);
    expect(args[args.indexOf('--cpus') + 1]).toBe(cpus);
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,exec,nosuid,nodev,size=1g');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('512');
  });

  it('routes custom tools to their relay hostname without proxying the bearer secret', () => {
    const args = dockerArgs(
      command('/work', {
        network: 'proxy',
        tools: { url: 'http://tools-session.internal:4321/session', host: '127.0.0.1' },
        secrets: { AGENTGRAPH_TOOL_SECRET: Redacted.make('private-session-secret') },
      }),
      'image',
      'name',
      { mounts: [], direct: ['gateway'] }
    );
    expect(args).not.toContain('--add-host');
    expect(args).toContain('NO_PROXY=gateway,tools-session.internal,localhost,127.0.0.1');
    expect(args).toContain('AGENTGRAPH_TOOL_SECRET');
    expect(args.join(' ')).not.toContain('private-session-secret');
  });

  it.each(['egress', 'models'] as const)(
    'relays only the session tool port on the %s network and removes the relay',
    async network => {
      const before = existsSync(`${log}.all`) ? readFileSync(`${log}.all`, 'utf8').length : 0;
      const exit = await use(dockerSandbox({ data: tmp('data'), origin: '/nowhere', cache: '' }), s =>
        Effect.gen(function* () {
          const checkout = yield* s.checkout(undefined, undefined, undefined, { network });
          return yield* s.exec(
            command(checkout.dir, {
              network: 'proxy',
              tools: { url: 'http://tools-session.internal:4321/session', host: '127.0.0.1' },
            })
          );
        })
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      const relay = readFileSync(`${log}.all`, 'utf8')
        .slice(before)
        .split('\n')
        .find(line => line.includes('--entrypoint socat'))!;
      const name = /--name (agentgraph-tools-[a-f0-9]+)/.exec(relay)![1]!;
      expect(relay).toContain('--network agentgraph-egress --add-host host.docker.internal:host-gateway');
      expect(relay).toContain(
        '--read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 32m --pids-limit 64'
      );
      expect(relay).toContain(
        '--entrypoint socat agentgraph-egress:local TCP-LISTEN:4321,fork,reuseaddr TCP:host.docker.internal:4321'
      );
      expect(relay).not.toMatch(/--publish|--privileged|AGENTGRAPH_TOOL_SECRET/);
      expect(readFileSync(`${log}.network`, 'utf8')).toContain(
        `network connect --alias tools-session.internal ${network === 'models' ? 'agentgraph-models' : 'agentgraph-sandbox'} ${name}`
      );
      expect(readFileSync(`${log}.rm`, 'utf8')).toContain(`rm -f ${name}\n`);
    }
  );

  it.each([
    ['timeout', 'tools-session.internal', ['-c', 'sleep'], false, true],
    ['connection failure', 'tools-fail.internal', ['-c', 'echo hi'], false, true],
    ['stream cancellation', 'tools-session.internal', ['-c', 'chatty'], true, false],
  ] as const)('removes the tool relay after %s', async (why, host, args, streamed, isFailure) => {
    const before = existsSync(`${log}.all`) ? readFileSync(`${log}.all`, 'utf8').length : 0;
    const task = command(tmp('work'), {
      network: 'proxy',
      tools: { url: `http://${host}:4321/session`, host: '127.0.0.1' },
      args: [...args],
      minutes: why === 'timeout' ? 0.001 : 1,
    });
    const exit = await use(layer, s => (streamed ? Stream.runDrain(s.lines(task).pipe(Stream.take(1))) : s.exec(task)));
    expect(Exit.isFailure(exit)).toBe(isFailure);
    const relay = readFileSync(`${log}.all`, 'utf8')
      .slice(before)
      .split('\n')
      .find(line => line.includes('--entrypoint socat'))!;
    const name = /--name (agentgraph-tools-[a-f0-9]+)/.exec(relay)![1]!;
    expect(readFileSync(`${log}.rm`, 'utf8')).toContain(`rm -f ${name}\n`);
  });

  it('reads the Linux egress gateway once and uses it only for the host tool relay', async () => {
    const platform = process.platform;
    const before = existsSync(`${log}.network`) ? readFileSync(`${log}.network`, 'utf8').length : 0;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const exit = await use(dockerSandbox({ data: tmp('data'), origin: '/nowhere', cache: '' }), s =>
        Effect.gen(function* () {
          const first = yield* s.tools!('');
          const second = yield* s.tools!('');
          yield* s.exec(
            command(tmp('work'), {
              network: 'proxy',
              tools: { url: 'http://tools-linux.internal:4321/session', host: first.host },
            })
          );
          return [first, second];
        })
      );
      expect(exit).toEqual(
        Exit.succeed([
          { host: '172.30.0.1', subnet: '172.30.0.0/16' },
          { host: '172.30.0.1', subnet: '172.30.0.0/16' },
        ])
      );
      expect(
        readFileSync(`${log}.network`, 'utf8')
          .slice(before)
          .match(/IPAM.Config/g)
      ).toHaveLength(1);
      const relay = readFileSync(`${log}.all`, 'utf8')
        .split('\n')
        .findLast(line => line.includes('--entrypoint socat'))!;
      expect(relay).toContain('--add-host host.docker.internal:172.30.0.1');
      expect(logged()).not.toContain('--add-host');
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });

  it('runs a hardened container with secrets by name and their values only in the client env', async () => {
    const dir = tmp('work');
    const home = tmp('home');
    const exit = await use(layer, s =>
      s.exec(
        command(dir, { home, network: 'proxy', secrets: { AGENTGRAPH_LLM_API_KEY: Redacted.make('sk-value-123456') } })
      )
    );
    expect(sortOutputLines(exit)).toEqual(sortOutputLines(Exit.succeed({ code: 0, output: 'line one\nline two\n' })));
    const args = logged();
    for (const flag of ['--rm', '--read-only', '--cap-drop=ALL', 'no-new-privileges=true', '--pull', 'never'])
      expect(args).toContain(flag);
    expect(args[args.indexOf('--network') + 1]).toBe('agentgraph-sandbox');
    expect(args).toContain(`type=bind,src=${dir},dst=/work`);
    expect(args).toContain(`type=bind,src=${home},dst=/home/agent`);
    expect(args).toContain('HOME=/home/agent');
    expect(args).toContain('HTTPS_PROXY=http://egress:8888');
    expect(args).toContain('NO_PROXY=gateway,localhost,127.0.0.1');
    expect(args).toContain('A=1');
    expect(args.slice(args.indexOf('AGENTGRAPH_LLM_API_KEY') - 1, args.indexOf('AGENTGRAPH_LLM_API_KEY') + 1)).toEqual([
      '-e',
      'AGENTGRAPH_LLM_API_KEY',
    ]);
    expect(args.join(' ')).not.toContain('sk-value-123456=');
    expect(args.filter(a => a.includes('sk-value'))).toEqual(['secret=sk-value-123456']);
    expect(args.slice(-10, -2)).toEqual([
      'agentgraph-sandbox:local',
      'sh',
      '-c',
      expect.stringContaining('/sys/fs/cgroup/memory.peak'),
      'sh',
      'sh',
      '-c',
      'echo hi',
    ]);
  });

  it('keeps no docker log of any container it runs, since the runner reads the output itself', async () => {
    await use(layer, s => s.exec(command(tmp('work'))));
    const args = logged().join(' ');
    expect(args).toContain('--log-driver none');
  });

  it('has removed the container by the time a command ends, however it ends', async () => {
    for (const args of [
      ['-c', 'echo hi'],
      ['-c', 'fail'],
      ['-c', 'exit125'],
      ['-c', 'sleep'],
    ]) {
      await use(layer, s => s.exec(command(tmp('work'), { args, minutes: 0.01 })));
      const name = logged()[logged().indexOf('--name') + 1];
      expect(readFileSync(`${log}.rm`, 'utf8')).toContain(`rm -f ${name}\n`);
    }
    await use(layer, s => Stream.runDrain(s.lines(command(tmp('work'), { args: ['-c', 'chatty'], minutes: 0.01 }))));
    const name = logged()[logged().indexOf('--name') + 1];
    expect(readFileSync(`${log}.rm`, 'utf8')).toContain(`rm -f ${name}\n`);
  });

  it('mounts the graph read-only at /graph and names it in AGENTGRAPH_DIR', async () => {
    const graph = tmp('graph');
    await use(layer, s => s.exec(command(tmp('work'), { graph })));
    const args = logged();
    expect(args).toContain(`type=bind,src=${graph},dst=/graph,readonly`);
    expect(args).toContain('AGENTGRAPH_DIR=/graph');
  });

  it('mounts the work tree, git dirs and shared volumes read-only for a read-only command, but not its home', () => {
    const box = {
      mounts: [
        { src: '/m', dst: '/m', readonly: true },
        { src: '/m/worktrees/w', dst: '/m/worktrees/w' },
      ],
      sharedMounts: [
        { name: 'deps', dst: '/work/node_modules' },
        { name: 'own-c', dst: '/cache' },
      ],
      cache: 'agentgraph-cache-repo-k',
    };
    const args = (readonly: boolean) =>
      dockerArgs(command('/w', { home: '/h', readonly }), 'img', 'n', box).filter(a =>
        /^type=|^npm_config_cache=/.test(a)
      );
    expect(args(true)).toEqual([
      'type=bind,src=/w,dst=/work,readonly',
      'type=bind,src=/h,dst=/home/agent',
      'type=bind,src=/m,dst=/m,readonly',
      'type=bind,src=/m/worktrees/w,dst=/m/worktrees/w,readonly',
      'type=volume,src=deps,dst=/work/node_modules,volume-nocopy,readonly',
      'type=volume,src=own-c,dst=/cache,volume-nocopy,readonly',
      'npm_config_cache=/tmp/npm',
    ]);
    expect(args(false).filter(a => a.endsWith(',readonly'))).toEqual(['type=bind,src=/m,dst=/m,readonly']);
  });

  it('has no network without the proxy and returns any exit code', async () => {
    const exit = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'fail'] })));
    expect(Exit.isSuccess(exit) && exit.value.code).toBe(3);
    const args = logged();
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args.join('\n')).not.toContain('HTTPS_PROXY');
  });

  it('streams lines until the process exits, whatever its code', async () => {
    const exit = await use(layer, s => Stream.runCollect(s.lines(command(tmp('work'), { args: ['-c', 'fail'] }))));
    const pieces = Exit.map(exit, c => [...c.slice(0, -1).toSorted(), c.at(-1)]);
    expect(pieces).toEqual(Exit.succeed(['line one', 'line two', { code: 3 }]));
  });

  it('records the peak memory and CPU time the container reported, even before later output, and none when it reported none', async () => {
    const exit = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'measured'] })));
    expect(sortOutputLines(exit)).toEqual(
      sortOutputLines(Exit.succeed({ code: 0, output: 'line one\nline two\n', used: { peak: 104857600, cpu: 2500 } }))
    );
    const silent = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'fail'] })));
    expect(sortOutputLines(silent)).toEqual(sortOutputLines(Exit.succeed({ code: 3, output: 'line one\nline two\n' })));
    const interleaved = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'interleaved'] })));
    expect(sortOutputLines(interleaved)).toEqual(
      sortOutputLines(Exit.succeed({ code: 0, output: 'line one\nline two\nafter\n', used: { peak: 1048576, cpu: 2 } }))
    );
  });

  it('marks a container the kernel killed a process of for memory', async () => {
    const exit = await use(layer, s => Stream.runCollect(s.lines(command(tmp('work'), { args: ['-c', 'oomed'] }))));
    const pieces = Exit.isSuccess(exit) ? exit.value : [];
    expect(pieces.at(-1)).toEqual({ code: 137, used: { peak: 67108864, cpu: 2, oom: true } });
    expect(pieces.filter(p => typeof p === 'string' && p.includes('agentgraph-used'))).toEqual([]);
  });

  it('fails as infra when docker cannot start the container', async () => {
    const exit = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'exit125'] })));
    expect(JSON.stringify(exit)).toContain('"reason":"infra"');
  });

  it('fails as a timeout when the command runs past its minutes', async () => {
    const exit = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'sleep'], minutes: 0.01 })));
    expect(JSON.stringify(exit)).toContain('"reason":"timeout"');
  });

  it('ends a session that keeps printing at its minutes', async () => {
    const exit = await use(layer, s =>
      Stream.runCollect(s.lines(command(tmp('work'), { args: ['-c', 'chatty'], minutes: 0.01 })))
    );
    expect(JSON.stringify(exit)).toContain('"reason":"timeout"');
  });

  it('mounts no git dir a work tree names, only the ones recorded for a checkout', async () => {
    const dir = tmp('work');
    writeFileSync(join(dir, '.git'), 'gitdir: /tmp/x\n');
    await use(layer, s => s.exec(command(dir)));
    expect(logged().join('\n')).not.toContain('/tmp/x');

    const data = tmp('data');
    const exit = await use(dockerSandbox({ data, origin: origin() }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        writeFileSync(join(work.dir, '.git'), 'gitdir: /tmp/x\n');
        yield* s.exec(command(work.dir));
        return logged().filter(a => a.startsWith('type=bind'));
      })
    );
    const mirror = join(data, 'mirror.git');
    const binds = Exit.isSuccess(exit) ? exit.value : [];
    expect(binds.join('\n')).not.toContain('/tmp/x');
    expect(binds).toHaveLength(5);
    expect(binds[1]).toMatch(new RegExp(`^type=bind,src=(/private)?${mirror},dst=.*,readonly$`));
    expect(binds[2]).toMatch(new RegExp(`^type=bind,src=(/private)?${mirror}/worktrees/\\w+,dst=`));
    expect(binds[3]).toMatch(new RegExp(`^type=bind,src=${data}/cache/news/\\w+,dst=/news,readonly$`));
  });

  it.each([
    ['main', false],
    ['main', true],
    [undefined, false],
    [undefined, true],
  ] as const)('isolates writable scratch outside %s and cleans it after failure=%s', async (ref, isFailure) => {
    const data = tmp('data');
    const keep = ref && 'refs/agentgraph/runs/scratch';
    let scratch = '';
    const exit = await use(dockerSandbox({ data, origin: origin(), cache: '' }), s =>
      Effect.gen(function* () {
        const first = yield* s.checkout(ref, undefined, keep);
        const second = yield* s.checkout(ref);
        scratch = join(data, 'cache', 'scratch', basename(first.dir));
        writeFileSync(join(scratch, 'capture.png'), 'pixels');
        yield* s.exec(command(first.dir, { readonly: true }));
        const mounts = logged().filter(a => a.startsWith('type=bind'));
        const result = {
          mount: mounts.find(m => m.endsWith('dst=/scratch')),
          work: mounts.find(m => m.includes('dst=/work')),
          separate: readdirSync(join(data, 'cache', 'scratch', basename(second.dir))),
          checkout: readdirSync(first.dir),
        };
        return isFailure ? yield* Effect.fail(result) : result;
      })
    );
    const result = Exit.isSuccess(exit) ? exit.value : Exit.isFailure(exit) && exit.cause;
    expect(JSON.stringify(result)).toContain(`type=bind,src=${scratch},dst=/scratch`);
    expect(JSON.stringify(result)).toContain('dst=/work,readonly');
    expect(JSON.stringify(result)).toContain('"separate":[]');
    expect(JSON.stringify(result)).not.toContain('capture.png');
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(join(data, 'cache', 'scratch'))).toEqual([]);
    expect(keep ? git(join(data, 'mirror.git'), 'ls-tree', '-r', '--name-only', keep) : '').not.toContain(
      'capture.png'
    );
  });

  it('runs every command of a checkout in its graph image and, with network models, on the proxy-only network', async () => {
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main', undefined, undefined, {
          image: 'acme-rust:1',
          network: 'models',
          setup: 'withdeps',
        });
        yield* s.exec(command(work.dir, { network: 'proxy' }));
        return logged();
      })
    );
    const args = Exit.isSuccess(exit) ? exit.value : [];
    expect(args[args.indexOf('--network') + 1]).toBe('agentgraph-models');
    expect(args.join('\n')).not.toContain('HTTPS_PROXY');
    expect(args.slice(-10, -8)).toEqual([expect.stringMatching(/^agentgraph-env\/agentgraph-origin-\w+:\w+$/), 'sh']);
    const build = readFileSync(`${log}.all`, 'utf8')
      .split('\n')
      .findLast(l => l.includes('agentgraph.envbuild'));
    expect(build).toContain(' sha256:base sh -c ');
    expect(build).toContain('run --log-driver none ');
  });

  it.each([undefined, 'main'])('pins the graph image without cache for checkout %s', async ref => {
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin(), cache: '' }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout(ref, undefined, undefined, { image: 'custom:1' });
        yield* s.exec(command(work.dir));
        return logged();
      })
    );
    expect(Exit.isSuccess(exit) && exit.value).toContain('sha256:base');
  });

  it('mounts no cache volume in a container outside a checkout', async () => {
    await use(layer, s => s.exec(command(tmp('work'))));
    expect(logged().join('\n')).not.toContain('type=volume');
    expect(logged().join('\n')).not.toContain('npm_config_cache');
  });

  it('keeps repos whose names sanitize alike apart', async () => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      Effect.all(
        ['acme/one-two', 'acme-one/two'].map(repo =>
          s.checkout('main', undefined, undefined, { repo, toolchain: 'true' })
        )
      )
    );
    const keys = Exit.isSuccess(exit) ? exit.value.map(w => w.env?.key) : [];
    expect(new Set(keys).size).toBe(2);
    const text = readFileSync(all, 'utf8');
    const builds = text.split('\n').filter(l => l.includes('agentgraph.envbuild'));
    expect(builds).toHaveLength(2);
    const caches = new Set(builds.map(l => /src=(\S+),dst=\/cache /.exec(l)?.[1]));
    expect([...caches]).toEqual([
      expect.stringMatching(/^agentgraph-cache-acme-one-two-/),
      expect.stringMatching(/^agentgraph-cache-acme-one-two-/),
    ]);
  });

  it('keeps one cache volume per repo and setup, reused by every checkout of them', async () => {
    const all = `${log}.all`;
    writeFileSync(all, '');
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s =>
      Effect.gen(function* () {
        for (const repo of ['acme/one', 'acme/one', 'acme/two']) {
          const work = yield* s.checkout('main', undefined, undefined, { repo, toolchain: 'true' });
          yield* s.exec(command(work.dir));
        }
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const caches = [...readFileSync(all, 'utf8').matchAll(/volume create --label agentgraph\.cache=(\S+) (\S+)/g)];
    expect(caches.every(([, label, name]) => label === name)).toBe(true);
    const names = [...new Set(caches.map(([, name]) => name!))];
    expect(names).toEqual([
      expect.stringMatching(/^agentgraph-cache-acme-one-[0-9a-f]{24}$/),
      expect.stringMatching(/^agentgraph-cache-acme-two-[0-9a-f]{24}$/),
    ]);
    const builds = readFileSync(all, 'utf8')
      .split('\n')
      .filter(l => l.includes('agentgraph.envbuild'));
    expect(builds.map(l => /src=(\S+),dst=\/cache /.exec(l)?.[1])).toEqual(names);
    const text = readFileSync(all, 'utf8');
    const readOverlayLower = (overlay: string) =>
      new RegExp(`volume create .*--label agentgraph\\.lower=(\\S+) .* ${overlay}$`, 'm').exec(text)?.[1];
    const execs = text
      .split('\n')
      .filter(l => l.includes('echo hi'))
      .map(l => readOverlayLower(/src=(agentgraph-layer-\w+-c-o),dst=\/cache,/.exec(l)?.[1] ?? 'none'));
    expect(execs).toEqual([names[0], names[0], names[1]]);
    expect(text).not.toMatch(/src=agentgraph-cache,|agentgraph-cache /);
  });
});
describe('docker checkout', () => {
  beforeAll(() => fakeDocker().restore);

  it.each(['main', 'origin/HEAD'])('reads %s without starting or inspecting a sandbox image', async ref => {
    const repo = origin();
    const bin = tmp('docker-bin');
    const log = join(bin, 'log');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho called >> ${log}\nexit 1\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const exit = await use(
        dockerSandbox({ data: tmp('data'), origin: join(repo, '.git'), local: true, cache: '' }),
        s => s.readHead(ref)
      );
      expect(exit).toEqual(Exit.succeed(git(repo, 'rev-parse', 'main')));
      expect(existsSync(log)).toBe(false);
    } finally {
      process.env.PATH = path;
    }
  });

  it('sends the token to clone and fetch through the environment only', async () => {
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = tmp('git-bin');
    const log = join(bin, 'log');
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "argv $*" >> ${log}\necho "env $GIT_CONFIG_COUNT $GIT_CONFIG_KEY_0 $GIT_CONFIG_VALUE_0" >> ${log}\nexec ${real} "$@"\n`
    );
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    const data = tmp('data');
    const token = 'ghs_secret_token_value';
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    try {
      const layer = dockerSandbox({ data, origin: origin(), token: Effect.succeed(token) });
      const exit = await use(layer, s => Effect.andThen(s.checkout('main'), s.checkout('main')));
      expect(Exit.isSuccess(exit)).toBe(true);
    } finally {
      process.env.PATH = path;
    }
    const lines = readFileSync(log, 'utf8').split('\n');
    const authed = lines.flatMap((line, i) =>
      line.startsWith('argv') && /clone|fetch/.test(line) ? [lines[i + 1]] : []
    );
    expect(authed).toEqual([
      `env 1 http.https://github.com/.extraheader ${header}`,
      `env 1 http.https://github.com/.extraheader ${header}`,
    ]);
    const rest = lines.flatMap((line, i) =>
      line.startsWith('argv') && !/clone|fetch/.test(line) ? [lines[i + 1]] : []
    );
    expect(rest.every(line => !line?.includes('extraheader'))).toBe(true);
    const argv = lines.filter(line => line.startsWith('argv')).join('\n');
    expect(argv).not.toContain(token);
    expect(argv).not.toContain(header.split(' ').at(-1));
    const config = readFileSync(join(data, 'mirror.git', 'config'), 'utf8');
    expect(config).not.toContain(header.split(' ').at(-1));
    expect(config).not.toContain(token);
    expect(config).not.toContain('extraheader');
  });

  it('mirrors branches, tags and the default branch head but not pull refs', async () => {
    const data = tmp('data');
    const from = origin();
    git(from, 'tag', 'v1');
    git(from, 'update-ref', 'refs/pull/1/head', 'feature');
    const layer = dockerSandbox({ data, origin: from });
    for (const _ of [0, 1]) expect(Exit.isSuccess(await use(layer, s => s.checkout('main')))).toBe(true);
    const refs = git(join(data, 'mirror.git'), 'for-each-ref', '--format=%(refname)').split('\n');
    expect(refs).toEqual(['refs/heads/feature', 'refs/heads/main', 'refs/remotes/origin/HEAD', 'refs/tags/v1']);
    expect(Exit.isSuccess(await use(layer, s => s.checkout('origin/HEAD')))).toBe(true);
  });

  it('lets two processes create the mirror at the same time', async () => {
    const data = tmp('data');
    const from = origin();
    const exits = await Promise.all(
      [0, 1].map(() => use(dockerSandbox({ data, origin: from }), s => s.checkout('main')))
    );
    expect(exits.map(Exit.isSuccess)).toEqual([true, true]);
    expect(readdirSync(data).filter(n => n.startsWith('mirror'))).toEqual(['mirror.git']);
  });

  it('checks out a ref or the existing branch from a mirror and removes the worktree with the scope', async () => {
    const data = tmp('data');
    const layer = dockerSandbox({ data, origin: origin() });
    let kept = '';
    const exit = await use(layer, s =>
      Effect.gen(function* () {
        const main = yield* s.checkout('main');
        const feature = yield* s.checkout('main', 'feature');
        const fresh = yield* s.checkout('main', 'missing');
        kept = main.dir;
        return [main, feature, fresh].map(c => [
          readFileSync(join(c.dir, 'a.txt'), 'utf8').trim(),
          (c.head ?? c.base) === git(c.dir, 'rev-parse', 'HEAD'),
          c.base === git(c.dir, 'merge-base', 'HEAD', 'main'),
        ]);
      })
    );
    expect(exit).toEqual(
      Exit.succeed([
        ['main', true, true],
        ['feature', true, true],
        ['main', true, true],
      ])
    );
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(join(data, 'mirror.git', 'HEAD'))).toBe(true);
  });

  it('keeps the files under the keep ref through a fetch and puts them back on the next checkout', async () => {
    const data = tmp('data');
    const layer = dockerSandbox({ data, origin: origin() });
    const keep = 'refs/agentgraph/runs/r1';
    const first = await use(layer, s =>
      Effect.map(s.checkout('main', 'feature', keep), c => writeFileSync(join(c.dir, 'b.txt'), 'kept\n'))
    );
    expect(Exit.isSuccess(first)).toBe(true);
    const second = await use(layer, s =>
      Effect.map(s.checkout('main', undefined, keep), c => [
        readFileSync(join(c.dir, 'a.txt'), 'utf8').trim(),
        readFileSync(join(c.dir, 'b.txt'), 'utf8').trim(),
        c.head === git(c.dir, 'rev-parse', 'refs/heads/feature'),
      ])
    );
    expect(second).toEqual(Exit.succeed(['feature', 'kept', true]));
    expect(git(join(data, 'mirror.git'), 'rev-list', '--count', keep)).toBe('4');
  });

  it('saves a checkout whose runner died before it saved, on the next start', async () => {
    const data = tmp('data');
    const repo = origin();
    let id = '';
    const exit = await use(dockerSandbox({ data, origin: repo }), s =>
      Effect.flatMap(s.checkout('main'), c =>
        Effect.promise(() => {
          id = basename(c.dir);
          writeFileSync(join(c.dir, 'b.txt'), 'unfinished\n');
          writeFileSync(`${c.dir}.owner`, `${spawnSync('true').pid}:0123456789ab`);
          return use(dockerSandbox({ data, origin: repo }), () => Effect.void);
        })
      )
    );
    expect(exit).toEqual(Exit.succeed(Exit.succeed(undefined)));
    expect(git(join(data, 'mirror.git'), 'show', `refs/agentgraph/reaped/${id}:b.txt`)).toBe('unfinished');
  });

  it('commits an attempt once, so a repeat keeps the first commit', async () => {
    const data = tmp('data');
    const name = 'refs/agentgraph/attempts/r4/1';
    const exit = await use(dockerSandbox({ data, origin: origin() }), s =>
      Effect.gen(function* () {
        const c = yield* s.checkout('main');
        writeFileSync(join(c.dir, 'b.txt'), 'first\n');
        yield* commitCheckoutOnce(c.git, name, [c.base]);
        writeFileSync(join(c.dir, 'b.txt'), 'second\n');
        yield* commitCheckoutOnce(c.git, name, [c.base]);
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(git(join(data, 'mirror.git'), 'show', `${name}:b.txt`)).toBe('first');
  });

  it('puts kept files on the run branch after the branch moved on', async () => {
    const data = tmp('data');
    const repo = origin();
    const layer = dockerSandbox({ data, origin: repo });
    const keep = 'refs/agentgraph/runs/r2';
    await use(layer, s =>
      Effect.map(s.checkout('main', 'work', keep), c => writeFileSync(join(c.dir, 'b.txt'), 'second try\n'))
    );
    git(repo, 'checkout', '-q', '-b', 'work', 'main');
    writeFileSync(join(repo, 'b.txt'), 'first try\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'pushed');
    const tip = git(repo, 'rev-parse', 'work');
    const again = await use(layer, s =>
      Effect.map(s.checkout('main', 'work', keep), c => [
        readFileSync(join(c.dir, 'b.txt'), 'utf8').trim(),
        c.head === tip && c.base === git(repo, 'rev-parse', 'main'),
      ])
    );
    expect(again).toEqual(Exit.succeed(['second try', true]));
  });

  it('keeps the files through host git that nothing in the worktree can steer', async () => {
    const data = tmp('data');
    const keep = 'refs/agentgraph/runs/r3';
    const mirror = join(data, 'mirror.git');
    let planted = { marker: '', victim: '' };
    let dir = '';
    const exit = await use(dockerSandbox({ data, origin: origin() }), s =>
      Effect.map(s.checkout('main', undefined, keep), c => {
        dir = c.dir;
        writeFileSync(join(c.dir, 'b.txt'), 'kept\n');
        const admin = readFileSync(join(c.dir, '.git'), 'utf8').slice('gitdir: '.length).trim();
        planted = plant(c.dir, admin);
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(existsSync(planted.marker)).toBe(false);
    expect(readFileSync(join(planted.victim, 'keep.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(dir)).toBe(false);
    expect(git(mirror, 'show', `${keep}:b.txt`)).toBe('kept');
    expect(git(mirror, 'worktree', 'list', '--porcelain')).not.toContain(dir);
  });

  it('fetches while a live checkout claims a branch as its HEAD', async () => {
    const data = tmp('data');
    const repo = origin();
    const layer = dockerSandbox({ data, origin: repo });
    const exit = await use(layer, s =>
      Effect.gen(function* () {
        const c = yield* s.checkout('main');
        const admin = readFileSync(join(c.dir, '.git'), 'utf8').slice('gitdir: '.length).trim();
        writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/main\n');
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'moved');
        const next = yield* s.checkout('main');
        return next.base === git(repo, 'rev-parse', 'main');
      })
    );
    expect(exit).toEqual(Exit.succeed(true));
  });

  it('fails for a ref that does not exist', async () => {
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: origin() }), s => s.checkout('nope'));
    expect(JSON.stringify(exit)).toContain('no commit for nope');
  });
});

/** Real containers: `AGENTGRAPH_DOCKER=1` with the agentgraph-sandbox network and the agentgraph-sandbox:local image present. */
describe.runIf(process.env.AGENTGRAPH_DOCKER === '1')('docker for real', () => {
  it('runs a command in the sandbox image with no network', async () => {
    const dir = tmp('work');
    writeFileSync(join(dir, 'x.txt'), 'inside\n');
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: '/nowhere' }), s =>
      s.exec(command(dir, { args: ['-c', 'cat x.txt; id -u; touch /etc/x 2>/dev/null || echo read-only'] }))
    );
    expect(Exit.isSuccess(exit) && exit.value.output).toMatch(/^inside\n\d+\nread-only\n$/);
  }, 60_000);

  it('reads the graph at AGENTGRAPH_DIR and cannot write it', async () => {
    const graph = tmp('graph');
    writeFileSync(join(graph, 'x.sh'), 'graph script\n');
    const script = 'cat "$AGENTGRAPH_DIR/x.sh"; touch "$AGENTGRAPH_DIR/y" 2>/dev/null || echo read-only';
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: '/nowhere' }), s =>
      s.exec(command(tmp('work'), { args: ['-c', script], graph }))
    );
    expect(Exit.isSuccess(exit) && exit.value.output).toBe('graph script\nread-only\n');
    expect(existsSync(join(graph, 'y'))).toBe(false);
  }, 60_000);

  it("keeps one copy of a sandbox setup's dependencies however many checkouts use it, each with only its own writes", async () => {
    const repo = origin();
    writeFileSync(join(repo, 'package.json'), '{}\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'deps');
    const graph = {
      repo: 'agentgraph-disk-test',
      setup: 'mkdir -p node_modules/x && head -c 5000000 /dev/urandom > node_modules/x/blob',
    };
    const sh = (dir: string, script: string) => (s: Sandbox['Service']) =>
      s.exec(command(dir, { args: ['-c', script] }));
    const kb = (args: string[]) => Number(execFileSync('docker', args, { encoding: 'utf8' }).trim().split(/\s+/)[0]);
    const exit = await use(dockerSandbox({ data: tmp('data'), origin: repo, cache: 'agentgraph-disk-test-cache' }), s =>
      Effect.gen(function* () {
        const works = yield* Effect.all(
          [1, 2, 3].map(() => s.checkout('main', undefined, undefined, graph)),
          {
            concurrency: 3,
          }
        );
        yield* sh(works[0]!.dir, 'echo mine > node_modules/mine')(s);
        const seen = yield* sh(works[1]!.dir, 'ls node_modules; du -sk node_modules/x')(s);
        const uppers = works.map(w =>
          kb([
            'run',
            '--rm',
            '-u',
            '0',
            '-v',
            `agentgraph-layer-${basename(w.dir)}-0:/u`,
            'agentgraph-sandbox:local',
            'du',
            '-sk',
            '/u',
          ])
        );
        const host = works.map(w =>
          kb(['run', '--rm', '-v', `${w.dir}:/w`, 'agentgraph-sandbox:local', 'du', '-sk', '/w'])
        );
        return { seen: seen.output, uppers, host, ids: works.map(w => basename(w.dir)) };
      })
    );
    const keys = execFileSync(
      'docker',
      ['image', 'ls', '--format', '{{.Tag}}', 'agentgraph-env/agentgraph-disk-test'],
      {
        encoding: 'utf8',
      }
    );
    try {
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      expect(exit.value.seen).toMatch(/^x\n4\d{3}\s/);
      expect(Math.max(...exit.value.uppers)).toBeLessThan(64);
      expect(Math.max(...exit.value.host)).toBeLessThan(64);
      const left = execFileSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' });
      for (const id of exit.value.ids) expect(left).not.toContain(id);
    } finally {
      for (const key of keys.split('\n').filter(Boolean)) {
        spawnSync('docker', ['rmi', '-f', `agentgraph-env/agentgraph-disk-test:${key}`]);
        spawnSync('docker', ['volume', 'rm', `agentgraph-lower-${key}`]);
      }
      const caches = execFileSync('docker', ['volume', 'ls', '-q', '--filter', 'label=agentgraph.cache'], {
        encoding: 'utf8',
      });
      for (const name of caches.split('\n').filter(n => n.startsWith('agentgraph-disk-test-cache-')))
        spawnSync('docker', ['volume', 'rm', name]);
    }
  }, 900_000);
});

/**
 * One real opencode session in docker against the model proxy: `AGENTGRAPH_LIVE=1` and `AGENTGRAPH_PROXY_KEYS` holding a key
 * for `implementor`. Uses the `fast` alias unless `AGENTGRAPH_LIVE_MODEL` names another.
 */
describe.runIf(process.env.AGENTGRAPH_LIVE === '1')('opencode for real', () => {
  it('answers, is denied a read outside the allowlist, and resumes', async () => {
    const dir = tmp('work');
    writeFileSync(join(dir, 'note.txt'), 'the word is kumquat\n');
    const layer = harnessSession({
      data: tmp('data'),
      proxy: { url: 'http://litellm:4000/v1', keys: Redacted.make(process.env.AGENTGRAPH_PROXY_KEYS ?? '') },
      prices: join(import.meta.dirname, '../infra/local/prices.json'),
      harnesses,
    }).pipe(Layer.provide(dockerSandbox({ data: tmp('data'), origin: '/nowhere' })));
    const open = (prompt: string, resume?: { id: string; home: string }) =>
      Effect.runPromise(
        Session.pipe(
          Effect.flatMap(s =>
            Stream.runCollect(
              s.open({
                harness: 'opencode',
                agent: 'implementor',
                model: process.env.AGENTGRAPH_LIVE_MODEL ?? 'fast',
                system: 'You are a terse assistant. Use tools when asked.',
                prompt,
                dir,
                tools: ['read', 'bash(git status*)'],
                minutes: 5,
                ...(resume && { resume }),
              })
            )
          ),
          Effect.scoped,
          Effect.provide(layer)
        )
      );
    const first = await open(
      'Read note.txt, then run the bash command `ls /` even if you expect it to fail. Then say the word from the note.'
    );
    if (process.env.AGENTGRAPH_LIVE_OUT) writeFileSync(process.env.AGENTGRAPH_LIVE_OUT, JSON.stringify(first, null, 1));
    const start = first.find(e => e.type === 'start');
    const end = first.at(-1);
    expect(start).toMatchObject({ type: 'start' });
    expect(first.some(e => e.type === 'usage' && (e.usd ?? 0) > 0)).toBe(true);
    expect(first).toContainEqual(expect.objectContaining({ type: 'tool', name: 'bash', denied: true }));
    expect(end).toMatchObject({ type: 'end', ended: 'stop', exit: 0 });
    expect(end?.type === 'end' && end.final.toLowerCase()).toContain('kumquat');
    if (start?.type !== 'start') return;
    const second = await open('What was the word? Answer with the word only.', { id: start.session, home: start.home });
    expect(second.find(e => e.type === 'start')).toMatchObject({ session: start.session });
    expect(second.at(-1)).toMatchObject({ type: 'end', ended: 'stop', exit: 0 });
    if (process.env.AGENTGRAPH_LIVE_OUT)
      writeFileSync(`${process.env.AGENTGRAPH_LIVE_OUT}.2`, JSON.stringify(second, null, 1));
  }, 600_000);
});

describe('disk lifecycle', () => {
  it('finds node_modules beside each package.json and target beside the outermost Cargo.toml', async () => {
    const dir = tmp('deps');
    for (const f of ['package.json', 'packages/a/package.json', 'vendor/node_modules/x/package.json', 'Cargo.toml'])
      write(dir, { [f]: '' });
    write(dir, { 'crates/b/Cargo.toml': '' });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-f', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    expect(await dependencyDirs(join(dir, '.git'), 'main')).toEqual([
      'node_modules',
      'target',
      'packages/a/node_modules',
    ]);
  });

  it('keys a skeleton by the files a package manager reads and the ignore rules, with near empty Cargo targets', async () => {
    const dir = tmp('skeleton');
    const files = [
      '.gitignore',
      'package.json',
      'pnpm-lock.yaml',
      '.npmrc',
      'patches/x.patch',
      'src/index.ts',
      'src/main.rs',
    ];
    const crate = [
      'crates/a/Cargo.toml',
      'crates/a/src/lib.rs',
      'crates/a/build.rs',
      'crates/a/src/util.rs',
      'crates/a/src/bin/x.rs',
      'crates/a/benches/b.rs',
      'crates/a/tests/t.rs',
      'crates/a/tests/d/main.rs',
      'crates/a/tests/d/util.rs',
    ];
    for (const f of [...files, ...crate, 'vendor/node_modules/y/package.json']) write(dir, { [f]: f });
    git(dir, 'init', '-q', '-b', 'main');
    const commit = () => (
      git(dir, 'add', '-f', '.'),
      git(dir, 'commit', '-q', '-m', 'x'),
      readDependencySkeleton(join(dir, '.git'), 'main')
    );
    const one = await commit();
    expect(one.paths.sort()).toEqual([
      '.gitignore',
      '.npmrc',
      'crates/a/Cargo.toml',
      'package.json',
      'patches/x.patch',
      'pnpm-lock.yaml',
    ]);
    expect(one.targets.toSorted()).toEqual([
      'crates/a/benches/b.rs',
      'crates/a/build.rs',
      'crates/a/src/bin/x.rs',
      'crates/a/src/lib.rs',
      'crates/a/tests/d/main.rs',
      'crates/a/tests/t.rs',
    ]);
    write(dir, { 'src/index.ts': 'changed' });
    write(dir, { 'crates/a/src/lib.rs': 'changed' });
    expect((await commit()).digest).toBe(one.digest);
    write(dir, { 'pnpm-lock.yaml': 'changed' });
    expect((await commit()).digest).not.toBe(one.digest);
  });

  it('layers overlays over the sandbox setup copy where it made a dependency dir and empty volumes elsewhere', async () => {
    await faked({ 'volume inspect': '/lower\\n/u0\\n' }, async log => {
      const sharedMounts = await createSharedMounts(
        { image: 'img', outputs: ['node_modules', 'dist'], lower: 'agentgraph-lower-k' },
        'own',
        tmp('work'),
        ['node_modules', 'packages/a/node_modules']
      );
      expect(sharedMounts).toEqual([
        { name: 'agentgraph-layer-own-0-o', dst: '/work/node_modules', upper: 'agentgraph-layer-own-0' },
        { name: 'agentgraph-layer-own-1', dst: '/work/packages/a/node_modules' },
      ]);
      expect(log()).toMatch(
        /volume create --label agentgraph\.layer=\d+:[0-9a-f]{12}:\S+ --label agentgraph\.owner=own agentgraph-layer-own-1/
      );
      expect(log()).toContain(
        'o=lowerdir=/lower/.agentgraph-env/data/0,upperdir=/u0/upper,workdir=/u0/work agentgraph-layer-own-0-o'
      );
      expect(log()).toContain('type=volume,src=agentgraph-lower-k,dst=/lower,readonly');
      expect(log()).not.toContain('/u/1/upper');
      expect(log()).toContain(`cp -a '/lower/.agentgraph-env/rest/dist' '/dst/'/`);
      await discard(sharedMounts);
      expect(log()).toContain('volume rm -f agentgraph-layer-own-0-o agentgraph-layer-own-1 agentgraph-layer-own-0');
    });
  });

  it('refuses a symlink in the sandbox setup copy before any overlay names it', async () => {
    await faked(
      { 'volume inspect': '/lower\\n/u0\\n', 'run*/lower/.agentgraph-env/data/0*-L': "'; exit 1; '" },
      async log => {
        await expect(
          createSharedMounts(
            { image: 'img', outputs: ['node_modules'], lower: 'agentgraph-lower-k' },
            'link',
            tmp('work'),
            []
          )
        ).rejects.toThrow();
        expect(log()).not.toContain('agentgraph-env/data/0,upperdir');
        expect(log()).toContain('volume rm -f agentgraph-layer-link-0');
      }
    );
  });

  it('gives a checkout its own overlay over the shared cache, so run code never writes it', async () => {
    await faked({ 'volume inspect': '/m/a\\n/m/b\\n' }, async log => {
      const sharedMounts = await createSharedMounts(
        { image: 'img', outputs: [] },
        'own',
        tmp('work'),
        [],
        'agentgraph-cache'
      );
      expect(sharedMounts).toEqual([
        { name: 'agentgraph-layer-own-c-o', dst: '/cache', upper: 'agentgraph-layer-own-c' },
      ]);
      expect(log()).toContain('o=lowerdir=/m/a,upperdir=/m/b/upper,workdir=/m/b/work agentgraph-layer-own-c-o');
      const args = dockerArgs({ cmd: 'true', args: [], dir: '/w', env: {}, network: 'none', minutes: 1 }, 'img', 'n', {
        mounts: [],
        sharedMounts,
        cache: 'agentgraph-cache',
      });
      expect(args).toContain('type=volume,src=agentgraph-layer-own-c-o,dst=/cache,volume-nocopy');
      expect(args.join(' ')).not.toContain('src=agentgraph-cache');
      expect(args).toContain('npm_config_cache=/cache/npm');
    });
  });

  it('counts the files a checkout wrote over the shared cache', async () => {
    await faked({ run: '3\\n' }, async log => {
      expect(await written([{ name: 'x-o', dst: '/cache', upper: 'x' }], 'img')).toBe(3);
      expect(log()).toContain('type=volume,src=x,dst=/u,readonly');
      expect(await written([{ name: 'y', dst: '/work/node_modules' }], 'img')).toBeUndefined();
    });
  });

  it('reaps checkouts whose owner is gone and keeps live ones', async () => {
    await faked({}, async () => {
      const data = tmp('data');
      for (const id of ['mine', 'none', 'gone']) {
        mkdirSync(join(data, 'cache', 'work', id, 'node_modules'), { recursive: true });
        mkdirSync(join(data, 'cache', 'scratch', id), { recursive: true });
      }
      writeCheckoutOwner(join(data, 'cache', 'work', 'mine'));
      writeFileSync(join(data, 'cache', 'work', 'gone.owner'), `${spawnSync('true').pid}:0123456789ab`);
      expect(findDeadCheckouts(data).toSorted()).toEqual(['gone', 'none']);
      const mirror = join(data, 'mirror.git');
      git(data, 'init', '-q', '--bare', mirror);
      writeFileSync(join(data, 'cache', 'work', 'gone', 'left.txt'), 'unfinished\n');
      expect(Exit.isSuccess(await use(dockerSandbox({ data, origin: '/nowhere' }), () => Effect.void))).toBe(true);
      expect(readdirSync(join(data, 'cache', 'work')).toSorted()).toEqual(['mine', 'mine.owner']);
      expect(readdirSync(join(data, 'cache', 'scratch'))).toEqual(['mine']);
      expect(git(mirror, 'show', 'refs/agentgraph/reaped/gone:left.txt')).toBe('unfinished');
      expect(isOwnerRunning(startHeartbeat())).toBe(true);
    });
  });

  it('reaps a dead checkout once when two sandboxes start together', async () => {
    await faked({}, async () => {
      const data = tmp('data');
      mkdirSync(join(data, 'cache', 'work', 'gone'), { recursive: true });
      writeFileSync(join(data, 'cache', 'work', 'gone', 'left.txt'), 'unfinished\n');
      const mirror = join(data, 'mirror.git');
      git(data, 'init', '-q', '--bare', mirror);
      const warnings: string[] = [];
      const logger = Logger.layer([Logger.make(({ message }) => void warnings.push(String(message)))]);
      const start = () =>
        Effect.runPromiseExit(
          Effect.void.pipe(Effect.provide(dockerSandbox({ data, origin: '/nowhere' })), Effect.provide(logger))
        );
      expect((await Promise.all([start(), start()])).every(Exit.isSuccess)).toBe(true);
      expect(warnings).toEqual([]);
      expect(readdirSync(join(data, 'cache', 'work'))).toEqual([]);
      expect(git(mirror, 'show', 'refs/agentgraph/reaped/gone:left.txt')).toBe('unfinished');
    });
  });

  it('keeps a dead checkout it cannot save', async () => {
    await faked({}, async () => {
      const data = tmp('data');
      mkdirSync(join(data, 'cache', 'work', 'lost'), { recursive: true });
      writeFileSync(join(data, 'cache', 'work', 'lost', 'left.txt'), 'unfinished\n');
      expect(Exit.isSuccess(await use(dockerSandbox({ data, origin: '/nowhere' }), () => Effect.void))).toBe(true);
      expect(readFileSync(join(data, 'cache', 'work', 'lost', 'left.txt'), 'utf8')).toBe('unfinished\n');
    });
  });

  it('counts an owner whose heartbeat went stale as live while its pid runs', () => {
    const saved = process.env.AGENTGRAPH_STATE;
    process.env.AGENTGRAPH_STATE = tmp('state');
    try {
      const owner = 'fedcba987654';
      const heartbeat = join(process.env.AGENTGRAPH_STATE, 'owners', owner);
      mkdirSync(dirname(heartbeat), { recursive: true });
      writeFileSync(heartbeat, '');
      utimesSync(heartbeat, new Date(0), new Date(0));
      expect(isOwnerRunning(`${process.pid}:${owner}`)).toBe(true);
      expect(isOwnerRunning(`${spawnSync('true').pid}:${owner}`)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AGENTGRAPH_STATE;
      else process.env.AGENTGRAPH_STATE = saved;
    }
  });
});

describe('removeOrphanedVolumes', () => {
  it('reports an error when docker does not answer in time', async () => {
    const bin = tmp('bin');
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexec sleep 5\n');
    chmodSync(join(bin, 'docker'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const started = Date.now();
      await expect(removeOrphanedVolumes(200)).rejects.toThrow('docker volume');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('image precedence', () => {
  it.each([null, 12, {}])('rejects an unknown case image %j without a fallback', async override => {
    await faked({}, async log => {
      const exit = await Effect.runPromiseExit(readImage({}, undefined, override as never));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(log()).toBe('');
    });
  });

  it.each([
    [{ image: 'graph:1' }, 'operator:1', 'case:1', 'case:1'],
    [{ image: 'graph:1' }, 'operator:1', undefined, 'graph:1'],
    [{}, 'operator:1', undefined, 'operator:1'],
    [{}, undefined, undefined, 'agentgraph-sandbox:local'],
  ] as const)('resolves %j with fallback %s and override %s', async (graph, fallback, override, tag) => {
    await faked({ 'image inspect': 'sha256:pinned' }, async log => {
      const id = await Effect.runPromise(readImage(graph, fallback, override));
      expect(id).toBe('sha256:pinned');
      expect(log()).toContain(`{{.Id}} ${tag}`);
    });
  });
});

describe('deployment image startup', () => {
  it('requires a named instance and fails a missing custom tag without building stock contents', async () => {
    const bin = tmp('startup');
    const data = join(bin, 'data');
    const log = join(bin, 'calls');
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in "image inspect custom:missing") exit 1;; esac\n`
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const script = join(import.meta.dirname, '../examples/deploy/engine/start.sh');
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      AGENTGRAPH_DATA: data,
      AGENTGRAPH_IMAGE: 'custom:missing',
      AGENTGRAPH_RUNNER: 'local',
    };
    const unprovisioned = spawnSync('sh', [script], { encoding: 'utf8', env });
    expect([unprovisioned.status, unprovisioned.stderr]).toEqual([1, expect.stringContaining('provision')]);
    await ensureInstance(data, 'live', origin());
    const result = spawnSync('sh', [script], { encoding: 'utf8', env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing custom image custom:missing');
    expect(readFileSync(log, 'utf8')).not.toContain('build');
  });
});

describe('image check without a docker daemon', () => {
  it('says docker is unreachable instead of calling a pinned image missing', async () => {
    const bin = tmp('daemon-down');
    writeFileSync(
      join(bin, 'docker'),
      '#!/bin/sh\necho "Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?" >&2\nexit 1\n'
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    const exit = await Effect.runPromiseExit(readImage({}, undefined, 'sha256:gone'));
    process.env.PATH = path;
    expect(JSON.stringify(exit)).toContain('Cannot connect to the Docker daemon');
    expect(JSON.stringify(exit)).not.toContain('is missing');
  });
});

describe('image command contract', () => {
  it('rejects an entrypoint that ignores the supplied command', async () => {
    const bin = tmp('image-contract');
    writeFileSync(
      join(bin, 'docker'),
      '#!/bin/sh\ncase "$1" in image) echo sha256:bad-entrypoint;; run) echo service-started;; esac\n'
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    const exit = await Effect.runPromiseExit(readImage({ image: 'custom:entrypoint' }));
    process.env.PATH = path;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('must run supplied commands directly');
  });
});
