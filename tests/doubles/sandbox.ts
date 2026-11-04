import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { Cause, Duration, Effect, Layer, Queue, Redacted, Stream } from 'effect';
import { gitIdentity, readBranches } from '../../src/git.ts';
import { removeBranch } from '../../src/disk.ts';
import { Sandbox, SandboxError, type Checkout, type Command, type Exit } from '../../src/sandbox.ts';

const git = promisify(execFile);

const spawned = (command: Command) =>
  spawn(command.cmd, command.args, {
    cwd: command.dir,
    env: {
      ...process.env,
      ...command.env,
      ...(command.graph !== undefined && { AGENTGRAPH_DIR: command.graph }),
      ...(command.home !== undefined && { HOME: command.home }),
      ...Object.fromEntries(Object.entries(command.secrets ?? {}).map(([k, v]) => [k, Redacted.value(v)])),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const late = (command: Command) => () =>
  new SandboxError({ reason: 'timeout', detail: `${command.cmd} ran past ${command.minutes} minutes` });

const resolveCommits = async (cwd: string, revisions: string[]) => {
  const pending = git('git', ['cat-file', '--batch-check=%(objectname)'], { cwd });
  pending.child.stdin!.end(revisions.map(r => `${r}^{commit}\n`).join(''));
  return (await pending).stdout
    .split('\n')
    .slice(0, revisions.length)
    .map(line => (/^[0-9a-f]{40,64}$/.test(line) ? line : ''));
};

const attempts = 'refs/agentgraph/attempts/*';
const graphs = 'refs/agentgraph/graphs/*';

/** Commands on the host, with clones of the local git repo `repo` as worktrees. No network rules. */
export const hostSandbox = (repo: string, data = dirname(repo)): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
    readBranches: () => readBranches(repo),
    removeBranch: (branch, base, head) =>
      removeBranch(repo, branch, base === 'origin/HEAD' ? 'HEAD' : base, head, data),
    readHead: ref =>
      Effect.tryPromise({
        try: () => git('git', ['rev-parse', '--verify', ref], { cwd: repo }).then(r => r.stdout.trim()),
        catch: e => new SandboxError({ reason: 'infra', detail: (e as Error).message }),
      }),
    checkout: (ref, branch, keep) => {
      if (ref === undefined)
        return Effect.acquireRelease(
          Effect.promise(async () => {
            const [dir, news] = await Promise.all(
              ['agentgraph-work-', 'agentgraph-news-'].map(p => mkdtemp(join(tmpdir(), p)))
            );
            return {
              dir: dir!,
              base: '',
              git: { GIT_DIR: join(dir!, '.git'), GIT_WORK_TREE: dir! },
              news: join(news!, 'news.md'),
            };
          }),
          work => Effect.promise(() => Promise.all([work.dir, dirname(work.news)].map(p => rm(p, { recursive: true }))))
        );
      let checked: Checkout | undefined;
      const work = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'agentgraph-work-'));
        const news = await mkdtemp(join(tmpdir(), 'agentgraph-news-'));
        const run = (...args: string[]) => git('git', args, { cwd: dir }).then(r => r.stdout.trim());
        const kept = keep && (await resolveCommits(repo, [keep]))[0] ? keep : '';
        const fetched = [
          ...(ref.startsWith('refs/') ? [`+${ref}:${ref}`] : []),
          `${attempts}:${attempts}`,
          ...(kept ? [`+${kept}:${kept}`] : []),
        ];
        await git('git', [...fetched.flatMap(spec => ['-c', `remote.origin.fetch=${spec}`]), 'clone', '-q', repo, dir]);
        const [remoteBase = '', localBase = '', remote = '', keptCommit = '', keptParent = ''] = await resolveCommits(
          dir,
          [`origin/${ref}`, ref, branch ? `origin/${branch}` : '', kept, kept && `${kept}~1`]
        );
        const base = remoteBase || localBase;
        if (!base) throw new Error(`no commit ${ref}`);
        const from = remote || (kept ? keptParent : base);
        const fork = from === base ? base : await run('merge-base', from, base).catch(() => from);
        await run('checkout', '-q', ...(branch ? ['-B', branch] : ['--detach']), from);
        if (kept) await run('read-tree', '-u', '--reset', kept);
        return { dir, base: fork, run, from, kept: keptCommit, news };
      };
      return Effect.acquireRelease(
        Effect.tryPromise({
          try: work,
          catch: e => new SandboxError({ reason: 'infra', detail: `checkout ${ref}: ${(e as Error).message}` }),
        }),
        ({ dir, run, from, kept, news }) =>
          Effect.tryPromise(async () => {
            const parents = [
              '-p',
              from,
              ...(kept ? ['-p', kept] : []),
              ...(checked?.published ? ['-p', checked.published] : []),
            ];
            const saved =
              keep &&
              (await run('add', '-A').then(async () =>
                run(
                  ...gitIdentity,
                  'commit-tree',
                  await run('write-tree'),
                  ...parents,
                  '-m',
                  keep + (checked?.published ? `\n\nbaseline ${checked.published}` : '')
                )
              ));
            const push = () =>
              run(
                'push',
                '-q',
                'origin',
                `${attempts}:${attempts}`,
                `${graphs}:${graphs}`,
                ...(saved ? [`+${saved}:${keep}`] : [])
              );
            // UNEXPECTED: parallel runs on one graph create the same graphs ref at once; the retry finds it in place.
            await push().catch(push);
          }).pipe(
            Effect.mapError(e => new Error(`unsaved checkout preserved at ${dir}: ${String(e)}`, { cause: e })),
            Effect.orDie,
            Effect.andThen(
              Effect.promise(() => Promise.all([dir, news].map(p => rm(p, { recursive: true, force: true }))))
            )
          )
      ).pipe(
        Effect.map(
          ({ dir, base, from, kept, news }) =>
            (checked = {
              dir,
              base,
              ...(from !== base && { head: from }),
              ...(kept && { saved: kept }),
              git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
              news: join(news, 'news.md'),
            })
        )
      );
    },
    exec: command =>
      Effect.callback<Exit, SandboxError>(resume => {
        const child = spawned(command);
        let output = '';
        const collect = (chunk: Buffer) => void (output += chunk.toString());
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', e => resume(Effect.fail(new SandboxError({ reason: 'infra', detail: e.message }))));
        child.on('close', code => resume(Effect.succeed({ code: code ?? 137, output })));
        return Effect.sync(() => child.kill('SIGKILL'));
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.minutes(command.minutes),
          orElse: () => Effect.failSync(late(command)),
        })
      ),
    lines: command =>
      Stream.callback<string | Pick<Exit, 'code'>, SandboxError>(queue => {
        const child = spawned(command);
        createInterface({ input: child.stdout }).on('line', line => void Queue.offerUnsafe(queue, line));
        child.on('error', e =>
          Queue.failCauseUnsafe(queue, Cause.fail(new SandboxError({ reason: 'infra', detail: e.message })))
        );
        child.on('close', code => {
          Queue.offerUnsafe(queue, { code: code ?? 137 });
          Queue.endUnsafe(queue);
        });
        return Effect.addFinalizer(() => Effect.sync(() => child.kill('SIGKILL')));
      }).pipe(
        Stream.interruptWhen(
          Effect.andThen(Effect.sleep(Duration.minutes(command.minutes)), Effect.failSync(late(command)))
        )
      ),
  });
