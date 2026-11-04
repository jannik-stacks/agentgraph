import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Effect, Semaphore } from 'effect';
import { SandboxError, type Checkout } from './sandbox.ts';

export const indexLock = Semaphore.makeUnsafe(1);

const hardened = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'commit.gpgsign=false',
];

const passed = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'SSL_CERT_FILE',
  'GIT_SSL_CAINFO',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
];

export const makeHostEnv = (env: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(passed.flatMap(name => (process.env[name] === undefined ? [] : [[name, process.env[name]!]]))),
  ...env,
});

/**
 * Host git for the repo `env` names, with no user config, hooks, gc, signing, optional locks, lazy fetches or inherited `GIT_*` variables. Without `GIT_DIR` it
 * runs in the temp dir, for a clone. `input` goes to its stdin; an exit code in `codes` also succeeds.
 */
export const hostGit = (
  env: Record<string, string>,
  args: string[],
  { input, codes = [] }: { input?: string | Uint8Array; codes?: number[] } = {}
) =>
  Effect.callback<Buffer, SandboxError>(resume => {
    const child = spawn('git', [...hardened, ...args], {
      cwd: env.GIT_WORK_TREE ?? env.GIT_DIR ?? tmpdir(),
      detached: true,
      env: makeHostEnv({
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        ...env,
      }),
    });
    let closed = false;
    let problem: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const send = (name: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, name);
      } catch {
        child.kill(name);
      }
    };
    const stop = () => {
      if (closed || child.pid === undefined) return;
      send('SIGTERM');
      escalation ??= setTimeout(() => send('SIGKILL'), 5_000);
    };
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const lengths = { stdout: 0, stderr: 0 };
    const collect = (name: 'stdout' | 'stderr', chunks: Buffer[]) => (chunk: Buffer) => {
      lengths[name] += chunk.length;
      if (lengths[name] > 256 << 20) {
        problem = `${name} maxBuffer length exceeded`;
        stop();
      } else chunks.push(chunk);
    };
    child.stdout.on('data', collect('stdout', output));
    child.stderr.on('data', collect('stderr', errors));
    child.once('error', e => {
      problem = e.message;
    });
    const ending = new Promise<void>(resolve =>
      child.once('close', (code, signal) => {
        closed = true;
        clearTimeout(escalation);
        resume(
          problem || (code !== 0 && !codes.includes(code ?? -1))
            ? Effect.fail(
                new SandboxError({
                  reason: 'infra',
                  detail: `git ${args.slice(0, 3).join(' ')}: ${(Buffer.concat(errors).toString().trim() || problem || `exited ${code ?? signal}`).slice(-2000)}`,
                })
              )
            : Effect.succeed(Buffer.concat(output))
        );
        resolve();
      })
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
    return Effect.promise(async () => {
      if (!closed) {
        stop();
        await ending;
      }
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: '10 minutes',
      orElse: () =>
        Effect.fail(new SandboxError({ reason: 'infra', detail: `git ${args.slice(0, 3).join(' ')}: git timed out` })),
    })
  );

export const gitIdentity = ['-c', 'user.name=agentgraph', '-c', 'user.email=agentgraph@localhost'];

export const readGit = (...args: Parameters<typeof hostGit>) =>
  Effect.map(hostGit(...args), out => out.toString('utf8').trim());

export const readWorktreeAdmin = (mirror: string, dir: string) => {
  const file = join(dir, '.git');
  if (!lstatSync(file).isFile()) throw new Error('unsafe checkout pointer');
  const pointer = readFileSync(file, 'utf8');
  const admin = resolve(dir, pointer.slice('gitdir: '.length).trim());
  const expected = join(realpathSync(mirror), 'worktrees', basename(admin));
  if (!pointer.startsWith('gitdir: ') || realpathSync(admin) !== expected)
    throw new Error(`worktree admin dir ${admin} is not ${expected}`);
  return admin;
};

export const readBranches = (git: string) =>
  Effect.suspend(() =>
    existsSync(git)
      ? Effect.map(readGit({ GIT_DIR: git }, ['branch', '--list', '--format=%(refname:strip=2)']), out =>
          out.split('\n').filter(Boolean)
        )
      : Effect.succeed([])
  );

export const writeCheckoutTree = ({ git }: Pick<Checkout, 'git'>) =>
  indexLock.withPermits(1)(Effect.andThen(hostGit(git, ['add', '-A']), readGit(git, ['write-tree'])));

export const addGraphArgs = ['add', '-A', '--', '.', ':(exclude,glob)**/node_modules/**'];

export const ensureGraphRef = (git: Checkout['git'], dir: string) => {
  const env = {
    GIT_DIR: git.GIT_DIR,
    GIT_WORK_TREE: dir,
    GIT_INDEX_FILE: join(tmpdir(), `agentgraph-graph-${randomUUID()}`),
  };
  return Effect.gen(function* () {
    yield* hostGit(env, addGraphArgs);
    const tree = yield* readGit(env, ['write-tree']);
    const ref = `refs/agentgraph/graphs/${tree}`;
    yield* hostGit(env, ['update-ref', ref, tree, '']).pipe(
      Effect.catch(e =>
        Effect.flatMap(readGit(env, ['rev-parse', ref]), at => (at === tree ? Effect.void : Effect.fail(e)))
      )
    );
    return tree;
  }).pipe(Effect.ensuring(Effect.promise(() => rm(env.GIT_INDEX_FILE, { force: true }))));
};

export const commitCheckout = (
  work: Pick<Checkout, 'git'> & { tree?: string },
  name: string,
  old: string,
  parents: (string | undefined)[],
  message = name
) =>
  Effect.gen(function* () {
    const tree = work.tree ?? (yield* writeCheckoutTree(work));
    const commit = yield* readGit(work.git, [
      ...gitIdentity,
      'commit-tree',
      tree,
      ...parents.flatMap(p => (p ? ['-p', p] : [])),
      '-m',
      message,
    ]);
    yield* hostGit(work.git, ['update-ref', name, commit, old]);
  });

export const commitCheckoutOnce = (git: Checkout['git'], name: string, parents: (string | undefined)[]) =>
  Effect.gen(function* () {
    if (yield* Effect.isSuccess(hostGit(git, ['rev-parse', '--verify', '--quiet', name]))) return;
    yield* commitCheckout({ git }, name, '', parents);
  });

/** Keeps the last published tree as a local commit for saved-work replay. */
export const commitPublishedTree = (work: Checkout, tree: string) =>
  Effect.map(hostGit(work.git, [...gitIdentity, 'commit-tree', tree, '-m', 'Published work']), out => {
    work.published = out.toString('utf8').trim();
  });

/** `head` merged onto `onto` as a tree, conflict markers left in the files that clash, which come back in `files`. */
export const mergeTreeOnto = (work: Checkout, onto: string, head: string, base?: string) =>
  Effect.map(
    hostGit(
      work.git,
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        ...(base ? [`--merge-base=${base}`] : []),
        onto,
        head,
      ],
      { codes: [1] }
    ),
    out => {
      const [tree = '', ...files] = out.toString('utf8').trim().split('\n');
      return { tree, files: files.filter(Boolean) };
    }
  );
