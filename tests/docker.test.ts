import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { Chunk, Effect, Exit, Layer, Redacted, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker, dockerArgs } from '../src/docker.ts';
import { beat, dependencyDirs, live, discard, layer, mark, reap, sweep, toolchainOf, written } from '../src/env.ts';
import { harnesses } from '../src/harnesses.ts';
import { type Command, Sandbox } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { faked, git, plant, put, tmp } from './fixtures.ts';

/** A repo with one commit on `main` and a `feature` branch one commit ahead. */
const origin = () => {
  const dir = tmp('origin');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'main\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'main');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'a.txt'), 'feature\n');
  git(dir, 'commit', '-q', '-am', 'feature');
  git(dir, 'checkout', '-q', 'main');
  return dir;
};

const use = <A, E>(
  layer: Layer.Layer<Sandbox>,
  f: (s: Sandbox['Type']) => Effect.Effect<A, E, import('effect').Scope.Scope>
) => Effect.runPromiseExit(Sandbox.pipe(Effect.flatMap(f), Effect.scoped, Effect.provide(layer)));

const command = (dir: string, more: Partial<Command> = {}): Command => ({
  cmd: 'sh',
  args: ['-c', 'echo hi'],
  dir,
  env: { A: '1' },
  network: 'none',
  minutes: 1,
  ...more,
});

describe('docker with a stand-in docker client', () => {
  const bin = tmp('bin');
  const log = join(bin, 'log');
  const path = process.env.PATH;
  beforeAll(() => {
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/bin/sh',
        `[ "$1" = network ] && { echo true; exit 0; }`,
        `[ "$1" = rm ] && { sleep 0.2; echo "$*" >> ${log}.rm; exit 0; }`,
        `[ "$1" = image ] && case "$*" in *Labels*) exit 1;; *) echo sha256:base; exit 0;; esac`,
        `[ "$1 $2" = "volume inspect" ] && for a; do case $a in agentgraph-*) echo /m/$a;; esac; done`,
        `case "$1" in commit|volume) echo "$*" >> ${log}.all; exit 0;; esac`,
        `printf '%s\\n' "$@" > ${log}`,
        `echo "$*" >> ${log}.all`,
        `echo "secret=\${AGENTGRAPH_LLM_API_KEY:-unset}" >> ${log}`,
        `echo line one; echo line two >&2`,
        `case "$*" in *exit125*) exit 125;; *chatty*) while :; do echo tick; sleep 0.05; done;; *sleep*) sleep 5;; *toolfail*) exit 97;; *fail*) exit 3;; *withdeps*) printf '@@ignored\\nnode_modules/\\n@@untracked\\n@@lower\\n5\\n';; esac`,
      ].join('\n')
    );
    chmodSync(join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}${delimiter}${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
  });

  const layer = docker({ data: tmp('data'), origin: '/nowhere' });
  const logged = () => readFileSync(log, 'utf8').split('\n');

  it('runs a hardened container with secrets by name and their values only in the client env', async () => {
    const dir = tmp('work');
    const home = tmp('home');
    const exit = await use(layer, s =>
      s.exec(
        command(dir, { home, network: 'proxy', secrets: { AGENTGRAPH_LLM_API_KEY: Redacted.make('sk-value-123456') } })
      )
    );
    expect(exit).toEqual(Exit.succeed({ code: 0, output: 'line one\nline two\n' }));
    const args = logged();
    for (const flag of ['--rm', '--read-only', '--cap-drop=ALL', 'no-new-privileges=true', '--pull', 'never'])
      expect(args).toContain(flag);
    expect(args[args.indexOf('--network') + 1]).toBe('agentgraph-sandbox');
    expect(args).toContain(`type=bind,src=${dir},dst=/work`);
    expect(args).toContain(`type=bind,src=${home},dst=/home/agent`);
    expect(args).toContain('HOME=/home/agent');
    expect(args).toContain('HTTPS_PROXY=http://egress:8888');
    expect(args).toContain('A=1');
    expect(args.slice(args.indexOf('AGENTGRAPH_LLM_API_KEY') - 1, args.indexOf('AGENTGRAPH_LLM_API_KEY') + 1)).toEqual([
      '-e',
      'AGENTGRAPH_LLM_API_KEY',
    ]);
    expect(args.join(' ')).not.toContain('sk-value-123456=');
    expect(args.filter(a => a.includes('sk-value'))).toEqual(['secret=sk-value-123456']);
    expect(args.slice(-6, -2)).toEqual(['agentgraph-sandbox:local', 'sh', '-c', 'echo hi']);
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

  it('mounts the hub read-only at /hub and names it in AGENTGRAPH_HUB', async () => {
    const hub = tmp('hub');
    await use(layer, s => s.exec(command(tmp('work'), { hub })));
    const args = logged();
    expect(args).toContain(`type=bind,src=${hub},dst=/hub,readonly`);
    expect(args).toContain('AGENTGRAPH_HUB=/hub');
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
    expect(Exit.map(exit, Chunk.toArray)).toEqual(Exit.succeed(['line one', 'line two']));
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
    const exit = await use(docker({ data, origin: origin() }), s =>
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
    expect(binds).toHaveLength(4);
    expect(binds[1]).toMatch(new RegExp(`^type=bind,src=(/private)?${mirror},dst=.*,readonly$`));
    expect(binds[2]).toMatch(new RegExp(`^type=bind,src=(/private)?${mirror}/worktrees/\\w+,dst=`));
    expect(binds[3]).toMatch(new RegExp(`^type=bind,src=${data}/news/(\\w+),dst=${data}/news/\\1,readonly$`));
  });

  it('runs every command of a checkout in its hub image and, with network models, on the proxy-only network', async () => {
    const exit = await use(docker({ data: tmp('data'), origin: origin() }), s =>
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
    expect(args.slice(-6, -4)).toEqual([expect.stringMatching(/^agentgraph-env\/repo:\w+$/), 'sh']);
    const build = readFileSync(`${log}.all`, 'utf8')
      .split('\n')
      .findLast(l => l.includes('agentgraph.envbuild'));
    expect(build).toContain(' acme-rust:1 sh -c ');
    expect(build).toContain('run --log-driver none ');
  });

  it('mounts the cache volume read-only in every container, and none with an empty name', async () => {
    await use(layer, s => s.exec(command(tmp('work'))));
    expect(logged()).toContain('type=volume,src=agentgraph-cache,dst=/cache,readonly');
    expect(logged()).toContain('npm_config_cache=/tmp/npm');
    await use(docker({ data: tmp('data'), origin: '/nowhere', cache: '' }), s => s.exec(command(tmp('work'))));
    expect(logged().join('\n')).not.toContain('type=volume');
    const exit = await use(docker({ data: tmp('data'), origin: '/nowhere', cache: '--x' }), s =>
      s.exec(command(tmp('work')))
    );
    expect(JSON.stringify(exit)).toContain('volume name not allowed');
  });

  it("builds a hub's Env once on the base's files with open network and starts every checkout from it", async () => {
    const repo = origin();
    writeFileSync(join(repo, 'Cargo.toml'), '[workspace]\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'rust');
    const builds = () =>
      readFileSync(`${log}.all`, 'utf8')
        .split('\n')
        .filter(l => l.includes('agentgraph.envbuild')).length;
    const before = existsSync(`${log}.all`) ? builds() : 0;
    const exit = await use(docker({ data: tmp('data'), origin: repo }), s =>
      Effect.gen(function* () {
        const hub = { toolchain: 'rustup target add wasm32-unknown-unknown' };
        const work = yield* s.checkout('main', undefined, undefined, hub);
        yield* s.checkout('main', undefined, undefined, hub);
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
    expect(text).toContain('archive "$2" | tar -x -C /work');
    expect(text.indexOf('flock 9')).toBeLessThan(text.indexOf('sh -ec "$3"'));
    expect(text.indexOf('cargo fetch')).toBeLessThan(text.indexOf('rustup target add'));
    expect(builds() - before).toBe(1);
    expect(readFileSync(`${log}.all`, 'utf8')).toMatch(
      /commit --change LABEL agentgraph\.env=\w+ agentgraph\.lowerkb=5 agentgraph\.complete=true/
    );
  });

  it("layers a checkout's dependency dirs over the Env's copy, skips setup on base files and drops them after", async () => {
    const exit = await use(docker({ data: tmp('data'), origin: origin() }), s =>
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

  it('fails the checkout when the toolchain fails', async () => {
    const exit = await use(docker({ data: tmp('data'), origin: origin() }), s =>
      s.checkout('main', undefined, undefined, { toolchain: 'toolfail' })
    );
    expect(JSON.stringify(exit)).toContain('toolchain exited');
  });

  it('refuses to mount a docker socket', async () => {
    const exit = await use(layer, s => s.exec(command('/var/run/docker.sock')));
    expect(JSON.stringify(exit)).toContain('mount not allowed');
  });
});

describe('toolchainOf', () => {
  it('installs the pinned Rust toolchain with clippy and rustfmt and fetches the locked crates', () => {
    expect(toolchainOf(['Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'README.md'])).toEqual([
      'command -v rustup >/dev/null || rustup-init -y -q --no-modify-path --default-toolchain none --profile minimal',
      'rustup toolchain install',
      'rustup component add clippy rustfmt',
      'cargo fetch --locked',
    ]);
  });

  it('falls back to stable without a toolchain file and fetches without a lockfile', () => {
    const lines = toolchainOf(['Cargo.toml']);
    expect(lines[1]).toBe('rustup default stable');
    expect(lines[3]).toBe('cargo fetch');
    expect(toolchainOf(['rust-toolchain.toml'])).toHaveLength(3);
  });

  it('installs nothing for a repo without a toolchain it knows', () => {
    expect(toolchainOf(['package.json', 'package-lock.json', '.nvmrc'])).toEqual([]);
  });
});

describe('docker checkout', () => {
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
      const layer = docker({ data, origin: origin(), token: Effect.succeed(token) });
      const exit = await use(layer, s => Effect.zipRight(s.checkout('main'), s.checkout('main')));
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
  }, 30_000);

  it('mirrors branches, tags and the default branch head but not pull refs', async () => {
    const data = tmp('data');
    const from = origin();
    git(from, 'tag', 'v1');
    git(from, 'update-ref', 'refs/pull/1/head', 'feature');
    const layer = docker({ data, origin: from });
    for (const _ of [0, 1]) expect(Exit.isSuccess(await use(layer, s => s.checkout('main')))).toBe(true);
    const refs = git(join(data, 'mirror.git'), 'for-each-ref', '--format=%(refname)').split('\n');
    expect(refs).toEqual(['refs/heads/feature', 'refs/heads/main', 'refs/remotes/origin/HEAD', 'refs/tags/v1']);
    expect(Exit.isSuccess(await use(layer, s => s.checkout('origin/HEAD')))).toBe(true);
  });

  it('lets two processes create the mirror at the same time', async () => {
    const data = tmp('data');
    const from = origin();
    const exits = await Promise.all([0, 1].map(() => use(docker({ data, origin: from }), s => s.checkout('main'))));
    expect(exits.map(Exit.isSuccess)).toEqual([true, true]);
    expect(readdirSync(data).filter(n => n.startsWith('mirror'))).toEqual(['mirror.git']);
  });

  it('checks out a ref or the existing branch from a mirror and removes the worktree with the scope', async () => {
    const data = tmp('data');
    const layer = docker({ data, origin: origin() });
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
  }, 30_000);

  it('keeps the files under the keep ref through a fetch and puts them back on the next checkout', async () => {
    const data = tmp('data');
    const layer = docker({ data, origin: origin() });
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
  }, 30_000);

  it('puts kept files on the run branch after the branch moved on', async () => {
    const data = tmp('data');
    const repo = origin();
    const layer = docker({ data, origin: repo });
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
  }, 30_000);

  it('keeps the files through host git that nothing in the worktree can steer', async () => {
    const data = tmp('data');
    const keep = 'refs/agentgraph/runs/r3';
    const mirror = join(data, 'mirror.git');
    let planted = { marker: '', victim: '' };
    let dir = '';
    const exit = await use(docker({ data, origin: origin() }), s =>
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
  }, 30_000);

  it('fetches while a live checkout claims a branch as its HEAD', async () => {
    const data = tmp('data');
    const repo = origin();
    const layer = docker({ data, origin: repo });
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
    const exit = await use(docker({ data: tmp('data'), origin: origin() }), s => s.checkout('nope'));
    expect(JSON.stringify(exit)).toContain('no commit for nope');
  });
});

/** Real containers: `AGENTGRAPH_DOCKER=1` with the agentgraph-sandbox network and the agentgraph-sandbox:local image present. */
describe.runIf(process.env.AGENTGRAPH_DOCKER === '1')('docker for real', () => {
  it('runs a command in the sandbox image with no network', async () => {
    const dir = tmp('work');
    writeFileSync(join(dir, 'x.txt'), 'inside\n');
    const exit = await use(docker({ data: tmp('data'), origin: '/nowhere' }), s =>
      s.exec(command(dir, { args: ['-c', 'cat x.txt; id -u; touch /etc/x 2>/dev/null || echo read-only'] }))
    );
    expect(Exit.isSuccess(exit) && exit.value.output).toMatch(/^inside\n\d+\nread-only\n$/);
  }, 60_000);

  it('reads the hub at AGENTGRAPH_HUB and cannot write it', async () => {
    const hub = tmp('hub');
    writeFileSync(join(hub, 'x.sh'), 'hub script\n');
    const script = 'cat "$AGENTGRAPH_HUB/x.sh"; touch "$AGENTGRAPH_HUB/y" 2>/dev/null || echo read-only';
    const exit = await use(docker({ data: tmp('data'), origin: '/nowhere' }), s =>
      s.exec(command(tmp('work'), { args: ['-c', script], hub }))
    );
    expect(Exit.isSuccess(exit) && exit.value.output).toBe('hub script\nread-only\n');
    expect(existsSync(join(hub, 'y'))).toBe(false);
  }, 60_000);

  it("keeps one copy of an Env's dependencies however many checkouts use it, each with only its own writes", async () => {
    const repo = origin();
    writeFileSync(join(repo, 'package.json'), '{}\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'deps');
    const hub = {
      repo: 'agentgraph-disk-test',
      setup: 'mkdir -p node_modules/x && head -c 5000000 /dev/urandom > node_modules/x/blob',
    };
    const sh = (dir: string, script: string) => (s: Sandbox['Type']) => s.exec(command(dir, { args: ['-c', script] }));
    const kb = (args: string[]) => Number(execFileSync('docker', args, { encoding: 'utf8' }).trim().split(/\s+/)[0]);
    const exit = await use(docker({ data: tmp('data'), origin: repo, cache: 'agentgraph-disk-test-cache' }), s =>
      Effect.gen(function* () {
        const works = yield* Effect.all(
          [1, 2, 3].map(() => s.checkout('main', undefined, undefined, hub)),
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
      spawnSync('docker', ['volume', 'rm', 'agentgraph-disk-test-cache']);
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
    const layer = harnesses({
      data: tmp('data'),
      proxy: { url: 'http://litellm:4000/v1', keys: Redacted.make(process.env.AGENTGRAPH_PROXY_KEYS ?? '') },
      prices: join(import.meta.dirname, '../infra/local/prices.json'),
    }).pipe(Layer.provide(docker({ data: tmp('data'), origin: '/nowhere' })));
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
          Effect.map(Chunk.toArray),
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
      put(dir, f);
    put(dir, 'crates/b/Cargo.toml');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-f', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    expect(await dependencyDirs(join(dir, '.git'), 'main')).toEqual([
      'node_modules',
      'target',
      'packages/a/node_modules',
    ]);
  });

  it('layers overlays over the Env copy where it made a dependency dir and empty volumes elsewhere', async () => {
    await faked({ 'volume inspect': '/lower\\n/u0\\n' }, async log => {
      const layers = await layer(
        { image: 'img', outputs: ['node_modules', 'dist'], lower: 'agentgraph-lower-k' },
        'own',
        tmp('work'),
        ['node_modules', 'packages/a/node_modules']
      );
      expect(layers).toEqual([
        { name: 'agentgraph-layer-own-0-o', dst: '/work/node_modules', upper: 'agentgraph-layer-own-0' },
        { name: 'agentgraph-layer-own-1', dst: '/work/packages/a/node_modules' },
      ]);
      expect(log()).toMatch(
        /volume create --label agentgraph\.layer=\d+:[0-9a-f]{12} --label agentgraph\.owner=own agentgraph-layer-own-1/
      );
      expect(log()).toContain('o=lowerdir=/lower/data/0,upperdir=/u0/upper,workdir=/u0/work agentgraph-layer-own-0-o');
      expect(log()).toContain('type=volume,src=agentgraph-lower-k,dst=/lower,readonly');
      expect(log()).not.toContain('/u/1/upper');
      expect(log()).toContain(`cp -a '/work/dist' '/dst/'/`);
      await discard(layers);
      expect(log()).toContain('volume rm -f agentgraph-layer-own-0-o agentgraph-layer-own-1 agentgraph-layer-own-0');
    });
  });

  it('gives a checkout its own overlay over the shared cache, so run code never writes it', async () => {
    await faked({ 'volume inspect': '/m/a\\n/m/b\\n' }, async log => {
      const layers = await layer({ image: 'img', outputs: [] }, 'own', tmp('work'), [], 'agentgraph-cache');
      expect(layers).toEqual([{ name: 'agentgraph-layer-own-c-o', dst: '/cache', upper: 'agentgraph-layer-own-c' }]);
      expect(log()).toContain('o=lowerdir=/m/a,upperdir=/m/b/upper,workdir=/m/b/work agentgraph-layer-own-c-o');
      const args = dockerArgs(
        { cmd: 'true', args: [], dir: '/w', env: {}, network: 'none', minutes: 1 },
        'img',
        'n',
        { mounts: [], layers },
        'agentgraph-cache'
      );
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
      for (const id of ['mine', 'none', 'gone']) mkdirSync(join(data, 'work', id, 'node_modules'), { recursive: true });
      mark(join(data, 'work', 'mine'));
      writeFileSync(join(data, 'work', 'gone.owner'), `${spawnSync('true').pid}:0123456789ab`);
      expect(reap(data)).toBe(2);
      expect(readdirSync(join(data, 'work')).sort()).toEqual(['mine', 'mine.owner']);
      expect(live(beat())).toBe(true);
    });
  });
});

describe('sweep', () => {
  it('sweeps nothing when docker does not answer in time', async () => {
    const bin = tmp('bin');
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexec sleep 5\n');
    chmodSync(join(bin, 'docker'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const started = Date.now();
      expect(await sweep(200)).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      process.env.PATH = path;
    }
  });
});
