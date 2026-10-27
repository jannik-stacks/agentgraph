import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Effect, Layer, Redacted, Stream } from 'effect';
import type { ForgeError } from './forge.ts';
import type { Graph } from './folder.ts';
import {
  dependencyDirs,
  discard,
  readSandboxSetup,
  readSetupInputKey,
  createSharedMounts,
  type SharedMount,
  writeCheckoutOwner,
  reap,
  removeOrphanedVolumes,
  packageManagerCacheEnv,
  unlogged,
  written,
} from './env.ts';
import { ensureFreeDisk } from './disk.ts';
import { waitForLock } from './owner.ts';
import { type Command, type Exit, Sandbox, SandboxError, type Checkout } from './sandbox.ts';
import { gitIdentity, hostGit, makeHostEnv } from './git.ts';

/** The internal docker network for each graph `network`; only the egress one has the allowlist proxy on it. */
const networks = { egress: 'agentgraph-sandbox', models: 'agentgraph-models' } as const;
const egress = 'http://egress:8888';
const bypass = (direct: string[]) => [...direct, 'localhost', '127.0.0.1'].join(',');
const inside = { work: '/work', home: '/home/agent', tmp: '/tmp', graph: '/graph', cache: '/cache' };
const limits = { memory: '4g', cpus: '1.5', pids: '512' };
const outputLimit = 64 << 10;
/** The mirror takes branches and tags only, so fork code in `refs/pull/*` never reaches a session. */
const fetched = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', '+HEAD:refs/remotes/origin/HEAD'];

type Mount = { src: string; dst: string; readonly?: boolean };

/**
 * The admin dir git just made for the worktree `dir` of `mirror`, read before any container ran in `dir`. It must be
 * `<mirror>/worktrees/<name of dir>`.
 */
const worktreeAdmin = async (mirror: string, dir: string) => {
  const admin = /^gitdir: (.+)$/m.exec(await readFile(join(dir, '.git'), 'utf8'))?.[1]?.trim() ?? '';
  const expected = await realpath(join(mirror, 'worktrees', basename(dir)));
  if (!admin.startsWith('/') || (await realpath(admin)) !== expected)
    throw new Error(`worktree admin dir ${admin} is not ${expected}`);
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

/** What the host recorded for a checkout: its git mounts, its dependency volumes and the container settings of its graph and sandbox setup. */
export type CheckoutContainerSpec = { mounts: Mount[]; sharedMounts?: SharedMount[]; direct?: string[] } & Pick<
  Graph,
  'image' | 'network'
>;

const volume = (name: string, dst: string, nocopy = false, readonly = false) => {
  if (!/^\w[\w.-]*$/.test(name) || /[,\n"]/.test(dst)) throw infra(`volume name not allowed: ${name}`);
  return [
    '--mount',
    `type=volume,src=${name},dst=${dst}${nocopy ? ',volume-nocopy' : ''}${readonly ? ',readonly' : ''}`,
  ];
};

/** Where package managers keep downloads when the shared cache is read-only. */
const scratch = Object.fromEntries(
  Object.entries(packageManagerCacheEnv).map(([k, v]) => [k, v.replace(/^\/cache/, '/tmp')])
);

/**
 * `docker run` for one command in a throwaway container. `dir` is `/work` and `home` is `/home/agent`. With `proxy`
 * the only routes out are the `direct` model hosts and, unless the graph's network is `models`, the egress allowlist; with
 * `none` there is no network, and with `open` any host. With `cache`, that volume is `/cache`, read-only unless a shared
 * mount overlays it there; each shared mount is a volume at its path. A `readonly` command gets every mount read-only
 * but its home.
 */
export const dockerArgs = (
  c: Command,
  image: string,
  name: string,
  { mounts, sharedMounts = [], network = 'egress', direct = [] }: CheckoutContainerSpec,
  cache = '',
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
  size.memory,
  '--memory-swap',
  size.memory,
  '--cpus',
  size.cpus,
  '--pids-limit',
  size.pids,
  ...bind({ src: c.dir, dst: inside.work, readonly: !!c.readonly }),
  ...(c.home ? bind({ src: c.home, dst: inside.home }) : []),
  ...(c.graph ? bind({ src: c.graph, dst: inside.graph, readonly: true }) : []),
  ...mounts.flatMap(m => bind({ ...m, readonly: !!(m.readonly || c.readonly) })),
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
        NO_PROXY: bypass(direct),
        no_proxy: bypass(direct),
      }),
    ...c.env,
    ...(c.graph && { AGENTGRAPH_DIR: inside.graph }),
  }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
  ...Object.keys(c.secrets ?? {}).flatMap(key => ['-e', key]),
  image,
  c.cmd,
  ...c.args,
];

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  Effect.async<string, SandboxError>(done => {
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
      Effect.orElseSucceed(() => '')
    )).trim();
    if (!dir)
      return built
        ? false
        : yield* new SandboxError({
            reason: 'host',
            detail: `The image ${tag} is missing on the runner host. Run \`docker pull ${tag}\` there.`,
          });
    const source = fileURLToPath(new URL(`../infra/local/${dir}`, import.meta.url));
    const hash = createHash('sha256');
    for (const f of readdirSync(source, { withFileTypes: true }).filter(f => f.isFile()))
      hash.update(f.name).update(readFileSync(join(source, f.name)));
    const digest = hash.digest('hex').slice(0, 12);
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

const forgeConfig = (origin: string) => ({
  'remote.origin.url': origin,
  'remote.origin.pushurl': origin,
  'receive.autogc': 'false',
  'receive.denyCurrentBranch': 'ignore',
  'gc.auto': '0',
});

/**
 * A sandbox: one container per command over linked worktrees of a read-only mirror of `origin` under `data`, or of
 * `origin` itself when it is a `local` forge's bare repo. With
 * `token`, the mirror's clone and fetch authenticate to github.com; containers never see it. Every container mounts
 * the volume `cache`, `agentgraph-cache` by default. A checkout for a graph starts from the graph's sandbox setup at its base, built once
 * with the toolchain and setup, and holds its dependency directories in volumes, never in the checkout. An empty cache
 * name turns the volume and sandbox setups off.
 */
export const dockerSandbox = (o: {
  data: string;
  origin: string;
  local?: boolean;
  image?: string;
  cache?: string;
  direct?: string[];
  token?: Effect.Effect<string, ForgeError>;
}): Layer.Layer<Sandbox> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const image = o.image ?? sandboxImage;
      const cache = o.cache ?? 'agentgraph-cache';
      const mirror = o.local ? o.origin : join(o.data, 'mirror.git');
      let configured = false;
      const lock = yield* Effect.makeSemaphore(1);
      if (cache) yield* Effect.promise(() => removeOrphanedVolumes(30_000).catch(() => 0));
      reap(o.data);
      const disk = { dir: o.data, ...(cache && { image, volume: cache }) };
      const roomy = Effect.tryPromise({ try: () => ensureFreeDisk(disk), catch: e => infra((e as Error).message) });
      /** Each live checkout as the host made it. */
      const made = new Map<string, CheckoutContainerSpec>();
      const inMirror = (args: string[], env: Record<string, string> = {}) =>
        Effect.map(hostGit({ GIT_DIR: mirror, ...env }, args), out => out.toString('utf8').trim());
      const ready = yield* Effect.cachedFunction((network: string) =>
        run('docker', ['network', 'inspect', '--format', '{{.Internal}}', network]).pipe(
          Effect.filterOrFail(
            internal => internal === 'true',
            () => infra(`the ${network} network is not internal`)
          )
        )
      );

      const prepare = (c: Command) =>
        Effect.gen(function* () {
          yield* roomy;
          const box = made.get(c.dir) ?? { mounts: [] };
          if (c.network === 'proxy') yield* ready(networks[box.network ?? 'egress']);
          const name = `agentgraph-${randomBytes(6).toString('hex')}`;
          const args = yield* Effect.try({
            try: () => dockerArgs(c, box.image ?? image, name, { ...box, direct: o.direct ?? [] }, cache),
            catch: e => e as SandboxError,
          });
          return { name, args };
        });

      const lines = (c: Command) =>
        Stream.unwrapScoped(
          Effect.map(prepare(c), ({ name, args }) => {
            let code = 0;
            return Stream.asyncPush<string, SandboxError>(emit =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const proc = start(args, c.secrets, name, chunk => void emit.single(chunk));
                  void proc.closed.then(closed => {
                    code = closed;
                    return code === 125 ? emit.fail(infra('docker could not start the container')) : emit.end();
                  });
                  return proc;
                }),
                proc => proc.stop()
              )
            ).pipe(
              Stream.splitLines,
              Stream.concat(Stream.sync(() => ({ code }))),
              Stream.interruptWhen(
                Effect.zipRight(Effect.sleep(Duration.minutes(c.minutes)), Effect.failSync(timeout(c)))
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
            Effect.timeoutFail({ onTimeout: timeout(c), duration: Duration.minutes(c.minutes) })
          );
          if (code === 125) return yield* infra(`docker could not start the container: ${output.trim().slice(-2000)}`);
          return { code, output } satisfies Exit;
        });

      const empty = (graph?: Pick<Graph, 'image' | 'network'>) =>
        Effect.gen(function* () {
          const id = randomBytes(6).toString('hex');
          const [dir, news] = [join(o.data, 'work', id), join(o.data, 'news', id)];
          const remove = Effect.promise(() => {
            made.delete(dir);
            return Promise.all([dir, `${dir}.owner`, news].map(p => rm(p, { recursive: true, force: true })));
          });
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                writeCheckoutOwner(dir);
                await Promise.all([dir, news].map(p => mkdir(p, { recursive: true })));
                made.set(dir, {
                  ...(graph?.image !== undefined && { image: graph.image }),
                  ...(graph?.network !== undefined && { network: graph.network }),
                  sharedMounts: [],
                  mounts: [{ src: news, dst: news, readonly: true }],
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

      const checkout = (
        ref: string | undefined,
        branch?: string,
        keep?: string,
        graph?: Pick<Graph, 'image' | 'network' | 'toolchain' | 'setup'> & Partial<Pick<Graph, 'repo'>>
      ) =>
        Effect.gen(function* () {
          const box = graph?.image ?? image;
          const present = yield* run('docker', ['image', 'inspect', '--format', '{{.Id}}', box]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          );
          if (!present) yield* locked('images', ensureImage(box));
          if (ref === undefined) return yield* empty(graph);
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (o.local) {
                if (configured) return;
                for (const [key, value] of Object.entries(forgeConfig(mirror)))
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
                yield* Effect.promise(() =>
                  rename(part, mirror).catch(() => rm(part, { recursive: true, force: true }))
                );
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
          const saved = keep ? yield* verify(keep) : '';
          const own = branch ? yield* verify(`refs/heads/${branch}`) : '';
          const rev =
            own || (saved ? yield* verify(`${saved}^`) : (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`)));
          if (!rev) return yield* infra(`no commit for ${ref}`);
          const onto = (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`));
          const base = onto ? yield* inMirror(['merge-base', rev, onto]).pipe(Effect.orElseSucceed(() => rev)) : rev;
          yield* roomy;
          const setup = graph?.setup?.includes('AGENTGRAPH_DIR') ? undefined : graph?.setup;
          const env =
            graph && cache
              ? yield* Effect.tryPromise({
                  try: () =>
                    readSandboxSetup({
                      repo: graph.repo ?? 'repo',
                      image: graph.image ?? image,
                      git: mirror,
                      base,
                      cache,
                      ...(setup && { setup }),
                      ...(graph.toolchain && { toolchain: graph.toolchain }),
                    }),
                  catch: e => infra((e as Error).message),
                })
              : undefined;
          const match = env
            ? yield* Effect.promise(() =>
                readSetupInputKey(mirror, rev, env.mode).then(
                  i => i === env.inputs,
                  () => false
                )
              )
            : false;
          const id = randomBytes(6).toString('hex');
          const dir = join(o.data, 'work', id);
          const index = join(o.data, 'index', id);
          const news = join(o.data, 'news', id);
          const work: Checkout = {
            dir,
            base,
            ...(base !== rev && { head: rev }),
            ...(saved && { saved }),
            ...(env?.complete && setup && !saved && match && { ready: true }),
            ...(env && { env: { key: env.key, mode: env.mode, match } }),
            git: { GIT_DIR: mirror, GIT_WORK_TREE: dir, GIT_INDEX_FILE: index },
            news: join(news, 'news.md'),
          };
          const inWork = (args: string[]) => Effect.map(hostGit(work.git, args), out => out.toString('utf8').trim());
          const save = (name: string) =>
            Effect.gen(function* () {
              yield* inWork(['add', '-A']);
              const tree = yield* inWork(['write-tree']);
              const parents = [
                '-p',
                rev,
                ...(saved ? ['-p', saved] : []),
                ...(work.published ? ['-p', work.published] : []),
              ];
              const commit = yield* inWork([
                ...gitIdentity,
                'commit-tree',
                tree,
                ...parents,
                '-m',
                name + (work.published ? `\n\nbaseline ${work.published}` : ''),
              ]);
              yield* inWork(['update-ref', name, commit, saved]);
            }).pipe(
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
            admin = yield* Effect.tryPromise({
              try: () => worktreeAdmin(mirror, dir),
              catch: e => infra((e as Error).message),
            });
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(dirname(index), { recursive: true });
                await mkdir(news, { recursive: true });
                await copyFile(join(admin, 'index'), index);
              },
              catch: e => infra((e as Error).message),
            });
            if (saved) yield* inWork(['read-tree', '-u', '--reset', saved]);
            if (graph && cache)
              sharedMounts = yield* Effect.tryPromise({
                try: async () =>
                  createSharedMounts(
                    env ?? { image: graph.image ?? image, outputs: [] },
                    id,
                    dir,
                    await dependencyDirs(mirror, rev),
                    cache
                  ),
                catch: e => infra((e as Error).message),
              });
            const own = env?.image ?? graph?.image;
            work.written = () => written(sharedMounts, own ?? image);
            made.set(dir, {
              ...(own !== undefined && { image: own }),
              ...(graph?.network !== undefined && { network: graph.network }),
              sharedMounts,
              mounts: [
                { src: dirname(dirname(admin)), dst: dirname(dirname(admin)), readonly: true },
                { src: admin, dst: admin },
                { src: news, dst: news, readonly: true },
              ],
            });
          });
          const remove = Effect.promise(() => {
            made.delete(dir);
            return Promise.all([
              ...[dir, `${dir}.owner`, index, news, admin].filter(Boolean).map(p =>
                rm(p, { recursive: true, force: true }).catch(e => {
                  if ((e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e;
                })
              ),
              discard(sharedMounts),
            ]);
          });
          yield* Effect.acquireRelease(add.pipe(Effect.onError(() => remove)), () =>
            Effect.zipRight(keep ? save(keep) : Effect.void, remove)
          );
          return work;
        });

      return { checkout, exec, lines };
    })
  );
