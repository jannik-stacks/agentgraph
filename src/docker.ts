import { getSha } from './hash.ts';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cache, Cause, Duration, Effect, Layer, Queue, Redacted, Schema, Semaphore, Stream } from 'effect';
import { isIP } from 'node:net';
import { isAgentBranch, type TrackerError } from './tracker.ts';
import type { Graph } from './folder.ts';
import {
  dependencyDirs,
  discard,
  isVolumeName,
  readSandboxSetup,
  readSetupInputKey,
  createSharedMounts,
  type SharedMount,
  writeCheckoutOwner,
  findDeadCheckouts,
  getCachePath,
  getCheckoutPaths,
  removeCheckout,
  packageManagerCacheEnv,
  unlogged,
  written,
} from './env.ts';
import { ensureFreeDisk, readEnvRefs, writeEnvRefs, removeBranch } from './disk.ts';
import { waitForLock } from './owner.ts';
import { type Command, type Exit, Sandbox, SandboxError, type Checkout } from './sandbox.ts';
import {
  commitCheckout,
  commitCheckoutOnce,
  hostGit,
  makeHostEnv,
  readGit,
  readBranches,
  readWorktreeAdmin,
} from './git.ts';

/** The internal docker network for each graph `network`; only the egress one has the allowlist proxy on it. */
const networks = { egress: 'agentgraph-sandbox', models: 'agentgraph-models' } as const;
const egress = 'http://egress:8888';
const bypass = (direct: string[]) => [...direct, 'localhost', '127.0.0.1'].join(',');
const inside = {
  work: '/work',
  home: '/home/agent',
  tmp: '/tmp',
  scratch: '/scratch',
  graph: '/graph',
  cache: '/cache',
};
const limits = { memory: '4g', cpus: '1.5', pids: '512' };
const outputLimit = 64 << 10;
/** The mirror takes branches and tags only, so fork code in `refs/pull/*` never reaches a session. */
const fetched = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', '+HEAD:refs/remotes/origin/HEAD'];

type Mount = { src: string; dst: string; readonly?: boolean };

/**
 * The admin dir git just made for the worktree `dir` of `mirror`, read before any container ran in `dir`. It must be
 * `<mirror>/worktrees/<name of dir>`.
 */
const worktreeAdmin = (mirror: string, dir: string) => {
  const admin = readWorktreeAdmin(mirror, dir);
  if (basename(admin) !== basename(dir)) throw new Error(`worktree admin dir ${admin} does not name ${dir}`);
  return admin;
};

const infra = (detail: string) => new SandboxError({ reason: 'infra', detail });

const bind = ({ src, dst, readonly }: Mount) => {
  if (/[,\n"]/.test(src + dst) || ['/', '/run', '/var/run'].includes(src) || src.endsWith('docker.sock'))
    throw infra(`mount not allowed: ${src}`);
  return ['--mount', `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`];
};

export const whyRoot = () =>
  process.getuid?.() === 0
    ? 'agentgraph refuses to run a container as root. Run it as a user in the docker group.'
    : undefined;

const user = () => {
  const why = whyRoot();
  if (why) throw infra(why);
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
};

/**
 * What the host recorded for a checkout: its git mounts, its dependency volumes, its repo's cache volume and the
 * container settings of its graph and sandbox setup.
 */
export type CheckoutContainerSpec = {
  mounts: Mount[];
  sharedMounts?: SharedMount[];
  cache?: string;
  direct?: string[];
} & Pick<Graph, 'image' | 'network'>;

const volume = (name: string, dst: string, nocopy = false, readonly = false) => {
  if (!isVolumeName(name) || /[,\n"]/.test(dst)) throw infra(`volume name not allowed: ${name}`);
  return [
    '--mount',
    `type=volume,src=${name},dst=${dst}${nocopy ? ',volume-nocopy' : ''}${readonly ? ',readonly' : ''}`,
  ];
};

/** Where package managers keep downloads when the shared cache is read-only. */
const scratch = Object.fromEntries(
  Object.entries(packageManagerCacheEnv).map(([k, v]) => [k, v.replace(/^\/cache/, '/tmp')])
);

const getMounts = (c: Command, mounts: Mount[]): Mount[] => [
  { src: c.dir, dst: inside.work, readonly: !!c.readonly },
  ...(c.home ? [{ src: c.home, dst: inside.home }] : []),
  ...(c.graph ? [{ src: c.graph, dst: inside.graph, readonly: true }] : []),
  ...mounts.map(m => ({ ...m, readonly: !!(m.readonly || (c.readonly && m.dst !== inside.scratch)) })),
];

/**
 * `docker run` for one command in a throwaway container. `dir` is `/work` and `home` is `/home/agent`. With `proxy`
 * the only routes out are the `direct` model hosts and, unless the graph's network is `models`, the egress allowlist; with
 * `none` there is no network, and with `open` any host. With `cache`, that volume is `/cache`, read-only unless a shared
 * mount overlays it there; each shared mount is a volume at its path. A `readonly` command gets every mount read-only
 * but its home and scratch.
 */
export const dockerArgs = (
  c: Command,
  image: string,
  name: string,
  { mounts, sharedMounts = [], cache = '', network = 'egress', direct = [] }: CheckoutContainerSpec,
  size = limits
) => [
  'run',
  ...unlogged,
  '--rm',
  '--init',
  '--pull',
  'never',
  '--name',
  name,
  '--network',
  c.network === 'proxy' ? networks[network] : c.network === 'open' ? 'bridge' : 'none',
  '--read-only',
  '--tmpfs',
  `${inside.tmp}:rw,exec,nosuid,nodev,size=1g`,
  '--user',
  user(),
  '--cap-drop=ALL',
  '--security-opt',
  'no-new-privileges=true',
  '--memory',
  c.limits?.memory ?? size.memory,
  '--memory-swap',
  c.limits?.memory ?? size.memory,
  '--cpus',
  String(c.limits?.cpus ?? size.cpus),
  '--pids-limit',
  size.pids,
  ...getMounts(c, mounts).flatMap(bind),
  ...(cache && !sharedMounts.some(l => l.dst === inside.cache) ? volume(cache, inside.cache, false, true) : []),
  ...sharedMounts.flatMap(l => volume(l.name, l.dst, true, c.readonly)),
  '--workdir',
  inside.work,
  ...Object.entries({
    TMPDIR: inside.tmp,
    HOME: c.home ? inside.home : inside.tmp,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    ...(cache && (!c.readonly && sharedMounts.some(l => l.dst === inside.cache) ? packageManagerCacheEnv : scratch)),
    ...(c.network === 'proxy' &&
      network === 'egress' && {
        HTTPS_PROXY: egress,
        HTTP_PROXY: egress,
        https_proxy: egress,
        http_proxy: egress,
        NO_PROXY: bypass([...direct, ...(c.tools ? [new URL(c.tools.url).hostname] : [])]),
        no_proxy: bypass([...direct, ...(c.tools ? [new URL(c.tools.url).hostname] : [])]),
      }),
    ...c.env,
    ...(c.graph && { AGENTGRAPH_DIR: inside.graph }),
  }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
  ...Object.keys(c.secrets ?? {}).flatMap(key => ['-e', key]),
  image,
  'sh',
  '-c',
  `"$@"; s=$?; { p=$(cat /sys/fs/cgroup/memory.peak) && echo && echo agentgraph-used $p $(grep -hw -e usage_usec -e oom_kill /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.events); } 2>/dev/null; exit $s`,
  'sh',
  c.cmd,
  ...c.args,
];

const usedMark = 'agentgraph-used ';

const readUsed = (output: string): Pick<Exit, 'output' | 'used'> => {
  const m = [...output.matchAll(/(?:^|\n)agentgraph-used (\d+) usage_usec (\d+) oom_kill (\d+)(?:\n|$)/g)].at(-1);
  if (!m) return { output };
  const [peak = 0, cpu = 0, oom = 0] = m.slice(1).map(Number);
  return {
    output: output.slice(0, m.index) + output.slice(m.index + m[0].length),
    used: { peak, cpu: Math.round(cpu / 1000), ...(oom > 0 && { oom: true }) },
  };
};

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  Effect.callback<string, SandboxError>(done => {
    const options = {
      env: makeHostEnv({ GIT_TERMINAL_PROMPT: '0', ...env }),
      timeout: 600_000,
      maxBuffer: 64 << 20,
    };
    execFile(cmd, args, options, (error, stdout, stderr) =>
      done(
        error
          ? Effect.fail(infra(`${cmd} ${args.slice(0, 2).join(' ')}: ${(stderr || error.message).trim().slice(-2000)}`))
          : Effect.succeed(stdout.trim())
      )
    );
  });

export const sandboxImage = 'agentgraph-sandbox:local';

const locked = <A, E>(name: string, e: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => waitForLock(name)),
    () => e,
    release => Effect.promise(release)
  );

const builds: Record<string, string> = { [sandboxImage]: 'sandbox', 'agentgraph-egress:local': 'egress' };

const ensureImage = (tag: string, fresh = false, say: (line: string) => void = () => {}) =>
  Effect.gen(function* () {
    const dir = builds[tag];
    const label = fresh && dir ? '{{index .Config.Labels "agentgraph.source"}}' : '{{.Id}}';
    const built = (yield* run('docker', ['image', 'inspect', '--format', label, tag]).pipe(
      Effect.catch(e => (/no such image/i.test(e.detail) ? Effect.succeed('') : Effect.fail(e)))
    )).trim();
    if (!dir)
      return built
        ? false
        : yield* new SandboxError({
            reason: 'host',
            detail: tag.startsWith('sha256:')
              ? `Pinned image ${tag} is missing. Rebuild or pull the original image to restore this ID before resuming.`
              : `The image ${tag} is missing on the runner host. Run \`docker pull ${tag}\` there.`,
          });
    const source = fileURLToPath(new URL(`../infra/local/${dir}`, import.meta.url));
    const files = readdirSync(source, { withFileTypes: true }).filter(f => f.isFile());
    const digest = getSha(
      Buffer.concat(files.flatMap(f => [Buffer.from(f.name), readFileSync(join(source, f.name))])),
      12
    );
    if (fresh ? built === digest : built) return false;
    say(`building ${tag}`);
    yield* run('docker', ['build', '-q', '--label', `agentgraph.source=${digest}`, '-t', tag, source]).pipe(
      Effect.mapError(
        e =>
          new SandboxError({
            reason: 'host',
            detail: `Building ${tag} failed on the runner host: ${e.detail}\nFix that, then run \`docker build -t ${tag} ${source}\` there.`,
          })
      )
    );
    return true;
  });

const checkedImages = new Set<string>();

export const readImage = (graph: Pick<Graph, 'image'> = {}, fallback = sandboxImage, override?: string) =>
  Effect.gen(function* () {
    if ([override, graph.image, fallback].some(value => value !== undefined && typeof value !== 'string'))
      return yield* new SandboxError({ reason: 'host', detail: 'Image references must be strings.' });
    const tag = override ?? graph.image ?? fallback;
    yield* locked('images', ensureImage(tag));
    const id = yield* run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
    if (!checkedImages.has(id)) {
      const uid = yield* Effect.try({ try: user, catch: error => error as SandboxError });
      const name = `agentgraph-image-${randomBytes(6).toString('hex')}`;
      const out = yield* run('docker', [
        'run',
        '--rm',
        '--name',
        name,
        '--pull',
        'never',
        '--network',
        'none',
        '--read-only',
        '--user',
        uid,
        '--tmpfs',
        '/tmp:rw,exec,nosuid,nodev,size=64m',
        '--workdir',
        '/tmp',
        '-e',
        'HOME=/tmp',
        '--memory',
        limits.memory,
        '--memory-swap',
        limits.memory,
        '--cpus',
        limits.cpus,
        '--pids-limit',
        limits.pids,
        '--cap-drop=ALL',
        '--security-opt',
        'no-new-privileges=true',
        id,
        'sh',
        '-c',
        'printf agentgraph-command-ready',
      ]).pipe(
        Effect.timeoutOrElse({
          duration: '10 seconds',
          orElse: () => Effect.fail(infra(`image ${id} did not run the command probe`)),
        }),
        Effect.onError(() =>
          run('docker', ['rm', '-f', name]).pipe(
            Effect.catch(e => Effect.sync(() => console.error(`1 skipped image probe cleanup: ${e.detail}`)))
          )
        )
      );
      if (out !== 'agentgraph-command-ready')
        return yield* new SandboxError({
          reason: 'host',
          detail: `Image ${id} must run supplied commands directly; check its entrypoint.`,
        });
      checkedImages.add(id);
    }
    return id;
  });

export const findMissingModelHosts = (hosts: string[]) =>
  Effect.gen(function* () {
    if (hosts.length === 0) return [];
    const filters = Object.values(networks).flatMap(n => ['--filter', `network=${n}`]);
    const ids = (yield* run('docker', ['ps', '-q', ...filters])).split('\n').filter(Boolean);
    const lines = ids.length
      ? yield* run('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', ...ids])
      : '';
    const answered = new Set(
      lines
        .split('\n')
        .filter(Boolean)
        .flatMap(line =>
          Object.entries(JSON.parse(line) as Record<string, { Aliases: string[] | null; DNSNames: string[] | null }>)
            .filter(([name]) => (Object.values(networks) as string[]).includes(name))
            .flatMap(([, n]) => [...(n.Aliases ?? []), ...(n.DNSNames ?? [])])
        )
    );
    return hosts.filter(h => !answered.has(h));
  });

export const ensureDocker = (say: (line: string) => void, image: string) =>
  Effect.gen(function* () {
    const version = yield* Effect.mapError(run('docker', ['version', '--format', '{{.Server.Version}}']), () =>
      infra(
        "agentgraph runs the repo's code only in a container, and docker is not running.\nStart Docker Desktop, colima or podman (DOCKER_HOST), or set AGENTGRAPH_SANDBOX_URL to a box server."
      )
    );
    yield* locked(
      'images',
      Effect.gen(function* () {
        const has = (args: string[]) =>
          run('docker', args).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          );
        const made = [
          ['sandbox', networks.egress, true],
          ['models', networks.models, true],
          ['egress', 'agentgraph-egress', false],
        ] as const;
        for (const [key, name, internal] of made)
          if (!(yield* has(['network', 'inspect', name])))
            yield* run('docker', [
              ...`network create --label com.docker.compose.project=agentgraph --label com.docker.compose.network=${key}`.split(
                ' '
              ),
              ...(internal ? ['--internal'] : []),
              name,
            ]);
        if (image === sandboxImage) yield* ensureImage(image, true, say);
        if (yield* ensureImage('agentgraph-egress:local', true, say)) yield* has(['rm', '-f', 'agentgraph-egress']);
        const members = yield* run('docker', [
          'network',
          'inspect',
          '--format',
          '{{range .Containers}}{{.Name}} {{end}}',
          networks.egress,
        ]);
        if (!members.includes('egress') && !(yield* has(['start', 'agentgraph-egress']))) {
          const flags = `run -d --name agentgraph-egress --restart unless-stopped --read-only --cap-drop ALL
        --security-opt no-new-privileges:true --memory 128m --pids-limit 512 --network ${networks.egress}
        --network-alias egress agentgraph-egress:local`;
          yield* run('docker', flags.split(/\s+/));
        }
        yield* has(['network', 'connect', 'agentgraph-egress', 'agentgraph-egress']);
      })
    );
    return version;
  });

/** Git config from the environment that sends `token` to github.com, so it stays out of argv and every config file. */
const auth = (token: string) => ({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
});

/** Starts `docker` with `args` in its own process group; `stop` kills it and removes the container. */
const start = (args: string[], secrets: Command['secrets'], name: string, on: (chunk: string) => void) => {
  const env = makeHostEnv(
    Object.fromEntries(Object.entries(secrets ?? {}).map(([key, value]) => [key, Redacted.value(value)]))
  );
  const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.setEncoding('utf8').on('data', on);
  child.stderr.setEncoding('utf8').on('data', on);
  const closed = new Promise<number>(done => {
    child.once('error', () => done(127));
    child.once('close', code => done(code ?? 137));
  });
  const stop = () =>
    Effect.promise(async () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
      await new Promise(done => execFile('docker', ['rm', '-f', name], { env: makeHostEnv() }, () => done(undefined)));
      return closed;
    });
  return { closed, stop };
};

const timeout = (c: Command) => () =>
  new SandboxError({ reason: 'timeout', detail: `no exit after ${c.minutes} minutes` });

const mirrorLocks = new Map<string, Semaphore.Semaphore>();

/**
 * A sandbox: one container per command over linked worktrees of a read-only mirror of `origin` under `data`, or of
 * `origin` itself when it is a `local` tracker's bare repo. With
 * `token`, the mirror's clone and fetch authenticate to github.com; containers never see it. A checkout for a graph
 * mounts its repo's cache volume, named from the prefix `cache` (`agentgraph-cache` by default), the repo and its setup
 * hash. It starts from the graph's sandbox setup at its base, built once with the toolchain and setup, and holds its
 * dependency directories in volumes, never in the checkout. An empty `cache` turns the cache volumes and sandbox setups off.
 */
export const dockerSandbox = (o: {
  data: string;
  origin: string;
  local?: boolean;
  image?: string;
  cache?: string;
  direct?: string[];
  token?: Effect.Effect<string, TrackerError>;
}): Layer.Layer<Sandbox> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const image = o.image ?? sandboxImage;
      const cache = o.cache ?? 'agentgraph-cache';
      const mirror = o.local ? o.origin : join(o.data, 'mirror.git');
      let configured = false;
      const lock = mirrorLocks.get(mirror) ?? mirrorLocks.set(mirror, Semaphore.makeUnsafe(1)).get(mirror)!;
      const roomy = (base: string) =>
        Effect.tryPromise({
          try: () =>
            ensureFreeDisk({
              dir: o.data,
              ...(cache && { image: base }),
              eligible: readEnvRefs(o.data),
            }),
          catch: e => infra((e as Error).message),
        });
      /** Each live checkout as the host made it. */
      const made = new Map<string, CheckoutContainerSpec>();
      const inMirror = (args: string[], env: Record<string, string> = {}) => readGit({ GIT_DIR: mirror, ...env }, args);
      const internal = yield* Cache.make({
        capacity: 8,
        lookup: (network: string) =>
          run('docker', ['network', 'inspect', '--format', '{{.Internal}}', network]).pipe(
            Effect.filterOrFail(
              internal => internal === 'true',
              () => infra(`the ${network} network is not internal`)
            )
          ),
      });

      const tools = yield* Effect.cached(
        process.platform === 'linux'
          ? Effect.flatMap(
              run('docker', ['network', 'inspect', '--format', '{{json .IPAM.Config}}', 'agentgraph-egress']),
              text =>
                Effect.try({
                  try: () => {
                    const routes = Schema.decodeUnknownSync(
                      Schema.Array(Schema.Struct({ Gateway: Schema.String, Subnet: Schema.String }))
                    )(JSON.parse(text));
                    const route = routes.find(entry => isIP(entry.Gateway) === 4);
                    if (!route) throw new Error('the egress network has no IPv4 host gateway');
                    return { host: route.Gateway, subnet: route.Subnet };
                  },
                  catch: error => infra(String(error)),
                })
            )
          : Effect.succeed({ host: '127.0.0.1', subnet: '127.0.0.0/8' })
      );

      const prepare = (c: Command) =>
        Effect.gen(function* () {
          const box = made.get(c.dir) ?? { mounts: [] };
          yield* roomy(box.image ?? image);
          if (c.network === 'proxy') yield* Cache.get(internal, networks[box.network ?? 'egress']);
          if (c.tools) {
            const endpoint = yield* Effect.try({
              try: () => new URL(c.tools!.url),
              catch: error => infra(String(error)),
            });
            const relay = `agentgraph-tools-${randomBytes(6).toString('hex')}`;
            yield* Effect.acquireRelease(Effect.succeed(relay), name =>
              run('docker', ['rm', '-f', name]).pipe(Effect.orElseSucceed(() => ''))
            );
            yield* run('docker', [
              'run',
              ...unlogged,
              '-d',
              '--rm',
              '--pull',
              'never',
              '--name',
              relay,
              '--network',
              'agentgraph-egress',
              '--add-host',
              `host.docker.internal:${c.tools.host === '127.0.0.1' ? 'host-gateway' : c.tools.host}`,
              '--read-only',
              '--cap-drop',
              'ALL',
              '--security-opt',
              'no-new-privileges:true',
              '--memory',
              '32m',
              '--pids-limit',
              '64',
              '--entrypoint',
              'socat',
              'agentgraph-egress:local',
              `TCP-LISTEN:${endpoint.port},fork,reuseaddr`,
              `TCP:host.docker.internal:${endpoint.port}`,
            ]).pipe(Effect.uninterruptible);
            yield* run('docker', [
              'network',
              'connect',
              '--alias',
              endpoint.hostname,
              networks[box.network ?? 'egress'],
              relay,
            ]);
          }
          const name = `agentgraph-${randomBytes(6).toString('hex')}`;
          const args = yield* Effect.try({
            try: () => dockerArgs(c, box.image ?? image, name, { ...box, direct: o.direct ?? [] }),
            catch: e => e as SandboxError,
          });
          yield* Effect.tryPromise({
            try: async () => {
              const mounts = getMounts(c, box.mounts);
              const destinations = [...mounts, ...(box.sharedMounts ?? [])];
              for (const mount of destinations) {
                const parent = destinations
                  .filter(m => mount.dst.startsWith(`${m.dst}/`))
                  .toSorted((a, b) => b.dst.length - a.dst.length)[0];
                if (parent && 'src' in parent) {
                  let path = parent.src;
                  for (const part of mount.dst.slice(parent.dst.length + 1).split('/')) {
                    if (part === '..' || part === '.') throw new Error(`invalid mountpoint: ${mount.dst}`);
                    path = join(path, part);
                    await mkdir(path, { recursive: true });
                    if ((await lstat(path)).isSymbolicLink()) throw new Error(`symlink mountpoint: ${path}`);
                  }
                }
              }
            },
            catch: e => infra((e as Error).message),
          });
          return { name, args };
        });

      const lines = (c: Command) =>
        Stream.unwrap(
          Effect.map(prepare(c), ({ name, args }) => {
            let code = 0;
            let tail = '';
            let measured: Exit['used'];
            return Stream.callback<string, SandboxError>(queue =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const proc = start(args, c.secrets, name, chunk => {
                    tail = (tail + chunk).slice(-2000);
                    Queue.offerUnsafe(queue, chunk);
                  });
                  void proc.closed.then(closed => {
                    code = closed;
                    return code === 125
                      ? Queue.failCauseUnsafe(
                          queue,
                          Cause.fail(infra(`docker could not start the container: ${tail.trim()}`))
                        )
                      : Queue.endUnsafe(queue);
                  });
                  return proc;
                }),
                proc => proc.stop()
              )
            ).pipe(
              Stream.splitLines,
              Stream.filter(line => {
                const used = line.startsWith(usedMark) && readUsed(line).used;
                if (used) measured = used;
                return !used;
              }),
              Stream.concat(Stream.sync(() => ({ code, ...(measured && { used: measured }) }))),
              Stream.interruptWhen(
                Effect.andThen(Effect.sleep(Duration.minutes(c.minutes)), Effect.failSync(timeout(c)))
              )
            );
          })
        );

      const exec = (c: Command) =>
        Effect.gen(function* () {
          const { name, args } = yield* prepare(c);
          let output = '';
          const proc = yield* Effect.acquireRelease(
            Effect.sync(() =>
              start(args, c.secrets, name, chunk => void (output = (output + chunk).slice(-outputLimit)))
            ),
            proc => proc.stop()
          );
          const code = yield* Effect.promise(() => proc.closed).pipe(
            Effect.timeoutOrElse({ duration: Duration.minutes(c.minutes), orElse: () => Effect.failSync(timeout(c)) })
          );
          if (code === 125) return yield* infra(`docker could not start the container: ${output.trim().slice(-2000)}`);
          return { code, ...readUsed(output) } satisfies Exit;
        });

      const empty = (graph?: Pick<Graph, 'image' | 'network'>) =>
        Effect.gen(function* () {
          const id = randomBytes(6).toString('hex');
          const { dir, news, scratch } = getCheckoutPaths(o.data, id);
          const remove = Effect.promise(() => {
            made.delete(dir);
            return removeCheckout(o.data, id);
          });
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                writeCheckoutOwner(dir);
                await Promise.all([dir, news, scratch].map(p => mkdir(p, { recursive: true })));
                made.set(dir, {
                  ...(graph?.image !== undefined && { image: graph.image }),
                  ...(graph?.network !== undefined && { network: graph.network }),
                  sharedMounts: [],
                  mounts: [
                    { src: news, dst: news, readonly: true },
                    { src: scratch, dst: inside.scratch },
                  ],
                });
              },
              catch: e => infra((e as Error).message),
            }).pipe(Effect.onError(() => remove)),
            () => remove
          );
          return {
            dir,
            base: '',
            git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
            news: join(news, 'news.md'),
          };
        });

      const fetch = lock.withPermits(1)(
        Effect.gen(function* () {
          if (o.local) {
            if (configured) return;
            for (const [key, value] of Object.entries({
              'remote.origin.url': mirror,
              'remote.origin.pushurl': mirror,
              'receive.autogc': 'false',
              'receive.denyCurrentBranch': 'ignore',
              'gc.auto': '0',
            }))
              if ((yield* inMirror(['config', '--get-all', key]).pipe(Effect.orElseSucceed(() => ''))) !== value)
                yield* inMirror(['config', '--replace-all', key, value]);
            configured = true;
            return;
          }
          const exists = yield* Effect.promise(() =>
            readFile(join(mirror, 'HEAD')).then(
              () => true,
              () => false
            )
          );
          const env = o.token ? auth(yield* Effect.mapError(o.token, e => infra(e.message))) : {};
          if (!exists) {
            yield* Effect.promise(() => mkdir(dirname(mirror), { recursive: true }));
            const part = `${mirror}.${randomBytes(4).toString('hex')}`;
            yield* Effect.asVoid(hostGit({}, ['init', '--bare', '-q', part]));
            yield* Effect.asVoid(hostGit({ GIT_DIR: part }, ['config', 'remote.origin.url', o.origin]));
            yield* Effect.promise(() => rename(part, mirror).catch(() => rm(part, { recursive: true, force: true })));
          }
          yield* inMirror(['fetch', '--prune', '--update-head-ok', 'origin', ...fetched], env);
        })
      );
      const verify = (name: string) =>
        inMirror([
          'rev-parse',
          '--verify',
          '--quiet',
          `${o.local && name === 'origin/HEAD' ? 'HEAD' : name}^{commit}`,
        ]).pipe(Effect.orElseSucceed(() => ''));
      const readTrustedCommits = (workflows: Graph['workflows'] = {}) => {
        const written = Object.values(workflows).flatMap(w =>
          w.branch
            ? [
                new RegExp(
                  `^${w.branch
                    .split(/\{[^}]*\}/)
                    .map(p => p.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
                    .join('.+')}$`
                ),
              ]
            : []
        );
        const bases = Object.values(workflows).flatMap(w =>
          w.base && !/[{}]/.test(w.base) && !isAgentBranch(w.base) && !written.some(r => r.test(w.base!))
            ? [w.base]
            : []
        );
        return Effect.forEach(
          [o.local ? 'HEAD' : 'refs/remotes/origin/HEAD', ...bases.map(b => `refs/heads/${b}`)],
          verify
        );
      };
      const readHead = (ref: string) =>
        Effect.gen(function* () {
          yield* fetch;
          const sha = (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`));
          return sha || (yield* infra(`no commit for ${ref}`));
        });

      const checkoutGit = ({ dir, index }: ReturnType<typeof getCheckoutPaths>) => ({
        GIT_DIR: mirror,
        GIT_WORK_TREE: dir,
        GIT_INDEX_FILE: index,
      });
      const dead = findDeadCheckouts(o.data);
      if (dead.length > 0) mkdirSync(getCachePath(o.data, 'index'), { recursive: true });
      for (const id of dead) {
        const paths = getCheckoutPaths(o.data, id);
        yield* commitCheckoutOnce(checkoutGit(paths), `refs/agentgraph/reaped/${id}`, []).pipe(
          Effect.andThen(Effect.promise(() => removeCheckout(o.data, id))),
          Effect.catch(e => Effect.logWarning(`kept unsaved checkout ${paths.dir}: ${e.detail}`))
        );
      }

      const checkout = (
        ref: string | undefined,
        branch?: string,
        keep?: string,
        graph?: Pick<Graph, 'image' | 'network' | 'toolchain' | 'setup'> & Partial<Pick<Graph, 'repo' | 'workflows'>>
      ) =>
        Effect.gen(function* () {
          const box = yield* readImage(graph, image);
          if (ref === undefined) return yield* empty({ ...graph, image: box });
          yield* fetch;
          const saved = keep ? yield* verify(keep) : '';
          const own = branch ? yield* verify(`refs/heads/${branch}`) : '';
          const rev =
            own || (saved ? yield* verify(`${saved}^`) : (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`)));
          if (!rev) return yield* infra(`no commit for ${ref}`);
          const onto = (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`));
          const base = onto ? yield* inMirror(['merge-base', rev, onto]) : rev;
          yield* roomy(box);
          const setup = graph?.setup?.includes('AGENTGRAPH_DIR') ? undefined : graph?.setup;
          const trusted = graph && cache ? yield* readTrustedCommits(graph.workflows) : [];
          const { cache: repoCache, env } =
            graph && cache
              ? yield* Effect.tryPromise({
                  try: () =>
                    readSandboxSetup({
                      repo: graph.repo ?? '',
                      origin: URL.canParse(o.origin) ? o.origin : resolve(o.origin),
                      image: box,
                      git: mirror,
                      base,
                      cache,
                      trusted: trusted.filter(Boolean),
                      ...(setup && { setup }),
                      ...(graph.toolchain && { toolchain: graph.toolchain }),
                    }),
                  catch: e => infra((e as Error).message),
                })
              : { cache: '', env: undefined };
          yield* Effect.sync(() =>
            writeEnvRefs(o.data, [...(repoCache ? [repoCache] : []), ...(env ? [env.image] : [])])
          );
          const match = env
            ? yield* Effect.promise(() =>
                readSetupInputKey(mirror, rev, env.mode).then(
                  i => i === env.inputs,
                  () => false
                )
              )
            : false;
          const id = randomBytes(6).toString('hex');
          const paths = getCheckoutPaths(o.data, id);
          const { dir, index, news, scratch } = paths;
          const work: Checkout = {
            dir,
            base,
            ...(base !== rev && { head: rev }),
            ...(saved && { saved }),
            ...(env?.complete && setup && !saved && match && { ready: true }),
            ...(env && { env: { key: env.key, mode: env.mode, match } }),
            git: checkoutGit(paths),
            news: join(news, 'news.md'),
          };
          const save = (name: string) =>
            commitCheckout(
              work,
              name,
              saved,
              [rev, saved, work.published],
              name + (work.published ? `\n\nbaseline ${work.published}` : '')
            ).pipe(
              Effect.tapError(() => Effect.promise(() => rename(`${dir}.owner`, `${dir}.failed`))),
              Effect.mapError(
                e => new Error(`${e.detail}; unsaved checkout preserved at ${dir}, index ${index}`, { cause: e })
              ),
              Effect.orDie
            );
          let admin = '';
          let sharedMounts: SharedMount[] = [];
          const add = Effect.gen(function* () {
            yield* Effect.try({ try: () => writeCheckoutOwner(dir), catch: e => infra((e as Error).message) });
            yield* lock.withPermits(1)(inMirror(['worktree', 'add', '--detach', dir, rev]));
            admin = yield* Effect.try({
              try: () => worktreeAdmin(mirror, dir),
              catch: e => infra((e as Error).message),
            });
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(dirname(index), { recursive: true });
                await mkdir(news, { recursive: true });
                await mkdir(scratch, { recursive: true });
                await copyFile(join(admin, 'index'), index);
              },
              catch: e => infra((e as Error).message),
            });
            if (saved) yield* hostGit(work.git, ['read-tree', '-u', '--reset', saved]);
            if (repoCache)
              sharedMounts = yield* Effect.tryPromise({
                try: async () =>
                  createSharedMounts(
                    env ?? { image: box, outputs: [] },
                    id,
                    dir,
                    await dependencyDirs(mirror, rev),
                    repoCache
                  ),
                catch: e => infra((e as Error).message),
              });
            const from = env?.image ?? box;
            work.written = () => written(sharedMounts, from);
            made.set(dir, {
              image: from,
              cache: repoCache,
              ...(graph?.network !== undefined && { network: graph.network }),
              sharedMounts,
              mounts: [
                { src: dirname(dirname(admin)), dst: dirname(dirname(admin)), readonly: true },
                { src: admin, dst: admin },
                { src: news, dst: news, readonly: true },
                { src: scratch, dst: inside.scratch },
              ],
            });
          });
          const remove = Effect.promise(() => {
            made.delete(dir);
            return Promise.all([
              removeCheckout(o.data, id),
              admin && rm(admin, { recursive: true, force: true }),
              discard(sharedMounts),
            ]);
          });
          yield* Effect.acquireRelease(add.pipe(Effect.onError(() => remove)), () =>
            Effect.andThen(keep ? save(keep) : Effect.void, remove)
          );
          return work;
        });

      return {
        readBranches: () => readBranches(mirror, !o.local),
        readHead,
        removeBranch: (branch, base, head) =>
          lock.withPermits(1)(
            removeBranch(mirror, branch, o.local && base === 'origin/HEAD' ? 'HEAD' : base, head, o.data)
          ),
        checkout,
        exec,
        lines,
        tools,
        scratch: inside.scratch,
      };
    })
  );
