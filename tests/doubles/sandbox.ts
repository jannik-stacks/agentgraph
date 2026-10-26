import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { Duration, Effect, Layer, Redacted, Stream } from 'effect';
import { gitIdentity } from '../../src/git.ts';
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

/** Commands on the host, with clones of the local git repo `repo` as worktrees. No network rules. */
export const hostSandbox = (repo: string): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
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
        await git('git', ['clone', '-q', repo, dir]);
        if (ref.startsWith('refs/')) await run('fetch', '-q', 'origin', `+${ref}:${ref}`);
        const base = await run('rev-parse', '--verify', `origin/${ref}`).catch(() => run('rev-parse', '--verify', ref));
        const kept = keep
          ? await run('fetch', '-q', 'origin', `+${keep}:${keep}`).then(
              () => run('rev-parse', keep),
              () => ''
            )
          : '';
        const remote = branch ? await run('rev-parse', '--verify', `origin/${branch}`).catch(() => '') : '';
        const from = remote || (kept ? await run('rev-parse', '--verify', `${kept}^`) : base);
        const fork = await run('merge-base', from, base).catch(() => from);
        await run('checkout', '-q', ...(branch ? ['-B', branch] : ['--detach']), from);
        if (kept) await run('read-tree', '-u', '--reset', kept);
        return { dir, base: fork, run, from, kept, news };
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
            const parents = [
              '-p',
              from,
              ...(kept ? ['-p', kept] : []),
              ...(checked?.published ? ['-p', checked.published] : []),
            ];
            const commit = await run(
              ...gitIdentity,
              'commit-tree',
              await run('write-tree'),
              ...parents,
              '-m',
              keep + (checked?.published ? `\n\nbaseline ${checked.published}` : '')
            );
            await run('push', '-q', 'origin', `+${commit}:${keep}`);
          }).pipe(
            Effect.mapError(e => new Error(`unsaved checkout preserved at ${dir}: ${String(e)}`, { cause: e })),
            Effect.orDie,
            Effect.zipRight(
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
      Effect.async<Exit, SandboxError>(resume => {
        const child = spawned(command);
        let output = '';
        const collect = (chunk: Buffer) => void (output += chunk.toString());
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', e => resume(Effect.fail(new SandboxError({ reason: 'infra', detail: e.message }))));
        child.on('close', code => resume(Effect.succeed({ code: code ?? 137, output })));
        return Effect.sync(() => child.kill('SIGKILL'));
      }).pipe(Effect.timeoutFail({ duration: Duration.minutes(command.minutes), onTimeout: late(command) })),
    lines: command =>
      Stream.async<string | Pick<Exit, 'code'>, SandboxError>(emit => {
        const child = spawned(command);
        createInterface({ input: child.stdout }).on('line', line => void emit.single(line));
        child.on('error', e => void emit.fail(new SandboxError({ reason: 'infra', detail: e.message })));
        child.on('close', code => void emit.single({ code: code ?? 137 }).then(() => emit.end()));
        return Effect.sync(() => child.kill('SIGKILL'));
      }).pipe(
        Stream.interruptWhen(
          Effect.zipRight(Effect.sleep(Duration.minutes(command.minutes)), Effect.failSync(late(command)))
        )
      ),
  });
