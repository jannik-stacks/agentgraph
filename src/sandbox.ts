import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Context, Data, Effect, Redacted, Stream, type Scope } from 'effect';
import type { Hub } from './hub.ts';

/** One command in the sandbox: `dir` is its working directory, `home` its `HOME` when given. */
export type Command = {
  cmd: string;
  args: string[];
  dir: string;
  /** The hub directory, readable by the command as `$AGENTGRAPH_HUB`, never writable. */
  hub?: string;
  home?: string;
  env: Record<string, string>;
  secrets?: Record<string, Redacted.Redacted>;
  /** `open` reaches any host. */
  network: 'none' | 'proxy' | 'open';
  minutes: number;
};

export type Exit = { code: number; output: string };

/**
 * A checkout: the work tree `dir`, the commit `base` its change is measured from, and `git`, the repo and index host git
 * uses for it. On an existing branch `base` is where the branch forks from the ref, and `head` is the branch commit the
 * files start from.
 * `git` names only paths the host keeps out of the sandbox's reach. `news` is a file outside `dir` that only the host
 * writes; the sandbox reads it at the same path.
 */
export type Checkout = {
  dir: string;
  base: string;
  head?: string;
  saved?: string;
  published?: string;
  /** The checkout starts from an Env that already ran the hub's setup on these files. */
  ready?: boolean;
  /** The Env the checkout starts from, how it was built, and whether it was built from the checkout's own files. */
  env?: { key: string; mode: 'deps' | 'tree'; match: boolean };
  git: { GIT_DIR: string; GIT_WORK_TREE: string; GIT_INDEX_FILE?: string };
  news: string;
  /** How many files the checkout's commands wrote over the shared cache so far, when the sandbox can tell. */
  written?: () => Promise<number | undefined>;
};

export class SandboxError extends Data.TaggedError('SandboxError')<{
  reason: 'timeout' | 'stalled' | 'infra';
  detail: string;
}> {}

/**
 * Where a run's checkout lives and where its scripts and harnesses run. Docker, or the host in tests. With `keep`, a
 * checkout starts from the files last kept under that ref, on the run branch when it exists, else on their base.
 * It keeps its own files there as one local commit when its scope closes. Every command in a checkout runs in the
 * `image` and on the `network` of the `hub` it was made for, starting from that hub's Env at the base when there is one.
 */
export class Sandbox extends Context.Tag('agentgraph/Sandbox')<
  Sandbox,
  {
    checkout: (
      ref: string,
      branch?: string,
      keep?: string,
      hub?: Pick<Hub, 'image' | 'network' | 'toolchain' | 'setup'> & Partial<Pick<Hub, 'repo'>>
    ) => Effect.Effect<Checkout, SandboxError, Scope.Scope>;
    exec: (command: Command) => Effect.Effect<Exit, SandboxError, Scope.Scope>;
    lines: (command: Command) => Stream.Stream<string, SandboxError, Scope.Scope>;
  }
>() {}

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
 * runs in the temp dir, for a clone. `input` goes to its stdin; an exit code in `codes` also succeeds.
 */
export const hostGit = (
  env: Record<string, string>,
  args: string[],
  { input, codes = [] }: { input?: string; codes?: number[] } = {}
) =>
  Effect.async<Buffer, SandboxError>(resume => {
    const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'));
    const child = spawn('git', [...hardened, ...args], {
      cwd: env.GIT_WORK_TREE ?? env.GIT_DIR ?? tmpdir(),
      detached: true,
      env: {
        ...Object.fromEntries(inherited),
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        ...env,
      },
    });
    let closed = false;
    let problem: string | undefined;
    const stop = () => {
      if (closed || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
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
    Effect.timeoutFail({
      duration: '10 minutes',
      onTimeout: () =>
        new SandboxError({ reason: 'infra', detail: `git ${args.slice(0, 3).join(' ')}: git timed out` }),
    })
  );

const ident = ['-c', 'user.name=agentgraph', '-c', 'user.email=agentgraph@localhost'];

/** Keeps the last published tree as a local commit for saved-work replay. */
export const published = (work: Checkout, tree: string) =>
  Effect.map(hostGit(work.git, [...ident, 'commit-tree', tree, '-m', 'Published work']), out => {
    work.published = out.toString('utf8').trim();
  });

/** `head` merged onto `onto` as a tree, conflict markers left in the files that clash, which come back in `files`. */
export const mergeOf = (work: Checkout, onto: string, head: string, base?: string) =>
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
