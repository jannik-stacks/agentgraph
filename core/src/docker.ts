import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Duration, Effect, Layer, Redacted, Stream } from 'effect';
import type { ForgeError } from './forge.ts';
import { type Command, type Exit, Sandbox, SandboxError } from './sandbox.ts';

const network = 'bothub-sandbox';
const egress = 'http://egress:8888';
const direct = 'litellm,ollama.internal,localhost,127.0.0.1';
const inside = { work: '/work', home: '/home/agent', tmp: '/tmp' };
const limits = { memory: '4g', cpus: '1.5', pids: '512' };
const outputLimit = 64 << 10;
/** Refs bothub writes into the mirror itself; the fetch leaves them alone. */
const ours = '^refs/bothub/*';
const ident = ['-c', 'user.name=bothub', '-c', 'user.email=bothub@localhost'];

type Mount = { src: string; dst: string; readonly?: boolean };

const infra = (detail: string) => new SandboxError({ reason: 'infra', detail });

const bind = ({ src, dst, readonly }: Mount) => {
  if (/[,\n"]/.test(src + dst) || ['/', '/run', '/var/run'].includes(src) || src.endsWith('docker.sock'))
    throw infra(`mount not allowed: ${src}`);
  return ['--mount', `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`];
};

/** The mirror (read-only) and the worktree's own admin dir a linked worktree's `.git` file points into. */
const gitMounts = async (dir: string): Promise<Mount[]> => {
  const dotGit = await readFile(join(dir, '.git'), 'utf8').catch(() => '');
  const gitdir = /^gitdir: (.+)$/m.exec(dotGit)?.[1]?.trim();
  if (!gitdir) return [];
  const admin = resolve(dir, gitdir);
  const common = resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8').catch(() => '../..')).trim());
  return [
    { src: common, dst: common, readonly: true },
    { src: admin, dst: admin },
  ];
};

const user = () => {
  const id = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  if (id.startsWith('0:')) throw infra('refusing to run a container as root');
  return id;
};

/**
 * `docker run` for one command in a hardened, throwaway container: read-only root, executable tmpfs `/tmp`, the host
 * user, no capabilities, no new privileges, resource limits and no image pulls. `dir` is `/work`, `home` is
 * `/home/agent`. With `proxy` the only routes out are the model proxy and the egress allowlist; with `none` there is
 * no network. Secrets travel by name, so their values never appear in argv.
 */
const dockerArgs = (c: Command, image: string, name: string, mounts: Mount[]) => [
  'run',
  '--rm',
  '--init',
  '--pull',
  'never',
  '--name',
  name,
  '--network',
  c.network === 'proxy' ? network : 'none',
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
  ...mounts.flatMap(bind),
  '--workdir',
  inside.work,
  ...Object.entries({
    TMPDIR: inside.tmp,
    HOME: c.home ? inside.home : inside.tmp,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
    ...(c.network === 'proxy' && {
      HTTPS_PROXY: egress,
      HTTP_PROXY: egress,
      https_proxy: egress,
      http_proxy: egress,
      NO_PROXY: direct,
      no_proxy: direct,
    }),
    ...c.env,
  }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
  ...Object.keys(c.secrets ?? {}).flatMap(key => ['-e', key]),
  image,
  c.cmd,
  ...c.args,
];

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  Effect.async<string, SandboxError>(done => {
    const options = { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout: 600_000, maxBuffer: 64 << 20 };
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
 * One container per command, on a network whose only way out is the model proxy. Worktrees are linked worktrees of a
 * bare mirror of `origin` under `data`; the mirror is mounted read-only so git works in `/work` while its refs stay
 * untouchable. With `token`, the mirror's clone and fetch authenticate to github.com; containers never see it.
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
      const ready = yield* Effect.cached(
        run('docker', ['network', 'inspect', '--format', '{{.Internal}}', network]).pipe(
          Effect.filterOrFail(
            internal => internal === 'true',
            () => infra(`the ${network} network is not internal`)
          )
        )
      );

      const prepare = (c: Command) =>
        Effect.gen(function* () {
          if (c.network === 'proxy') yield* ready;
          const mounts = yield* Effect.promise(() => gitMounts(c.dir));
          const name = `bothub-${randomBytes(6).toString('hex')}`;
          const args = yield* Effect.try({ try: () => dockerArgs(c, image, name, mounts), catch: e => e as SandboxError });
          return { name, args };
        });

      const lines = (c: Command) =>
        Stream.unwrapScoped(
          Effect.map(prepare(c), ({ name, args }) =>
            Stream.asyncPush<string, SandboxError>(emit =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const proc = start(args, c.secrets, name, chunk => void emit.single(chunk));
                  void proc.closed.then(code => (code === 125 ? emit.fail(infra('docker could not start the container')) : emit.end()));
                  return proc;
                }),
                proc => proc.stop()
              )
            ).pipe(
              Stream.splitLines,
              Stream.timeoutFail(timeout(c), Duration.minutes(c.minutes))
            )
          )
        );

      const exec = (c: Command) =>
        Effect.gen(function* () {
          const { name, args } = yield* prepare(c);
          let output = '';
          const proc = yield* Effect.acquireRelease(
            Effect.sync(() => start(args, c.secrets, name, chunk => void (output = (output + chunk).slice(-outputLimit)))),
            proc => proc.stop()
          );
          const code = yield* Effect.promise(() => proc.closed).pipe(
            Effect.timeoutFail({ onTimeout: timeout(c), duration: Duration.minutes(c.minutes) })
          );
          if (code === 125) return yield* infra(`docker could not start the container: ${output.trim().slice(-2000)}`);
          return { code, output } satisfies Exit;
        });

      const checkout = (ref: string, branch?: string, keep?: string) =>
        Effect.gen(function* () {
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const exists = yield* Effect.promise(() => readFile(join(mirror, 'HEAD')).then(() => true, () => false));
              const env = o.token ? auth(yield* Effect.mapError(o.token, e => infra(e.message))) : {};
              if (exists) yield* run('git', ['-C', mirror, 'fetch', '--prune', 'origin', '+refs/*:refs/*', ours], env);
              else {
                yield* Effect.promise(() => mkdir(dirname(mirror), { recursive: true }));
                yield* run('git', ['clone', '--mirror', o.origin, mirror], env);
              }
            })
          );
          const verify = (name: string) =>
            run('git', ['-C', mirror, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`]).pipe(
              Effect.orElseSucceed(() => '')
            );
          const saved = keep ? yield* verify(keep) : '';
          const own = branch ? yield* verify(`refs/heads/${branch}`) : '';
          const rev = saved
            ? yield* verify(`${saved}^`)
            : own || (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`));
          if (!rev) return yield* infra(`no commit for ${ref}`);
          const dir = join(o.data, 'work', randomBytes(6).toString('hex'));
          const save = (name: string) =>
            Effect.gen(function* () {
              yield* run('git', ['-C', dir, 'add', '-A']);
              const tree = yield* run('git', ['-C', dir, 'write-tree']);
              const parents = ['-p', rev, ...(saved ? ['-p', saved] : [])];
              const commit = yield* run('git', ['-C', dir, ...ident, 'commit-tree', tree, ...parents, '-m', name]);
              yield* run('git', ['-C', dir, 'update-ref', name, commit]);
            }).pipe(Effect.ignoreLogged);
          yield* Effect.acquireRelease(
            Effect.zipRight(
              lock.withPermits(1)(run('git', ['-C', mirror, 'worktree', 'add', '--detach', dir, rev])),
              saved ? run('git', ['-C', dir, 'read-tree', '-u', '--reset', saved]) : Effect.void
            ),
            () =>
              Effect.zipRight(
                keep ? save(keep) : Effect.void,
                lock.withPermits(1)(run('git', ['-C', mirror, 'worktree', 'remove', '--force', dir]).pipe(Effect.ignore))
              )
          );
          return { dir, base: rev };
        });

      return { checkout, exec, lines };
    })
  );
