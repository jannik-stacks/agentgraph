import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Effect, Layer, Semaphore, Stream } from 'effect';
import type { TrackerError } from './tracker.ts';
import { findDeadCheckouts, getCachePath, getCheckoutPaths, removeCheckout, writeCheckoutOwner } from './env.ts';
import { removeBranch } from './disk.ts';
import { commitCheckout, commitCheckoutOnce, hostGit, readGit, readBranches, readWorktreeAdmin } from './git.ts';
import { type Box, type Checkout, type Command, type Exit, inside, Runner, Sandbox, SandboxError } from './sandbox.ts';

const fetched = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', '+HEAD:refs/remotes/origin/HEAD'];
const outputLimit = 64 << 10;

const infra = (detail: string) => new SandboxError({ reason: 'infra', detail });

const auth = (token: string) => ({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
});

const mirrorLocks = new Map<string, Semaphore.Semaphore>();

export const makeSandbox = (o: {
  data: string;
  origin: string;
  local?: boolean;
  token?: Effect.Effect<string, TrackerError>;
}): Layer.Layer<Sandbox, never, Runner> =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const runner = yield* Runner;
      const mirror = o.local ? o.origin : join(o.data, 'mirror.git');
      let configured = false;
      const lock = mirrorLocks.get(mirror) ?? mirrorLocks.set(mirror, Semaphore.makeUnsafe(1)).get(mirror)!;
      const boxes = new Map<string, Box>();
      const inMirror = (args: string[], env: Record<string, string> = {}) => readGit({ GIT_DIR: mirror, ...env }, args);

      const fetch = lock.withPermits(1)(
        Effect.gen(function* () {
          if (o.local) {
            if (configured) return;
            for (const [key, value] of Object.entries({
              'remote.origin.url': mirror,
              'remote.origin.pushurl': mirror,
              'receive.autogc': 'false',
              'receive.denyCurrentBranch': 'ignore',
              'gc.auto': '0',
            }))
              if ((yield* inMirror(['config', '--get-all', key]).pipe(Effect.orElseSucceed(() => ''))) !== value)
                yield* inMirror(['config', '--replace-all', key, value]);
            configured = true;
            return;
          }
          const exists = yield* Effect.promise(() =>
            readFile(join(mirror, 'HEAD')).then(
              () => true,
              () => false
            )
          );
          const env = o.token ? auth(yield* Effect.mapError(o.token, e => infra(e.message))) : {};
          if (!exists) {
            yield* Effect.promise(() => mkdir(dirname(mirror), { recursive: true }));
            const part = `${mirror}.${randomBytes(4).toString('hex')}`;
            yield* Effect.asVoid(hostGit({}, ['init', '--bare', '-q', part]));
            yield* Effect.asVoid(hostGit({ GIT_DIR: part }, ['config', 'remote.origin.url', o.origin]));
            yield* Effect.promise(() => rename(part, mirror).catch(() => rm(part, { recursive: true, force: true })));
          }
          yield* inMirror(['fetch', '--prune', '--update-head-ok', 'origin', ...fetched], env);
        })
      );
      const verify = (name: string) =>
        inMirror([
          'rev-parse',
          '--verify',
          '--quiet',
          `${o.local && name === 'origin/HEAD' ? 'HEAD' : name}^{commit}`,
        ]).pipe(Effect.orElseSucceed(() => ''));
      const verifyBranch = (ref: string) =>
        Effect.gen(function* () {
          return (yield* verify(ref)) || (yield* verify(`refs/heads/${ref}`));
        });
      const readHead = (ref: string) =>
        Effect.gen(function* () {
          yield* fetch;
          return (yield* verifyBranch(ref)) || (yield* infra(`no commit for ${ref}`));
        });

      const checkoutGit = ({ dir, index }: ReturnType<typeof getCheckoutPaths>) => ({
        GIT_DIR: mirror,
        GIT_WORK_TREE: dir,
        GIT_INDEX_FILE: index,
      });
      const dead = findDeadCheckouts(o.data);
      if (dead.length > 0) mkdirSync(getCachePath(o.data, 'index'), { recursive: true });
      for (const id of dead) {
        const paths = getCheckoutPaths(o.data, id);
        yield* commitCheckoutOnce(checkoutGit(paths), `refs/agentgraph/reaped/${id}`, []).pipe(
          Effect.andThen(Effect.promise(() => removeCheckout(o.data, id))),
          Effect.catch(e =>
            existsSync(paths.dir) ? Effect.logWarning(`kept unsaved checkout ${paths.dir}: ${e.detail}`) : Effect.void
          )
        );
      }

      const open = (work: Checkout, graph: Parameters<Sandbox['Service']['checkout']>[3]) =>
        Effect.gen(function* () {
          const { lines, tools, ...found } = yield* runner.open(work, graph);
          yield* Effect.acquireRelease(
            Effect.sync(() => boxes.set(work.dir, { lines, ...(tools && { tools }) })),
            () => Effect.sync(() => boxes.delete(work.dir))
          );
          return Object.assign(work, found);
        });

      const empty = (graph: Parameters<Sandbox['Service']['checkout']>[3]) =>
        Effect.gen(function* () {
          const id = randomBytes(6).toString('hex');
          const { dir, news, scratch } = getCheckoutPaths(o.data, id);
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                writeCheckoutOwner(dir);
                await Promise.all([dir, news, scratch].map(p => mkdir(p, { recursive: true })));
              },
              catch: e => infra((e as Error).message),
            }).pipe(Effect.onError(() => Effect.promise(() => removeCheckout(o.data, id)))),
            () => Effect.promise(() => removeCheckout(o.data, id))
          );
          return yield* open(
            { dir, base: '', git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir }, news: join(news, 'news.md') },
            graph
          );
        });

      const checkout = (
        ref: string | undefined,
        branch?: string,
        keep?: string,
        graph?: Parameters<Sandbox['Service']['checkout']>[3]
      ) =>
        Effect.gen(function* () {
          if (ref === undefined) return yield* empty(graph);
          yield* fetch;
          const saved = keep ? yield* verify(keep) : '';
          const own = branch ? yield* verify(`refs/heads/${branch}`) : '';
          const onto = yield* verifyBranch(ref);
          const rev = own || (saved ? yield* verify(`${saved}^`) : onto);
          if (!rev) return yield* infra(`no commit for ${ref}`);
          const base = onto ? yield* inMirror(['merge-base', rev, onto]) : rev;
          const id = randomBytes(6).toString('hex');
          const paths = getCheckoutPaths(o.data, id);
          const { dir, index, news, scratch } = paths;
          const work: Checkout = {
            dir,
            base,
            ...(base !== rev && { head: rev }),
            ...(saved && { saved }),
            git: checkoutGit(paths),
            news: join(news, 'news.md'),
          };
          const save = (name: string) =>
            commitCheckout(
              work,
              name,
              saved,
              [rev, saved, work.published],
              name + (work.published ? `\n\nbaseline ${work.published}` : '')
            ).pipe(
              Effect.tapError(() => Effect.promise(() => rename(`${dir}.owner`, `${dir}.failed`))),
              Effect.mapError(
                e => new Error(`${e.detail}; unsaved checkout preserved at ${dir}, index ${index}`, { cause: e })
              ),
              Effect.orDie
            );
          let admin = '';
          const add = Effect.gen(function* () {
            yield* Effect.try({ try: () => writeCheckoutOwner(dir), catch: e => infra((e as Error).message) });
            yield* lock.withPermits(1)(inMirror(['worktree', 'add', '--detach', dir, rev]));
            admin = yield* Effect.try({
              try: () => {
                const found = readWorktreeAdmin(mirror, dir);
                if (basename(found) !== basename(dir))
                  throw new Error(`worktree admin dir ${found} does not name ${dir}`);
                return found;
              },
              catch: e => infra((e as Error).message),
            });
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(dirname(index), { recursive: true });
                await mkdir(news, { recursive: true });
                await mkdir(scratch, { recursive: true });
                await copyFile(join(admin, 'index'), index);
              },
              catch: e => infra((e as Error).message),
            });
            if (saved) yield* hostGit(work.git, ['read-tree', '-u', '--reset', saved]);
          });
          const remove = Effect.promise(() =>
            Promise.all([removeCheckout(o.data, id), admin && rm(admin, { recursive: true, force: true })])
          );
          yield* Effect.acquireRelease(add.pipe(Effect.onError(() => remove)), () =>
            Effect.andThen(keep ? save(keep) : Effect.void, remove)
          );
          return yield* open(work, graph);
        });

      const find = (dir: string) =>
        Effect.suspend(() => Effect.fromNullishOr(boxes.get(dir))).pipe(
          Effect.mapError(() => infra(`${dir} is not a checkout of this sandbox`))
        );

      const lines = (c: Command) => Stream.unwrap(Effect.map(find(c.dir), box => box.lines(c)));

      return {
        readBranches: () =>
          readBranches(mirror, o.local ? undefined : '%(if)%(worktreepath)%(then)%(refname:strip=2)%(end)'),
        readHead,
        removeBranch: (branch, base, head) =>
          lock.withPermits(1)(
            removeBranch(mirror, branch, o.local && base === 'origin/HEAD' ? 'HEAD' : base, head, o.data)
          ),
        checkout,
        lines,
        scratch: inside.scratch,
        tools: dir =>
          Effect.flatMap(find(dir), box => box.tools?.(dir) ?? infra('this runner cannot serve host tools')),
        exec: c =>
          Effect.scoped(
            Stream.runFold(
              lines(c),
              (): Exit => ({ code: 0, output: '' }),
              (exit, piece) =>
                typeof piece === 'string'
                  ? { ...exit, output: (exit.output + piece + '\n').slice(-outputLimit) }
                  : { ...exit, ...piece }
            )
          ),
      };
    })
  );
