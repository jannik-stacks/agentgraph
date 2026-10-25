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
import { hostGit } from './git.ts';
import type { Hub } from './hub.ts';
import { type Checkout, type Command, type Exit, Sandbox, SandboxError } from './sandbox.ts';

const exitFrame = '\u0000agentgraph-exit ';
const freshHeader = 'agentgraph-box-fresh';
const outputLimit = 64 << 10;

const infra = (detail: string) => new SandboxError({ reason: 'infra', detail });

type SyncedDir = { box: string; boxGit: string; git: Record<string, string> };

type BoxEntry = {
  url: string;
  work: Checkout;
  network: NonNullable<Hub['network']>;
  trees: Map<string, string>;
  sync: Effect.Semaphore;
  hub?: string;
  toolchain?: Command;
  ready: boolean;
};

const call = (url: string, init: RequestInit & { signal?: AbortSignal }) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, { signal, ...init });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).trim().slice(-2000)}`);
      return response;
    },
    catch: e => infra(`box ${init.method ?? 'GET'} ${url}: ${(e as Error).message}`),
  });

const op = (box: BoxEntry, name: string, args: string[], body?: Uint8Array) =>
  call(`${box.url}/${name}?${new URLSearchParams(args.map(arg => ['arg', arg]))}`, {
    method: 'POST',
    ...(body && { body: new Uint8Array(body) }),
  });

const treeOf = (git: Record<string, string>) =>
  Effect.zipRight(
    hostGit(git, ['add', '-A']),
    Effect.map(hostGit(git, ['write-tree']), out => out.toString('utf8').trim())
  );

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
    const tree = yield* treeOf(dir.git);
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
    yield* hostGit(dir.git, ['read-tree', '-u', '--reset', tree]);
    box.trees.set(dir.box, tree);
  });

const putDir = (box: BoxEntry, from: string, to: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      spawn('tar', ['-c', '-f', '-', '-C', from, '.'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      })
    ),
    tar =>
      Effect.flatMap(
        Effect.promise(() => buffer(tar.stdout)),
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
      });
      const homeDir = (home: string) =>
        Effect.map(homeGit(o.data, home), (git): SyncedDir => {
          const box = `/homes/${basename(home)}`;
          return { box, boxGit: `${box}.git`, git };
        });

      const before = (box: BoxEntry, c: Command, home?: SyncedDir) =>
        box.sync.withPermits(1)(
          Effect.gen(function* () {
            const init = yield* op(box, 'init', []);
            if (init.headers.has(freshHeader)) {
              box.trees.clear();
              delete box.hub;
              box.ready = false;
            }
            const { base, head = base } = box.work;
            yield* push(box, workDir(box), [...new Set([head, base])]);
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
            yield* before(box, c, home);
            if (!box.ready && c !== box.toolchain) yield* provision(box);
            yield* news(box);
            yield* Effect.forkScoped(Effect.repeat(Effect.ignore(news(box)), Schedule.spaced('1 minute')));
            const env = {
              TMPDIR: '/tmp',
              HOME: home?.box ?? '/tmp',
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'safe.directory',
              GIT_CONFIG_VALUE_0: '*',
              ...c.env,
              ...(c.hub && { AGENTGRAPH_HUB: '/hub' }),
              ...Object.fromEntries(Object.entries(c.secrets ?? {}).map(([k, v]) => [k, Redacted.value(v)])),
            };
            const network = c.network === 'proxy' ? box.network : c.network;
            const argv = [String(c.minutes), ...Object.entries(env).map(([k, v]) => `${k}=${v}`), c.cmd, ...c.args];
            const id = randomUUID();
            const response = yield* call(`${box.url}/run?network=${network}&id=${id}`, {
              method: 'POST',
              body: JSON.stringify(argv),
            });
            if (response.headers.has(freshHeader)) return yield* infra('the box restarted before the command ran');
            let code: number | undefined;
            let pulled = false;
            yield* Effect.addFinalizer(() =>
              pulled
                ? Effect.void
                : Effect.ignore(Effect.zipRight(op(box, 'stop', [id]), Effect.retry(after(box, home), { times: 2 })))
            );
            const ended = Effect.gen(function* () {
              yield* after(box, home);
              pulled = true;
              if (code === undefined) return yield* infra('the box stream ended without an exit code');
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
              Stream.concat(Stream.fromEffect(ended))
            );
          })
        ).pipe(
          Stream.interruptWhen(
            Effect.zipRight(
              Effect.sleep(Duration.minutes(c.minutes)),
              Effect.fail(new SandboxError({ reason: 'timeout', detail: `no exit after ${c.minutes} minutes` }))
            )
          )
        );

      const provision = (box: BoxEntry) =>
        Effect.gen(function* () {
          if (!box.toolchain) return;
          const out = yield* exec(box.toolchain);
          if (out.code !== 0) return yield* infra(`toolchain exited ${out.code}: ${out.output.trim().slice(-2000)}`);
          box.ready = true;
        });

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
            ready: true,
          };
          if (work.git.GIT_INDEX_FILE && existsSync(work.git.GIT_INDEX_FILE))
            copyFileSync(work.git.GIT_INDEX_FILE, syncIndex(work));
          yield* Effect.acquireRelease(
            Effect.sync(() => boxes.set(work.dir, box)),
            () =>
              Effect.zipRight(
                Effect.sync(() => {
                  boxes.delete(work.dir);
                  rmSync(syncIndex(work), { force: true });
                }),
                Effect.ignore(call(box.url, { method: 'DELETE' }))
              )
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
