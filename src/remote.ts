import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { Duration, Effect, Layer, Redacted, Schedule, Stream } from 'effect';
import { dockerSandbox } from './docker.ts';
import { makeToolchainSetupCommands } from './env.ts';
import type { ForgeError } from './forge.ts';
import { hostGit, indexLock, makeHostEnv } from './git.ts';
import type { Hub } from './hub.ts';
import { type Checkout, type Command, type Exit, Sandbox, SandboxError } from './sandbox.ts';

const exitFrame = '\u0000agentgraph-exit ';
const freshHeader = 'agentgraph-box-fresh';
const outputLimit = 64 << 10;

const infra = (detail: string) => new SandboxError({ reason: 'infra', detail });

type SyncedDir = { box: string; boxGit: string; git: Record<string, string>; tracked?: Record<string, string> };

type BoxEntry = {
  url: string;
  work: Checkout;
  network: NonNullable<Hub['network']>;
  trees: Map<string, string>;
  sync: Effect.Semaphore;
  provisioning: Effect.Semaphore;
  hub?: string;
  toolchain?: Command;
  ready: boolean;
  roots?: string;
  pending: Map<string, SyncedDir>;
  lost: Set<string>;
  restarted?: true;
};

const call = (url: string, init: RequestInit & { signal?: AbortSignal }, onFresh = () => {}) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, { signal, ...init });
      if (response.headers.has(freshHeader)) onFresh();
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).trim().slice(-2000)}`);
      return response;
    },
    catch: e => infra(`box ${init.method ?? 'GET'} ${url}: ${(e as Error).message}`),
  });

const op = (box: BoxEntry, name: string, args: string[], body?: Uint8Array) =>
  Effect.filterOrFail(
    call(
      `${box.url}/${name}?${new URLSearchParams(args.map(arg => ['arg', arg]))}`,
      { method: 'POST', ...(body && { body: new Uint8Array(body) }) },
      () => name === 'init' || (box.restarted = true)
    ),
    response => name === 'init' || !response.headers.has(freshHeader),
    () => infra(`the box restarted during ${name}`)
  );

const treeOf = (dir: SyncedDir) =>
  Effect.gen(function* () {
    if (dir.tracked) {
      const paths = yield* hostGit(dir.tracked, ['ls-files', '-z']);
      yield* hostGit(dir.git, ['update-index', '--add', '--remove', '-z', '--stdin'], { input: paths });
    }
    yield* hostGit(dir.git, ['add', '-A']);
    return (yield* hostGit(dir.git, ['write-tree'])).toString('utf8').trim();
  });

const packObjects = (git: Record<string, string>, objects: string[]) =>
  Effect.flatMap(hostGit(git, ['rev-list', '--objects', '--no-walk', ...objects]), list =>
    hostGit(git, ['pack-objects', '-q', '--stdout'], { input: list })
  );

const homeGit = (data: string, home: string) =>
  Effect.gen(function* () {
    const gitDir = join(data, 'sync', `${basename(home)}.git`);
    const git = { GIT_DIR: gitDir, GIT_WORK_TREE: home };
    yield* hostGit({}, ['init', '-q', '--bare', gitDir]);
    yield* hostGit(git, ['config', 'core.bare', 'false']);
    yield* Effect.promise(() => writeFile(join(gitDir, 'info', 'exclude'), '/.cache/\n'));
    return git;
  });

const push = (box: BoxEntry, dir: SyncedDir, roots: string[] = []) =>
  Effect.gen(function* () {
    const tree = yield* treeOf(dir);
    const known = box.trees.get(dir.box);
    if (tree === known) return;
    const objects = known ? [tree, '--not', known] : [...roots, tree];
    const pack = yield* packObjects({ GIT_DIR: dir.git.GIT_DIR! }, objects);
    yield* op(box, 'push', [dir.box, dir.boxGit, tree, ...(known ? [] : roots)], pack);
    box.trees.set(dir.box, tree);
  });

const pull = (box: BoxEntry, dir: SyncedDir) =>
  Effect.gen(function* () {
    const known = box.trees.get(dir.box);
    if (!known) return;
    const response = yield* op(box, 'pull', [dir.box, dir.boxGit, known]);
    const body = Buffer.from(yield* Effect.promise(() => response.arrayBuffer()));
    const end = body.indexOf(10);
    const tree = body.subarray(0, end).toString('utf8');
    if (end < 0 || !/^[0-9a-f]{40,64}$/.test(tree)) return yield* infra(`box pull ${dir.box}: no tree`);
    if (tree === known) return;
    yield* hostGit({ GIT_DIR: dir.git.GIT_DIR! }, ['index-pack', '--stdin', '--strict'], {
      input: body.subarray(end + 1),
    });
    yield* indexLock.withPermits(1)(
      Effect.gen(function* () {
        yield* hostGit(dir.git, ['read-tree', '-u', '--reset', tree]);
        if (!dir.tracked) return;
        const forced = yield* hostGit(dir.git, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard']);
        if (forced.length > 0)
          yield* hostGit(dir.tracked, ['update-index', '--add', '-z', '--stdin'], { input: forced });
      })
    );
    box.trees.set(dir.box, tree);
  });

const putDir = (box: BoxEntry, from: string, to: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      spawn('tar', ['-c', '-f', '-', '-C', from, '.'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: makeHostEnv({ COPYFILE_DISABLE: '1' }),
      })
    ),
    tar =>
      Effect.flatMap(
        Effect.tryPromise({
          try: () =>
            Promise.all([
              buffer(tar.stdout),
              new Promise<number | null>((done, fail) => tar.once('error', fail).once('close', done)),
            ]).then(([tarball, code]) => {
              if (code !== 0) throw new Error(`exited ${code}`);
              return tarball;
            }),
          catch: e => infra(`tar ${from}: ${(e as Error).message}`),
        }),
        tarball => op(box, 'put', [to], tarball)
      ),
    tar => Effect.sync(() => tar.kill('SIGKILL'))
  );

export const remoteSandbox = (o: {
  url: string;
  data: string;
  origin: string;
  token?: Effect.Effect<string, ForgeError>;
}): Layer.Layer<Sandbox> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const host = yield* Effect.provide(Sandbox, dockerSandbox({ ...o, cache: '' }));
      const boxes = new Map<string, BoxEntry>();
      const syncIndex = (work: Checkout) => join(o.data, 'sync', `${basename(work.dir)}.index`);
      const workDir = (box: BoxEntry): SyncedDir => ({
        box: '/work',
        boxGit: '/work/.git',
        git: { ...box.work.git, GIT_INDEX_FILE: syncIndex(box.work) },
        tracked: box.work.git,
      });
      const homeDir = (home: string) =>
        Effect.map(homeGit(o.data, home), (git): SyncedDir => {
          const box = `/homes/${basename(home)}`;
          return { box, boxGit: `${box}.git`, git };
        });

      const recover = (box: BoxEntry) =>
        Effect.zipRight(
          Effect.forEach(
            [...box.lost],
            id =>
              Effect.zipRight(
                op(box, 'stop', [id]),
                Effect.sync(() => box.lost.delete(id))
              ),
            { discard: true }
          ),
          Effect.forEach(
            [...box.pending.values()],
            dir =>
              Effect.zipRight(
                pull(box, dir),
                Effect.sync(() => box.pending.delete(dir.box))
              ),
            { discard: true }
          )
        );

      const before = (box: BoxEntry, c: Command, home?: SyncedDir) =>
        box.sync.withPermits(1)(
          Effect.gen(function* () {
            const init = yield* op(box, 'init', []);
            if (init.headers.has(freshHeader) || box.restarted) {
              delete box.restarted;
              const lost = box.pending.size > 0;
              box.pending.clear();
              box.lost.clear();
              box.trees.clear();
              delete box.hub;
              box.ready = false;
              if (lost)
                return yield* infra(
                  `the box restarted before its last work came back; look for kept/${basename(box.work.dir)}.tgz in the data bucket`
                );
            }
            yield* recover(box);
            const { base, head = base } = box.work;
            const roots = [...new Set([head, base])];
            if (box.roots !== roots.join(' ')) box.trees.delete('/work');
            yield* push(box, workDir(box), roots);
            box.roots = roots.join(' ');
            if (home) yield* push(box, home);
            if (c.hub && box.hub !== c.hub) {
              yield* putDir(box, c.hub, '/hub');
              box.hub = c.hub;
            }
          })
        );

      const after = (box: BoxEntry, home?: SyncedDir) =>
        box.sync.withPermits(1)(Effect.zipRight(pull(box, workDir(box)), home ? pull(box, home) : Effect.void));

      const news = (box: BoxEntry) => putDir(box, dirname(box.work.news), dirname(box.work.news));

      const lines = (c: Command): Stream.Stream<string | Pick<Exit, 'code'>, SandboxError> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const box = boxes.get(c.dir);
            if (!box) return yield* infra(`${c.dir} is not a checkout of this sandbox`);
            const home = c.home ? yield* homeDir(c.home) : undefined;
            const late = () => new SandboxError({ reason: 'timeout', detail: `no exit after ${c.minutes} minutes` });
            const bounded = { duration: Duration.minutes(c.minutes), onTimeout: late };
            yield* Effect.timeoutFail(before(box, c, home), bounded);
            if (!box.ready && c !== box.toolchain) yield* provision(box);
            yield* Effect.timeoutFail(news(box), bounded);
            yield* Effect.forkScoped(Effect.repeat(Effect.ignore(news(box)), Schedule.spaced('1 minute')));
            const env: Record<string, string> = {
              TMPDIR: '/tmp',
              HOME: home?.box ?? '/tmp',
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'safe.directory',
              GIT_CONFIG_VALUE_0: '*',
              ...c.env,
              ...(c.hub && { AGENTGRAPH_HUB: '/hub' }),
            };
            const secrets = Object.fromEntries(Object.entries(c.secrets ?? {}).map(([k, v]) => [k, Redacted.value(v)]));
            const network = c.network === 'proxy' ? box.network : c.network;
            const argv = [String(c.minutes), ...Object.entries(env).map(([k, v]) => `${k}=${v}`), c.cmd, ...c.args];
            const id = randomUUID();
            let stopped = false;
            let code: number | undefined;
            let pulled = false;
            yield* Effect.addFinalizer(() =>
              pulled
                ? Effect.void
                : Effect.timeout(
                    Effect.interruptible(
                      Effect.zipRight(
                        Effect.tap(op(box, 'stop', [id]), () => (stopped = true)),
                        Effect.retry(after(box, home), { times: 2 })
                      )
                    ),
                    '5 minutes'
                  ).pipe(
                    Effect.catchAllCause(() =>
                      Effect.sync(() => {
                        if (!stopped) box.lost.add(id);
                        for (const dir of [workDir(box), ...(home ? [home] : [])]) box.pending.set(dir.box, dir);
                      })
                    )
                  )
            );
            const response = yield* Effect.timeoutFail(
              call(
                `${box.url}/run?network=${network}&id=${id}`,
                { method: 'POST', body: JSON.stringify({ argv, secrets }) },
                () => (box.restarted = true)
              ),
              bounded
            );
            if (response.headers.has(freshHeader)) {
              pulled = true;
              return yield* infra('the box restarted before the command ran');
            }
            const ended = Effect.gen(function* () {
              if (code === undefined) return yield* infra('the box stream ended without an exit code');
              yield* after(box, home);
              pulled = true;
              return { code };
            });
            return Stream.fromReadableStream(
              () => response.body!,
              e => infra(`box run: ${(e as Error).message}`)
            ).pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.filter(line => {
                code = line.startsWith(exitFrame) ? Number(line.slice(exitFrame.length)) : undefined;
                return code === undefined;
              }),
              Stream.concat(Stream.fromEffect(ended)),
              Stream.interruptWhen(Effect.zipRight(Effect.sleep(Duration.minutes(c.minutes)), Effect.fail(late())))
            );
          })
        );

      const provision = (box: BoxEntry) =>
        box.provisioning.withPermits(1)(
          Effect.gen(function* () {
            if (box.ready || !box.toolchain) return;
            const out = yield* exec(box.toolchain);
            if (out.code !== 0) return yield* infra(`toolchain exited ${out.code}: ${out.output.trim().slice(-2000)}`);
            box.ready = true;
          })
        );

      const exec = (c: Command) =>
        Stream.runFold(lines(c), { code: 0, output: '' }, (exit: Exit, piece) =>
          typeof piece === 'string'
            ? { ...exit, output: (exit.output + piece + '\n').slice(-outputLimit) }
            : { ...exit, ...piece }
        );

      const checkout = (
        ref: string,
        branch?: string,
        keep?: string,
        hub?: Pick<Hub, 'image' | 'network' | 'toolchain' | 'setup'> & Partial<Pick<Hub, 'repo'>>
      ) =>
        Effect.gen(function* () {
          if (hub?.image) return yield* infra(`a remote sandbox runs one image; the hub names ${hub.image}`);
          const work = yield* host.checkout(ref, branch, keep, hub);
          const box: BoxEntry = {
            url: `${o.url}/${basename(work.dir)}`,
            work,
            network: hub?.network ?? 'egress',
            trees: new Map(),
            sync: yield* Effect.makeSemaphore(1),
            provisioning: yield* Effect.makeSemaphore(1),
            ready: true,
            pending: new Map(),
            lost: new Set(),
          };
          if (work.git.GIT_INDEX_FILE && existsSync(work.git.GIT_INDEX_FILE))
            copyFileSync(work.git.GIT_INDEX_FILE, syncIndex(work));
          yield* Effect.acquireRelease(
            Effect.sync(() => boxes.set(work.dir, box)),
            () =>
              Effect.gen(function* () {
                boxes.delete(work.dir);
                yield* Effect.ignore(
                  Effect.timeout(Effect.interruptible(box.sync.withPermits(1)(recover(box))), '5 minutes')
                );
                rmSync(syncIndex(work), { force: true });
                if (box.pending.size + box.lost.size > 0)
                  return yield* Effect.logWarning(`kept the box ${box.url}: its last work did not come back`);
                yield* Effect.ignore(
                  Effect.timeout(Effect.interruptible(call(box.url, { method: 'DELETE' })), '1 minute')
                );
              })
          );
          if (!hub) return work;
          const files = yield* hostGit(work.git, ['ls-tree', '--name-only', work.head ?? work.base]);
          const toolchain = [
            ...makeToolchainSetupCommands(files.toString('utf8').split('\n')),
            ...(hub.toolchain ? [hub.toolchain] : []),
          ];
          if (toolchain.length === 0) return work;
          box.toolchain = {
            cmd: 'sh',
            args: ['-ec', toolchain.join('\n')],
            dir: work.dir,
            env: {},
            network: 'open',
            minutes: 30,
          };
          box.ready = false;
          yield* provision(box);
          return work;
        });

      yield* Effect.promise(() => mkdir(join(o.data, 'sync'), { recursive: true }));
      return { checkout, exec: (c: Command) => Effect.scoped(exec(c)), lines };
    })
  );
