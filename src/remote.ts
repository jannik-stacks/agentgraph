import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Duration, Effect, Exit, Layer, Redacted, Schedule, Scope, Semaphore, Stream } from 'effect';
import { getCachePath, makeToolchainSetupCommands } from './env.ts';
import { hostGit, indexLock, makeHostEnv } from './git.ts';
import type { Graph } from './folder.ts';
import { type Command, type Exit as CommandExit, inside, Runner, SandboxError } from './sandbox.ts';

const exitFrame = '\u0000agentgraph-exit ';
const freshHeader = 'agentgraph-box-fresh';

const infra = (detail: string) => new SandboxError({ reason: 'infra', detail });

const whyBoxRefused = (graph: Graph) => {
  if (graph.image) return `a box runs one image; the graph names ${graph.image}`;
  const limits = [graph.limits, ...Object.values(graph.workflows).flatMap(w => w.steps.flatMap(s => s.limits ?? []))];
  if (limits.some(l => l.memory !== undefined || l.cpus !== undefined))
    return 'a box cannot enforce memory or cpus limits';
  const tools = graph.tools ?? [];
  const agent = Object.values(graph.agents).find(a => a.tools.some(name => tools.includes(name)));
  return agent && `${agent.path}: a box cannot serve host tools`;
};

type SyncedDir = { box: string; git: Record<string, string>; tracked?: Record<string, string> };

export const makeBoxRunner = (
  data: string,
  open: (...args: Parameters<Runner['Service']['open']>) => Effect.Effect<
    {
      op: (
        name: 'init' | 'push' | 'pull' | 'put' | 'stop',
        args: string[],
        body?: Uint8Array
      ) => Effect.Effect<Uint8Array, SandboxError>;
      run: (
        argv: string[],
        secrets: Record<string, string>,
        network: Command['network'],
        id: string
      ) => Stream.Stream<string | Pick<CommandExit, 'code'>, SandboxError>;
    },
    SandboxError,
    Scope.Scope
  >,
  whyRefused?: Runner['Service']['whyRefused']
): Layer.Layer<Runner> =>
  Layer.effect(
    Runner,
    Effect.gen(function* () {
      yield* Effect.promise(() => mkdir(getCachePath(data, 'sync'), { recursive: true }));
      const homeDir = (home: string) =>
        Effect.gen(function* () {
          const git = { GIT_DIR: getCachePath(data, 'sync', `${basename(home)}.git`), GIT_WORK_TREE: home };
          yield* hostGit({}, ['init', '-q', '--bare', git.GIT_DIR]);
          yield* hostGit(git, ['config', 'core.bare', 'false']);
          yield* Effect.promise(() => writeFile(join(git.GIT_DIR, 'info', 'exclude'), '/.cache/\n'));
          return { box: `/homes/${basename(home)}`, git };
        });

      return {
        whyRefused: graph => whyBoxRefused(graph) ?? whyRefused?.(graph),
        open: (work, graph) =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            const box = yield* open(work, graph).pipe(
              Scope.provide(scope),
              Effect.onError(cause => Scope.close(scope, Exit.failCause(cause)))
            );
            const trees = new Map<string, string>();
            const unfinished = new Map<string, SyncedDir | undefined>();
            const sync = yield* Semaphore.make(1);
            const provisioning = yield* Semaphore.make(1);
            let graphDir: string | undefined;
            let roots: string | undefined;
            let ready = false;
            let toolchain: Command | undefined;
            const syncIndex = getCachePath(data, 'sync', `${basename(work.dir)}.index`);
            const workDir: SyncedDir = {
              box: inside.work,
              git: { ...work.git, GIT_INDEX_FILE: syncIndex },
              tracked: work.git,
            };

            const push = (dir: SyncedDir, from: string[] = []) =>
              Effect.gen(function* () {
                if (dir.tracked) {
                  const paths = yield* hostGit(dir.tracked, ['ls-files', '-z']);
                  yield* hostGit(dir.git, ['update-index', '--add', '--remove', '-z', '--stdin'], { input: paths });
                }
                yield* hostGit(dir.git, ['add', '-A']);
                const tree = (yield* hostGit(dir.git, ['write-tree'])).toString('utf8').trim();
                const known = trees.get(dir.box);
                if (tree === known) return;
                const git = { GIT_DIR: dir.git.GIT_DIR! };
                const objects = known ? [tree, '--not', known] : [...from, tree];
                const list = yield* hostGit(git, ['rev-list', '--objects', '--no-walk', ...objects]);
                const pack = yield* hostGit(git, ['pack-objects', '-q', '--stdout'], { input: list });
                yield* box.op('push', [dir.box, tree, ...(known ? [] : from)], pack);
                trees.set(dir.box, tree);
              });

            const pull = (dir: SyncedDir) =>
              Effect.gen(function* () {
                const known = trees.get(dir.box);
                if (!known) return;
                const body = Buffer.from(yield* box.op('pull', [dir.box, known]));
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
                    const forced = yield* hostGit(dir.git, [
                      'ls-files',
                      '-z',
                      '--cached',
                      '--ignored',
                      '--exclude-standard',
                    ]);
                    if (forced.length > 0)
                      yield* hostGit(dir.tracked, ['update-index', '--add', '-z', '--stdin'], { input: forced });
                  })
                );
                trees.set(dir.box, tree);
              });

            const put = (from: string, to: string) =>
              Effect.flatMap(
                Effect.tryPromise({
                  try: signal =>
                    promisify(execFile)('tar', ['-c', '-f', '-', '-C', from, '.'], {
                      encoding: 'buffer',
                      maxBuffer: Infinity,
                      signal,
                      killSignal: 'SIGKILL',
                      env: makeHostEnv({ COPYFILE_DISABLE: '1' }),
                    }),
                  catch: e => infra(`tar ${from}: ${(e as Error).message}`),
                }),
                tar => box.op('put', [to], tar.stdout)
              );

            const pullBack = (home?: SyncedDir) => Effect.andThen(pull(workDir), home ? pull(home) : Effect.void);

            const recover = Effect.gen(function* () {
              const left = [...unfinished];
              yield* Effect.forEach(left, ([id]) => box.op('stop', [id]), { discard: true });
              for (const [id, home] of left) {
                yield* pullBack(home);
                unfinished.delete(id);
              }
            });

            const before = (c: Command, home?: SyncedDir) =>
              sync.withPermits(1)(
                Effect.gen(function* () {
                  if ((yield* box.op('init', [])).length > 0) {
                    const lost = unfinished.size > 0;
                    unfinished.clear();
                    trees.clear();
                    graphDir = undefined;
                    ready = false;
                    if (lost)
                      return yield* infra(
                        `the box restarted before its last work came back; look for kept/${basename(work.dir)}.tgz in the data bucket`
                      );
                  }
                  yield* recover;
                  const { base, head = base } = work;
                  const from = [...new Set([head, base])];
                  if (roots !== from.join(' ')) trees.delete(inside.work);
                  yield* push(workDir, from);
                  roots = from.join(' ');
                  if (home) yield* push(home);
                  if (c.graph && graphDir !== c.graph) {
                    yield* put(c.graph, inside.graph);
                    graphDir = c.graph;
                  }
                })
              );

            const news = put(dirname(work.news), inside.news);

            const lines = (c: Command): Stream.Stream<string | Pick<CommandExit, 'code'>, SandboxError> =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const home = c.home ? yield* homeDir(c.home) : undefined;
                  const late = () =>
                    new SandboxError({ reason: 'timeout', detail: `no exit after ${c.minutes} minutes` });
                  const bounded = { duration: Duration.minutes(c.minutes), orElse: () => Effect.failSync(late) };
                  yield* Effect.timeoutOrElse(before(c, home), bounded);
                  if (c !== toolchain) yield* provision;
                  yield* Effect.timeoutOrElse(news, bounded);
                  yield* Effect.forkScoped(
                    Effect.repeat(
                      news.pipe(Effect.catch(e => Effect.logWarning('box news refresh failed', e))),
                      Schedule.spaced('1 minute')
                    )
                  );
                  const env: Record<string, string> = {
                    TMPDIR: inside.tmp,
                    HOME: home?.box ?? inside.tmp,
                    GIT_CONFIG_COUNT: '1',
                    GIT_CONFIG_KEY_0: 'safe.directory',
                    GIT_CONFIG_VALUE_0: '*',
                    ...c.env,
                    ...(c.graph && { AGENTGRAPH_DIR: inside.graph }),
                  };
                  const secrets = Object.fromEntries(
                    Object.entries(c.secrets ?? {}).map(([k, v]) => [k, Redacted.value(v)])
                  );
                  const argv = [
                    String(c.minutes),
                    c.readonly ? 'ro' : 'rw',
                    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
                    c.cmd,
                    ...c.args,
                  ];
                  const id = randomUUID();
                  let code: number | undefined;
                  let pulled = false;
                  yield* Effect.addFinalizer(() =>
                    pulled
                      ? Effect.void
                      : Effect.timeout(
                          Effect.interruptible(
                            Effect.retry(sync.withPermits(1)(Effect.andThen(box.op('stop', [id]), pullBack(home))), {
                              times: 2,
                            })
                          ),
                          '5 minutes'
                        ).pipe(Effect.catchCause(() => Effect.sync(() => unfinished.set(id, home))))
                  );
                  const ended = Effect.gen(function* () {
                    if (code === undefined) return yield* infra('the box stream ended without an exit code');
                    yield* sync.withPermits(1)(pullBack(home));
                    pulled = true;
                    return { code };
                  });
                  return box.run(argv, secrets, c.network, id).pipe(
                    Stream.filter((piece): piece is string => {
                      code = typeof piece === 'string' ? undefined : piece.code;
                      return code === undefined;
                    }),
                    Stream.concat(Stream.fromEffect(ended)),
                    Stream.interruptWhen(Effect.andThen(Effect.sleep(Duration.minutes(c.minutes)), Effect.fail(late())))
                  );
                })
              );

            const provision = provisioning.withPermits(1)(
              Effect.gen(function* () {
                if (ready || !toolchain) return;
                const out = yield* Effect.scoped(
                  Stream.runFold(
                    lines(toolchain),
                    () => ({ code: 0, output: '' }),
                    (exit, piece) =>
                      typeof piece === 'string'
                        ? { ...exit, output: (exit.output + piece + '\n').slice(-2000) }
                        : { ...exit, ...piece }
                  )
                );
                if (out.code !== 0) return yield* infra(`toolchain exited ${out.code}: ${out.output.trim()}`);
                ready = true;
              })
            );

            if (work.git.GIT_INDEX_FILE && existsSync(work.git.GIT_INDEX_FILE))
              copyFileSync(work.git.GIT_INDEX_FILE, syncIndex);
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Effect.ignore(Effect.timeout(Effect.interruptible(sync.withPermits(1)(recover)), '5 minutes'));
                rmSync(syncIndex, { force: true });
                if (unfinished.size > 0)
                  return yield* Effect.logWarning(
                    `kept the box of ${basename(work.dir)}: its last work did not come back`
                  );
                yield* Effect.ignore(Effect.timeout(Effect.interruptible(Scope.close(scope, Exit.void)), '1 minute'));
              })
            );
            if (graph && !graph.readonly && work.base) {
              const files = yield* hostGit(work.git, ['ls-tree', '--name-only', work.head ?? work.base]);
              const steps = [
                ...makeToolchainSetupCommands(files.toString('utf8').split('\n')),
                ...(graph.toolchain ? [graph.toolchain] : []),
              ];
              if (steps.length > 0) {
                toolchain = {
                  cmd: 'sh',
                  args: ['-ec', steps.join('\n')],
                  dir: work.dir,
                  env: {},
                  network: 'open',
                  minutes: 30,
                };
                yield* provision;
              }
            }
            return { lines };
          }),
      };
    })
  );

const call = (url: string, init: RequestInit, seen: (fresh: boolean) => void) =>
  Effect.tryPromise({
    try: async signal => {
      const response = await fetch(url, { signal, ...init });
      seen(response.headers.has(freshHeader));
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).trim().slice(-2000)}`);
      return response;
    },
    catch: e => infra(`box ${init.method ?? 'GET'} ${url}: ${(e as Error).message}`),
  });

export const boxRunner = (o: { url: string; data: string }): Layer.Layer<Runner> =>
  makeBoxRunner(o.data, (work, graph) =>
    Effect.gen(function* () {
      const url = `${o.url}/${basename(work.dir)}`;
      let restarted = false;
      const seen = (fresh: boolean) => void (restarted ||= fresh);
      yield* Effect.addFinalizer(() => Effect.ignore(call(url, { method: 'DELETE' }, () => undefined)));
      return {
        op: (name, args, body) =>
          Effect.gen(function* () {
            const response = yield* call(
              `${url}/${name}?${new URLSearchParams(args.map(arg => ['arg', arg]))}`,
              { method: 'POST', ...(body && { body: new Uint8Array(body) }) },
              seen
            );
            if (name === 'init') {
              const fresh = restarted;
              restarted = false;
              return new TextEncoder().encode(fresh ? 'fresh' : '');
            }
            if (response.headers.has(freshHeader)) return yield* infra(`the box restarted during ${name}`);
            return yield* Effect.tryPromise({
              try: () => response.arrayBuffer().then(b => new Uint8Array(b)),
              catch: e => infra(`box ${name} ${url}: ${(e as Error).message}`),
            });
          }),
        run: (argv, secrets, network, id) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const response = yield* call(
                `${url}/run?network=${network === 'proxy' ? (graph?.network ?? 'egress') : network}&id=${id}`,
                { method: 'POST', body: JSON.stringify({ argv, secrets }) },
                seen
              );
              if (response.headers.has(freshHeader)) return yield* infra('the box restarted before the command ran');
              return Stream.fromReadableStream({
                evaluate: () => response.body!,
                onError: e => infra(`box run: ${(e as Error).message}`),
              }).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.map(line => (line.startsWith(exitFrame) ? { code: Number(line.slice(exitFrame.length)) } : line))
              );
            })
          ),
      };
    })
  );
