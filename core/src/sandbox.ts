import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { Context, Data, Effect, Layer, Redacted, Stream, type Scope } from 'effect';

/** One command in the sandbox: `dir` is its working directory, `home` its `HOME` when given. */
export type Command = {
  cmd: string;
  args: string[];
  dir: string;
  home?: string;
  env: Record<string, string>;
  secrets?: Record<string, Redacted.Redacted>;
  network: 'none' | 'proxy';
  minutes: number;
};

export type Exit = { code: number; output: string };

/**
 * A checkout: the work tree `dir`, the commit `base` it starts from, and `git`, the repo and index host git uses for it.
 * `git` names only paths the host keeps out of the sandbox's reach. `news` is a file outside `dir` that only the host
 * writes; the sandbox reads it at the same path.
 */
export type Checkout = {
  dir: string;
  base: string;
  git: { GIT_DIR: string; GIT_WORK_TREE: string; GIT_INDEX_FILE?: string };
  news: string;
};

export class SandboxError extends Data.TaggedError('SandboxError')<{
  reason: 'timeout' | 'stalled' | 'infra';
  detail: string;
}> {}

/**
 * Where a run's checkout lives and where its scripts and harnesses run. Docker, or the host in tests. With `keep`, a
 * checkout starts from the files last kept under that ref, on the run branch when it exists, else on their base.
 * It keeps its own files there as one local commit when its scope closes.
 */
export class Sandbox extends Context.Tag('bothub/Sandbox')<
  Sandbox,
  {
    checkout: (ref: string, branch?: string, keep?: string) => Effect.Effect<Checkout, SandboxError, Scope.Scope>;
    exec: (command: Command) => Effect.Effect<Exit, SandboxError, Scope.Scope>;
    lines: (command: Command) => Stream.Stream<string, SandboxError, Scope.Scope>;
  }
>() {}

const git = promisify(execFile);

const hardened = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
];

/**
 * Host git for the repo `env` names, with no user config, hooks or inherited `GIT_*` variables. Without `GIT_DIR` it
 * runs in the temp dir, for a clone.
 */
export const hostGit = (env: Record<string, string>, args: string[]) =>
  Effect.async<Buffer, SandboxError>(resume => {
    const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
    execFile(
      'git',
      [...hardened, ...args],
      {
        cwd: env.GIT_WORK_TREE ?? env.GIT_DIR ?? tmpdir(),
        encoding: 'buffer',
        maxBuffer: 256 << 20,
        timeout: 600_000,
        env: {
          ...Object.fromEntries(inherited),
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_ATTR_NOSYSTEM: '1',
          ...env,
        },
      },
      (error, stdout, stderr) =>
        resume(
          error
            ? Effect.fail(
                new SandboxError({
                  reason: 'infra',
                  detail: `git ${args.slice(0, 3).join(' ')}: ${(stderr.toString().trim() || error.message).slice(-2000)}`,
                })
              )
            : Effect.succeed(stdout)
        )
    );
  });

const ident = ['-c', 'user.name=bothub', '-c', 'user.email=bothub@localhost'];

const spawned = (command: Command) =>
  spawn(command.cmd, command.args, {
    cwd: command.dir,
    env: {
      ...process.env,
      ...command.env,
      ...(command.home !== undefined && { HOME: command.home }),
      ...Object.fromEntries(Object.entries(command.secrets ?? {}).map(([k, v]) => [k, Redacted.value(v)])),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const late = (command: Command) =>
  new SandboxError({ reason: 'timeout', detail: `${command.cmd} ran past ${command.minutes} minutes` });

/** Commands on the host, with clones of the local git repo `repo` as worktrees. No network rules; for tests. */
export const host = (repo: string): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
    checkout: (ref, branch, keep) => {
      const work = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'bothub-work-'));
        const news = await mkdtemp(join(tmpdir(), 'bothub-news-'));
        const run = (...args: string[]) => git('git', args, { cwd: dir }).then(r => r.stdout.trim());
        await git('git', ['clone', '-q', repo, dir]);
        const base = await run('rev-parse', '--verify', `origin/${ref}`).catch(() => run('rev-parse', '--verify', ref));
        const kept = keep
          ? await run('fetch', '-q', 'origin', `+${keep}:${keep}`).then(
              () => run('rev-parse', keep),
              () => ''
            )
          : '';
        const remote = branch ? await run('rev-parse', '--verify', `origin/${branch}`).catch(() => '') : '';
        const from = kept ? await run('rev-parse', '--verify', `${kept}^`) : remote || base;
        await run('checkout', '-q', ...(branch ? ['-B', branch] : ['--detach']), from);
        if (kept) await run('read-tree', '-u', '--reset', kept);
        return { dir, base, run, from, kept, news };
      };
      return Effect.acquireRelease(
        Effect.tryPromise({
          try: work,
          catch: e => new SandboxError({ reason: 'infra', detail: `checkout ${ref}: ${(e as Error).message}` }),
        }),
        ({ dir, run, from, kept, news }) =>
          Effect.tryPromise(async () => {
            if (!keep) return;
            await run('add', '-A');
            const parents = ['-p', from, ...(kept ? ['-p', kept] : [])];
            const commit = await run(...ident, 'commit-tree', await run('write-tree'), ...parents, '-m', keep);
            await run('push', '-q', 'origin', `+${commit}:${keep}`);
          }).pipe(
            Effect.ignoreLogged,
            Effect.zipRight(
              Effect.promise(() => Promise.all([dir, news].map(p => rm(p, { recursive: true, force: true }))))
            )
          )
      ).pipe(
        Effect.map(({ dir, base, news }) => ({
          dir,
          base,
          git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
          news: join(news, 'news.md'),
        }))
      );
    },
    exec: command =>
      Effect.async<Exit, SandboxError>(resume => {
        const child = spawned(command);
        let output = '';
        const collect = (chunk: Buffer) => void (output += chunk.toString());
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resume(Effect.fail(late(command)));
        }, command.minutes * 60_000);
        child.on('error', e => {
          clearTimeout(timer);
          resume(Effect.fail(new SandboxError({ reason: 'infra', detail: e.message })));
        });
        child.on('close', code => {
          clearTimeout(timer);
          resume(Effect.succeed({ code: code ?? 1, output }));
        });
        return Effect.sync(() => {
          clearTimeout(timer);
          child.kill('SIGKILL');
        });
      }),
    lines: command =>
      Stream.async<string, SandboxError>(emit => {
        const child = spawned(command);
        createInterface({ input: child.stdout }).on('line', line => void emit.single(line));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          void emit.fail(late(command));
        }, command.minutes * 60_000);
        child.on('error', e => void emit.fail(new SandboxError({ reason: 'infra', detail: e.message })));
        child.on('close', () => {
          clearTimeout(timer);
          void emit.end();
        });
        return Effect.sync(() => {
          clearTimeout(timer);
          child.kill('SIGKILL');
        });
      }),
  });
