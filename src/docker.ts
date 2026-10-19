import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Duration, Effect, Layer, Redacted, Stream } from 'effect';
import type { ForgeError } from './forge.ts';
import type { Hub } from './hub.ts';
import { type Command, type Exit, hostGit, Sandbox, SandboxError, type Checkout } from './sandbox.ts';

/** The internal docker network for each hub `network`; only the egress one has the allowlist proxy on it. */
const networks = { egress: 'bothub-sandbox', models: 'bothub-models' } as const;
const egress = 'http://egress:8888';
const direct = 'litellm,ollama.internal,localhost,127.0.0.1';
const inside = { work: '/work', home: '/home/agent', tmp: '/tmp', hub: '/hub' };
const limits = { memory: '4g', cpus: '1.5', pids: '512' };
const outputLimit = 64 << 10;
/** The mirror takes branches and tags only, so fork code in `refs/pull/*` never reaches a session. */
const fetched = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'];
const ident = ['-c', 'user.name=bothub', '-c', 'user.email=bothub@localhost'];

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

const user = () => {
  const id = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  if (id.startsWith('0:')) throw infra('refusing to run a container as root');
  return id;
};

/** What the host recorded for a checkout: its git mounts and the hub's container settings. */
type Made = { mounts: Mount[] } & Pick<Hub, 'image' | 'network'>;

/**
 * `docker run` for one command in a throwaway container. `dir` is `/work` and `home` is `/home/agent`. With `proxy`
 * the only routes out are the model proxy and, unless the hub's network is `models`, the egress allowlist; with
 * `none` there is no network.
 */
const dockerArgs = (c: Command, image: string, name: string, { mounts, network = 'egress' }: Made) => [
  'run',
  '--rm',
  '--init',
  '--pull',
  'never',
  '--name',
  name,
  '--network',
  c.network === 'proxy' ? networks[network] : 'none',
  '--read-only',
  '--tmpfs',
  `${inside.tmp}:rw,exec,nosuid,nodev,size=1g`,
  '--user',
  user(),
  '--cap-drop=ALL',
  '--security-opt',
  'no-new-privileges=true',
  '--memory',
  limits.memory,
  '--memory-swap',
  limits.memory,
  '--cpus',
  limits.cpus,
  '--pids-limit',
  limits.pids,
  ...bind({ src: c.dir, dst: inside.work }),
  ...(c.home ? bind({ src: c.home, dst: inside.home }) : []),
  ...(c.hub ? bind({ src: c.hub, dst: inside.hub, readonly: true }) : []),
  ...mounts.flatMap(bind),
  '--workdir',
  inside.work,
  ...Object.entries({
    TMPDIR: inside.tmp,
    HOME: c.home ? inside.home : inside.tmp,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    ...(c.network === 'proxy' &&
      network === 'egress' && {
        HTTPS_PROXY: egress,
        HTTP_PROXY: egress,
        https_proxy: egress,
        http_proxy: egress,
        NO_PROXY: direct,
        no_proxy: direct,
      }),
    ...c.env,
    ...(c.hub && { BOTHUB_HUB: inside.hub }),
  }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
  ...Object.keys(c.secrets ?? {}).flatMap(key => ['-e', key]),
  image,
  c.cmd,
  ...c.args,
];

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  Effect.async<string, SandboxError>(done => {
    const options = {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
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

/** Git config from the environment that sends `token` to github.com, so it stays out of argv and every config file. */
const auth = (token: string) => ({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
});

/** Starts `docker` with `args` in its own process group; `stop` kills it and removes the container. */
const start = (args: string[], secrets: Command['secrets'], name: string, on: (chunk: string) => void) => {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.DOCKER_HOST && { DOCKER_HOST: process.env.DOCKER_HOST }),
    ...(process.env.DOCKER_CONFIG && { DOCKER_CONFIG: process.env.DOCKER_CONFIG }),
    HOME: process.env.HOME ?? '/tmp',
    ...Object.fromEntries(Object.entries(secrets ?? {}).map(([key, value]) => [key, Redacted.value(value)])),
  };
  const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.setEncoding('utf8').on('data', on);
  child.stderr.setEncoding('utf8').on('data', on);
  const closed = new Promise<number>(done => {
    child.once('error', () => done(127));
    child.once('close', code => done(code ?? 137));
  });
  const stop = () =>
    Effect.promise(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
      execFile('docker', ['rm', '-f', name], () => {});
      return closed;
    });
  return { closed, stop };
};

const timeout = (c: Command) => () =>
  new SandboxError({ reason: 'timeout', detail: `no exit after ${c.minutes} minutes` });

/**
 * A sandbox: one container per command over linked worktrees of a read-only mirror of `origin` under `data`. With
 * `token`, the mirror's clone and fetch authenticate to github.com; containers never see it.
 */
export const docker = (o: {
  data: string;
  origin: string;
  image?: string;
  token?: Effect.Effect<string, ForgeError>;
}): Layer.Layer<Sandbox> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const image = o.image ?? 'bothub-sandbox:local';
      const mirror = join(o.data, 'mirror.git');
      const lock = yield* Effect.makeSemaphore(1);
      /** Each live checkout as the host made it. */
      const made = new Map<string, Made>();
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
          const box = made.get(c.dir) ?? { mounts: [] };
          if (c.network === 'proxy') yield* ready(networks[box.network ?? 'egress']);
          const name = `bothub-${randomBytes(6).toString('hex')}`;
          const args = yield* Effect.try({
            try: () => dockerArgs(c, box.image ?? image, name, box),
            catch: e => e as SandboxError,
          });
          return { name, args };
        });

      const lines = (c: Command) =>
        Stream.unwrapScoped(
          Effect.map(prepare(c), ({ name, args }) =>
            Stream.asyncPush<string, SandboxError>(emit =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const proc = start(args, c.secrets, name, chunk => void emit.single(chunk));
                  void proc.closed.then(code =>
                    code === 125 ? emit.fail(infra('docker could not start the container')) : emit.end()
                  );
                  return proc;
                }),
                proc => proc.stop()
              )
            ).pipe(Stream.splitLines, Stream.timeoutFail(timeout(c), Duration.minutes(c.minutes)))
          )
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

      const checkout = (ref: string, branch?: string, keep?: string, hub: Pick<Hub, 'image' | 'network'> = {}) =>
        Effect.gen(function* () {
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
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
            inMirror(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]).pipe(Effect.orElseSucceed(() => ''));
          const saved = keep ? yield* verify(keep) : '';
          const own = branch ? yield* verify(`refs/heads/${branch}`) : '';
          const rev =
            own || (saved ? yield* verify(`${saved}^`) : (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`)));
          if (!rev) return yield* infra(`no commit for ${ref}`);
          const id = randomBytes(6).toString('hex');
          const dir = join(o.data, 'work', id);
          const index = join(o.data, 'index', id);
          const news = join(o.data, 'news', id);
          const work: Checkout = {
            dir,
            base: rev,
            git: { GIT_DIR: mirror, GIT_WORK_TREE: dir, GIT_INDEX_FILE: index },
            news: join(news, 'news.md'),
          };
          const inWork = (args: string[]) => Effect.map(hostGit(work.git, args), out => out.toString('utf8').trim());
          const save = (name: string) =>
            Effect.gen(function* () {
              yield* inWork(['add', '-A']);
              const tree = yield* inWork(['write-tree']);
              const parents = ['-p', rev, ...(saved ? ['-p', saved] : [])];
              const commit = yield* inWork([...ident, 'commit-tree', tree, ...parents, '-m', name]);
              yield* inWork(['update-ref', name, commit]);
            }).pipe(Effect.ignoreLogged);
          let admin = '';
          const add = Effect.gen(function* () {
            yield* lock.withPermits(1)(inMirror(['worktree', 'add', '--detach', dir, rev]));
            admin = yield* Effect.tryPromise({
              try: async () => {
                const found = await worktreeAdmin(mirror, dir);
                await mkdir(dirname(index), { recursive: true });
                await mkdir(news, { recursive: true });
                await copyFile(join(found, 'index'), index);
                return found;
              },
              catch: e => infra((e as Error).message),
            });
            if (saved) yield* inWork(['read-tree', '-u', '--reset', saved]);
            made.set(dir, {
              ...(hub.image !== undefined && { image: hub.image }),
              ...(hub.network !== undefined && { network: hub.network }),
              mounts: [
                { src: dirname(dirname(admin)), dst: dirname(dirname(admin)), readonly: true },
                { src: admin, dst: admin },
                { src: news, dst: news, readonly: true },
              ],
            });
          });
          const remove = Effect.promise(() => {
            made.delete(dir);
            return Promise.all(
              [dir, index, news, admin].filter(Boolean).map(p => rm(p, { recursive: true, force: true }))
            );
          });
          yield* Effect.acquireRelease(add, () => Effect.zipRight(keep ? save(keep) : Effect.void, remove));
          return work;
        });

      return { checkout, exec, lines };
    })
  );
