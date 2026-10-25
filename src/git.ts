import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import { SandboxError, type Checkout } from './sandbox.ts';

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

const passed = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
];

export const makeHostEnv = (env: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(passed.flatMap(name => (process.env[name] === undefined ? [] : [[name, process.env[name]!]]))),
  ...env,
});

/**
 * Host git for the repo `env` names, with no user config, hooks or inherited `GIT_*` variables. Without `GIT_DIR` it
 * runs in the temp dir, for a clone. `input` goes to its stdin; an exit code in `codes` also succeeds.
 */
export const hostGit = (
  env: Record<string, string>,
  args: string[],
  { input, codes = [] }: { input?: string | Uint8Array; codes?: number[] } = {}
) =>
  Effect.async<Buffer, SandboxError>(resume => {
    const child = spawn('git', [...hardened, ...args], {
      cwd: env.GIT_WORK_TREE ?? env.GIT_DIR ?? tmpdir(),
      detached: true,
      env: makeHostEnv({
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        ...env,
      }),
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

export const gitIdentity = ['-c', 'user.name=agentgraph', '-c', 'user.email=agentgraph@localhost'];

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
