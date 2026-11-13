import { parseJson, readDirEntriesOrEmpty, readDirOrEmpty } from './read.ts';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { makeHostEnv, hostGit, readGit, readWorktreeAdmin } from './git.ts';
import { Effect, Schema } from 'effect';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  getCheckoutPaths,
  runDockerCli,
  envVersion,
  held,
  isLiveOverlay,
  isVolumeName,
  makeLayerVolumeName,
  makeSetupVolumeName,
  parseSetupVolumeKey,
  DockerLabels,
  parseDockerLabels,
  unlogged,
  used,
} from './env.ts';
import { isLockedByOtherProcess, readStateDir } from './owner.ts';

type Kind = 'env' | 'lower' | 'cache' | 'tree';

export type DiskCacheEntry = {
  kind: Kind;
  refs: string[];
  bytes: number;
  used: number;
  held?: string;
  always?: boolean;
  gone?: string;
};

// UNEXPECTED: powers of 1000, as docker prints sizes.
export const parseByteSize = (size: string) => {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(size.trim());
  if (!m) throw new Error(`not a size: ${size}`);
  return Number(m[1]) * 1000 ** ' kmgt'.indexOf(m[2]!.toLowerCase() || ' ');
};

const isEnvRef = (ref: unknown): ref is string =>
  typeof ref === 'string' && (/^agentgraph-env\/[a-z0-9._-]+:[a-z0-9]+$/.test(ref) || isVolumeName(ref));

export const readEnvRefs = (dir: string): string[] => {
  const file = join(dir, '.envs', 'refs.jsonl');
  const refs: unknown[] = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : [];
  if (!refs.every(isEnvRef)) throw new Error(`invalid environment refs in ${file}`);
  return [...new Set(refs)];
};

export const writeEnvRefs = (dir: string, names: string[]) => {
  const bad = names.find(name => !isEnvRef(name));
  if (bad !== undefined) throw new Error(`invalid environment ref ${bad}`);
  if (!names.length) return;
  const known = new Set(readEnvRefs(dir));
  const fresh = [...new Set(names)].filter(name => !known.has(name));
  if (!fresh.length) return;
  mkdirSync(join(dir, '.envs'), { recursive: true });
  appendFileSync(join(dir, '.envs', 'refs.jsonl'), fresh.map(name => `${JSON.stringify(name)}\n`).join(''));
};

const cap = () => parseByteSize(process.env.AGENTGRAPH_ENV_CAP || '60g');
const lines = (out: string) => out.split('\n').filter(Boolean);
const pins = () => join(readStateDir(), 'pins');

export const pin = (name: string, match: string[], days: number) => {
  mkdirSync(pins(), { recursive: true });
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  writeFileSync(join(pins(), `${name}.json`), `${JSON.stringify({ match, until })}\n`);
};

export const unpin = (name: string) => rmSync(join(pins(), `${name}.json`), { force: true });

const Pin = Schema.Struct({ match: Schema.Array(Schema.String), until: Schema.String });
const Layers = Schema.mutable(Schema.Array(Schema.String));

const unexpired = () => {
  const files = readDirOrEmpty(pins()).filter(f => f.endsWith('.json'));
  return files.flatMap(f => {
    try {
      const p = parseJson(Pin, readFileSync(join(pins(), f), 'utf8'), join(pins(), f));
      const until = Date.parse(p.until);
      if (!Number.isFinite(until)) throw new Error('pin needs a valid expiry');
      if (until <= Date.now()) return [];
      const globs = p.match.map(
        g =>
          new RegExp(
            `^${g
              .split('*')
              .map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*')}$`
          )
      );
      return [{ name: f.slice(0, -5), test: (ref: string) => globs.some(g => g.test(ref)) }];
    } catch (e) {
      throw new Error(`invalid cache pin ${f}: ${String(e)}`, { cause: e });
    }
  });
};

const skipped = new Set(['data', 'tracker', 'graph', 'engine', 'cases', 'done', 'logs', 'node_modules']);

/** @internal */
export const findBuildDirs = (root: string, depth = 5): string[] => {
  const entries = readDirEntriesOrEmpty(root);
  const here = new Set(entries.map(e => e.name));
  return entries
    .filter(e => e.isDirectory() && !skipped.has(e.name) && !e.name.startsWith('.') && !e.name.endsWith('.git'))
    .flatMap(e => {
      const at = join(root, e.name);
      if (e.name === 'tree') return here.has('case.json') ? [at] : [];
      if (e.name === 'target-shared') return existsSync(join(at, 'CACHEDIR.TAG')) ? [at] : [];
      return depth > 1 ? findBuildDirs(at, depth - 1) : [];
    });
};

const du = (path: string) =>
  new Promise<number>((done, reject) =>
    execFile('du', ['-sk', path], { env: makeHostEnv(), timeout: 600_000 }, (e, out) =>
      e ? reject(e) : done(Number(out.split('\t')[0]) * 1024)
    )
  );

export const removeBranch = (
  git: string,
  branch: string,
  base: string | undefined,
  head: string | undefined,
  data: string
) =>
  Effect.gen(function* () {
    if (!existsSync(git)) return;
    const env = { GIT_DIR: git };
    const ref = `refs/heads/${branch}`;
    if (yield* readGit(env, ['symbolic-ref', '--quiet', ref], { codes: [1] }))
      return yield* Effect.logWarning(`1 skipped cleanup ${branch}: symbolic ref`);
    const tip = yield* readGit(env, ['rev-parse', '--verify', '--quiet', ref], { codes: [1] });
    if (!tip) return;
    if (base === undefined && tip !== head)
      return yield* Effect.logWarning(`1 skipped cleanup ${branch}: no exact merged head`);
    const isLanded = (sha: string) =>
      Effect.gen(function* () {
        if (head && (yield* Effect.isSuccess(hostGit(env, ['merge-base', '--is-ancestor', sha, head])))) return true;
        return (
          base !== undefined && (yield* Effect.isSuccess(hostGit(env, ['merge-base', '--is-ancestor', sha, base])))
        );
      });
    if (!(yield* isLanded(tip))) return yield* Effect.logWarning(`1 skipped checkout cleanup ${branch}: unlanded`);
    const trees = (yield* readGit(env, ['worktree', 'list', '--porcelain', '-z']))
      .split('\0\0')
      .filter(t => t.split('\0').includes(`branch ${ref}`))
      .map(t => {
        const fields = t.split('\0');
        return { path: fields[0]!.slice('worktree '.length), sha: fields.find(f => f.startsWith('HEAD '))!.slice(5) };
      });
    const outside = yield* Effect.try(() => {
      if (!trees.length) return [];
      const root = realpathSync(getCheckoutPaths(data, '').dir);
      return trees.filter(({ path }) => {
        const at = relative(root, existsSync(path) ? realpathSync(path) : resolve(path));
        return !at || at === '..' || at.startsWith(`..${sep}`) || isAbsolute(at);
      });
    }).pipe(Effect.catch(e => Effect.as(Effect.logWarning(`1 skipped cleanup ${branch}: checkout root`, e), trees)));
    if (outside.length) {
      yield* Effect.forEach(outside, ({ path }) =>
        Effect.logWarning(`1 skipped cleanup ${path} ${branch}: outside engine checkout root`)
      );
      return;
    }
    for (const { path, sha } of trees) {
      const inspect = () =>
        Effect.try(() => {
          if (!existsSync(path)) return '';
          const file = join(path, '.git');
          if (realpathSync(path) !== path) throw new Error('unsafe checkout path');
          const admin = readWorktreeAdmin(git, path);
          if (
            realpathSync(admin) !== admin ||
            existsSync(join(admin, 'config.worktree')) ||
            resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim()) !== realpathSync(git) ||
            !lstatSync(join(admin, 'gitdir')).isFile() ||
            resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf8').trim()) !== file
          )
            throw new Error('redirected checkout metadata');
          return admin;
        }).pipe(
          Effect.catch(e => Effect.as(Effect.logWarning(`1 skipped cleanup ${path} ${branch}: metadata`, e), undefined))
        );
      const admin = yield* inspect();
      if (admin === undefined) return;
      if (!admin) {
        yield* Effect.logWarning(`1 skipped checkout ${path}: missing`);
        continue;
      }
      const trusted = {
        GIT_DIR: admin,
        GIT_COMMON_DIR: resolve(git),
        GIT_WORK_TREE: path,
        GIT_INDEX_FILE: join(admin, 'index'),
      };
      const files = (yield* readGit(trusted, ['ls-files', '--stage', '-v', '-z'])).split('\0');
      if (files.some(f => /^[a-zS]/.test(f)))
        return yield* Effect.logWarning(`1 skipped checkout ${path}: hidden index flags`);
      if (files.some(f => f.slice(2).startsWith('160000 ')))
        return yield* Effect.logWarning(`1 skipped checkout ${path}: submodules`);
      const args = (yield* readGit(
        trusted,
        ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'],
        { codes: [1] }
      ))
        .split('\0')
        .filter(Boolean)
        .flatMap(key => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
      args.push('-c', 'extensions.worktreeConfig=false');
      const dirty = (yield* readGit(trusted, [...args, 'status', '--porcelain', '-uall', '-z', '--no-renames']))
        .split('\0')
        .filter(Boolean);
      const links = yield* Effect.try(() =>
        dirty.filter(
          f =>
            f.startsWith('?? ') &&
            basename(f.slice(3)) === 'node_modules' &&
            lstatSync(join(path, f.slice(3))).isSymbolicLink()
        )
      ).pipe(Effect.orElseSucceed(() => []));
      if (dirty.length !== links.length || !(yield* isLanded(sha)))
        return yield* Effect.logWarning(`1 skipped cleanup ${path} ${branch}: dirty or unlanded`);
      if ((yield* inspect()) !== admin) return yield* Effect.logWarning(`1 skipped removal ${path}: metadata changed`);
      const removed = yield* Effect.try(() => {
        for (const link of links) {
          const file = join(path, link.slice(3));
          if (!lstatSync(file).isSymbolicLink()) throw new Error('dependency symlink changed');
          unlinkSync(file);
        }
      }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const now = yield* readGit(trusted, ['rev-parse', '--verify', 'HEAD']);
            const named = yield* readGit(trusted, ['symbolic-ref', '--quiet', 'HEAD'], { codes: [1] });
            if (now !== sha || named !== ref)
              return yield* Effect.as(Effect.logWarning(`1 skipped removal ${path}: HEAD changed`), false);
            yield* hostGit(trusted, [...args, 'worktree', 'remove', path]);
            return true;
          })
        ),
        Effect.catch(e => Effect.as(Effect.logWarning(`1 skipped removal ${path} ${branch}`, e), false))
      );
      if (!removed) return;
      yield* Effect.logInfo(`removed checkout ${path} branch ${branch}`);
    }
    yield* hostGit(env, ['worktree', 'prune']);
    yield* hostGit(env, ['update-ref', '--no-deref', '-d', ref, tip]);
    yield* Effect.logInfo(`removed local branch ${branch}`);
  });

const usage = async () => {
  const df = parseJson(
    Schema.Struct({
      Images: Schema.optionalKey(Schema.Array(Schema.Struct({ ID: Schema.String, UniqueSize: Schema.String }))),
      Volumes: Schema.optionalKey(Schema.Array(Schema.Struct({ Name: Schema.String, Size: Schema.String }))),
    }),
    await runDockerCli(['system', 'df', '-v', '--format', 'json']),
    'docker system df'
  );
  return {
    images: new Map((df.Images ?? []).map(i => [i.ID, parseByteSize(i.UniqueSize)])),
    volumes: new Map((df.Volumes ?? []).map(v => [v.Name, v.Size.startsWith('-') ? 0 : parseByteSize(v.Size)])),
  };
};

const isData = (labels: Record<string, string>) => Object.keys(labels).some(k => k.startsWith('com.docker.compose.'));

export const inventory = async (
  o: { roots?: string[]; measure?: boolean } & Pick<Disk, 'eligible' | 'image'> = {}
): Promise<DiskCacheEntry[]> => {
  const df = await usage();
  const tagsById = new Map<string, string[]>();
  const others = new Set<string>();
  for (const l of lines(
    await runDockerCli(['image', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}'])
  )) {
    const [id = '', tag = ''] = l.split(' ');
    if (tag.startsWith('agentgraph-env/')) tagsById.set(id, [...(tagsById.get(id) ?? []), tag]);
    else if (!tag.includes('<none>')) others.add(id);
  }
  const bases = others.size
    ? lines(await runDockerCli(['image', 'inspect', '--format', '{{json .RootFS.Layers}}', ...others])).map(l =>
        parseJson(Layers, l, 'docker image inspect')
      )
    : [];
  const gone = (labels: Record<string, string>, layers: string[]) =>
    labels['agentgraph.version'] && labels['agentgraph.version'] !== String(envVersion)
      ? 'old version'
      : bases.length && !bases.some(b => b.length === layers.length - 1 && b.every((x, i) => x === layers[i]))
        ? 'base replaced'
        : undefined;
  const containers = lines(await runDockerCli(['ps', '-a', '--no-trunc', '--format', '{{.Image}}|{{.Mounts}}'])).map(
    l => l.split('|')
  );
  const runImages = new Set(containers.map(([image]) => image));
  const mounted = new Set(containers.flatMap(([, mounts = '']) => mounts.split(',')));
  const vols = lines(await runDockerCli(['volume', 'ls', '--format', '{{.Name}}\t{{.Labels}}']))
    .map(l => {
      const [name = '', labels] = l.split('\t');
      return { name, labels: parseDockerLabels(labels) };
    })
    .filter(v => !isData(v.labels));
  const overlaid = (key: string) => vols.some(v => isLiveOverlay(v.labels, key));
  const listEnvVolumes = (key: string) => [makeSetupVolumeName(key), makeLayerVolumeName(key)];
  const readUsedMs = (name: string) => {
    const stamp = join(used(), name);
    return existsSync(stamp) ? statSync(stamp).mtimeMs : undefined;
  };
  const whyHeld = (name: string, key: string) =>
    held(key) ? 'recent use' : mounted.has(name) ? 'container' : overlaid(key) ? 'live checkout' : undefined;
  const names = new Set(
    vols.filter(v => listEnvVolumes(v.labels['agentgraph.lower'] ?? '').includes(v.name)).map(v => v.name)
  );
  const items: DiskCacheEntry[] = [];
  const keys = new Set<string>();
  const needed = new Set<string>();
  let excluded = 0;
  const inspected = tagsById.size
    ? lines(
        await runDockerCli([
          'image',
          'inspect',
          '--format',
          '{{.Id}} {{.Created}} {{json .RootFS.Layers}} {{json .Config.Labels}}',
          ...tagsById.keys(),
        ])
      )
    : [];
  for (const l of inspected) {
    const [id = '', created = '', layers = '[]', ...rest] = l.split(' ');
    const labels = parseJson(DockerLabels, rest.join(' ') || 'null', `image ${id} labels`) ?? {};
    const key = labels['agentgraph.env'];
    const allTags = tagsById.get(id) ?? [];
    const tags =
      o.eligible === undefined ? allTags : allTags.filter(t => o.eligible!.includes(t) && t.endsWith(`:${key}`));
    if (!key || isData(labels)) continue;
    keys.add(key);
    if (labels['agentgraph.cache']) needed.add(labels['agentgraph.cache']);
    if (!tags.length) {
      excluded += allTags.length;
      continue;
    }
    const why = gone(labels, parseJson(Layers, layers, `image ${id} layers`));
    const unique = df.images.get(id) ?? 0;
    items.push({
      kind: 'env',
      refs: [...tags, ...listEnvVolumes(key).filter(v => names.has(v))],
      bytes:
        unique + (Number(labels['agentgraph.lowerkb']) || 0) * 1024 + (df.volumes.get(makeLayerVolumeName(key)) ?? 0),
      used: readUsedMs(key) ?? (Date.parse(created) || 0),
      ...(why && { always: true, gone: why }),
      ...(tags.length !== allTags.length && { held: 'retained image tag' }),
      ...((tags.some(t => runImages.has(t)) || runImages.has(id)) && { held: 'container' }),
      ...(mounted.has(makeSetupVolumeName(key)) && { held: 'container' }),
      ...(overlaid(key) && { held: 'live checkout' }),
      ...(held(key) && { held: 'recent use' }),
      ...(o.image !== undefined && (id === o.image || allTags.includes(o.image)) && { held: 'current run' }),
    });
  }
  const measured = o.measure ? df.volumes : new Map<string, number>();
  for (const v of vols) {
    const key = v.labels['agentgraph.lower'] ?? '';
    if (!names.has(v.name) || keys.has(key)) continue;
    if (o.eligible !== undefined && !o.eligible.some(t => t.startsWith('agentgraph-env/') && t.endsWith(`:${key}`)))
      continue;
    const why = whyHeld(v.name, key);
    items.push({
      kind: 'lower',
      refs: [v.name],
      bytes: measured.get(v.name) ?? 0,
      used: 0,
      always: true,
      ...(why && { held: why }),
    });
  }
  for (const v of vols) {
    if (v.labels['agentgraph.cache'] !== v.name || (o.eligible !== undefined && !o.eligible.includes(v.name))) continue;
    const why = whyHeld(v.name, v.name) ?? (needed.has(v.name) ? 'environment' : undefined);
    items.push({
      kind: 'cache',
      refs: [v.name],
      bytes: df.volumes.get(v.name) ?? 0,
      used: readUsedMs(v.name) ?? 0,
      ...(why && { held: why }),
    });
  }
  for (const path of (o.roots ?? []).flatMap(root => findBuildDirs(root))) {
    const score = basename(path) === 'tree';
    items.push({
      kind: 'tree',
      refs: [path],
      bytes: await du(path),
      used: statSync(path).mtimeMs,
      ...(score && { always: true }),
      ...(isLockedByOtherProcess(path) && { held: 'busy' }),
    });
  }
  if (excluded) console.error(`${excluded} skipped environment tags: outside cleanup scope`);
  const active = unexpired();
  return items.map(i => {
    const p = !i.held && active.find(p => i.refs.some(p.test));
    return p ? { ...i, held: `pin ${p.name}` } : i;
  });
};

/** @internal */
export const pickCacheRemovals = (items: DiskCacheEntry[], o: { limit: number; free: number; floor: number }) => {
  const open = items.filter(i => !i.held);
  const chosen = open.filter(i => i.always);
  let total = items.filter(i => !i.always).reduce((n, i) => n + i.bytes, 0);
  let free = o.free + chosen.reduce((n, i) => n + i.bytes, 0);
  const rest = open.filter(i => !i.always).sort((a, b) => a.used - b.used);
  for (const i of rest) {
    if (total <= o.limit && free >= o.floor) break;
    chosen.push(i);
    total -= i.bytes;
    free += i.bytes;
  }
  return chosen;
};

const remove = async (i: DiskCacheEntry) => {
  if (i.kind === 'tree')
    return !isLockedByOtherProcess(i.refs[0]!) && (rmSync(i.refs[0]!, { recursive: true, force: true }), true);
  const ok = (args: string[]) =>
    runDockerCli(args).then(
      () => true,
      e => {
        console.error(`1 skipped cache removal (${args.join(' ')}): ${String(e)}`);
        return false;
      }
    );
  if (i.kind === 'cache') return ok(['volume', 'rm', i.refs[0]!]);
  const tags = i.refs.filter(r => r.includes(':'));
  if (tags.length && !(await ok(['rmi', ...tags]))) return false;
  for (const v of i.refs.filter(r => !r.includes(':'))) {
    const key = parseSetupVolumeKey(v);
    const retained = await runDockerCli([
      'image',
      'ls',
      '--filter',
      `label=agentgraph.env=${key}`,
      '--format',
      '{{.Repository}}:{{.Tag}}',
    ]);
    if (retained.trim()) {
      console.error(`1 skipped cache removal (${v}): retained environment`);
      continue;
    }
    if (!(await ok(['volume', 'rm', v]))) return false;
  }
  return true;
};

export const collect = async (
  o: { limit?: number; dry?: boolean; free?: number; floor?: number } & NonNullable<
    Parameters<typeof inventory>[0]
  > = {}
) => {
  const items = await inventory(o);
  const removed: DiskCacheEntry[] = [];
  const held = items.filter(i => i.held);
  if (o.eligible !== undefined && held.length)
    console.error(`${held.length} skipped cache removals: ${held.map(i => i.held).join(', ')}`);
  for (const i of pickCacheRemovals(items, { limit: o.limit ?? cap(), free: o.free ?? Infinity, floor: o.floor ?? 0 }))
    if (o.dry || (await remove(i))) removed.push(i);
  return { removed, items };
};

export type Disk = { dir: string; image?: string; eligible?: string[] };

const inDocker = new Map<string, { at: number; free: Promise<number> }>();

const dockerFree = (image: string) => {
  const hit = inDocker.get(image);
  if (hit && Date.now() - hit.at < 60_000) return hit.free;
  const free = runDockerCli(
    [
      'run',
      ...unlogged,
      '--rm',
      '--name',
      `agentgraph-disk-${randomBytes(6).toString('hex')}`,
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--cap-drop=ALL',
      image,
      'df',
      '-Pk',
      '/',
    ],
    60_000
  ).then(out => {
    const free = Number(out.trim().split('\n').at(-1)?.trim().split(/\s+/)[3]) * 1024;
    if (!Number.isFinite(free) || free < 0) throw new Error('docker df did not report free bytes');
    return free;
  });
  inDocker.set(image, { at: Date.now(), free });
  return free;
};

const getFreeBytes = async ({ dir, image }: Disk) => {
  const s = statfsSync(dir);
  return Math.min(s.bavail * s.bsize, image ? await dockerFree(image) : Infinity);
};

const gb = (b: number) => (b / 1e9).toFixed(1);

const formatNoRoomReason = (free: number, floor: number, kept: DiskCacheEntry[]) => {
  const by = new Map<string, number>();
  for (const i of kept) by.set(i.held!, (by.get(i.held!) ?? 0) + i.bytes);
  const pinned = [...by.keys()].filter(r => r.startsWith('pin ')).map(r => r.slice(4));
  return [
    `disk low: ${gb(free)} GB free, under the AGENTGRAPH_MIN_FREE_GB floor of ${floor} GB (0 turns the check off, AGENTGRAPH_DISK_LOW=block waits for room).`,
    kept.length
      ? `Held cache ${gb(kept.reduce((n, i) => n + i.bytes, 0))} GB (${[...by].map(([r, b]) => `${r} ${gb(b)} GB`).join(', ')}).`
      : 'No cache is left to collect; the rest is data.',
    `Free it: node bin/env.ts collect --dry-run${pinned.length ? `, then node bin/env.ts unpin ${pinned.join(' ')}` : ''}`,
  ].join(' ');
};

/** @internal */
export class DiskLow extends Error {
  readonly held: DiskCacheEntry[];
  constructor(free: number, floor: number, held: DiskCacheEntry[]) {
    super(formatNoRoomReason(free, floor, held));
    this.held = held;
  }
}

const readFloor = () => {
  const gb = Number(process.env.AGENTGRAPH_MIN_FREE_GB || 40);
  if (!(gb >= 0))
    throw new Error(`AGENTGRAPH_MIN_FREE_GB must be a number of GB, got ${process.env.AGENTGRAPH_MIN_FREE_GB}`);
  return gb;
};

const readBlocks = () => {
  const mode = process.env.AGENTGRAPH_DISK_LOW || 'warn';
  if (mode !== 'warn' && mode !== 'block') throw new Error(`AGENTGRAPH_DISK_LOW must be warn or block, got ${mode}`);
  return mode === 'block';
};

let warned = false;

export const ensureFreeDisk = async (disk: Disk, floor = readFloor(), block = readBlocks()) => {
  if (floor === 0 || (await getFreeBytes(disk)) >= floor * 1e9) return;
  inDocker.clear();
  const { items, removed } = await collect({
    roots: [disk.dir],
    eligible: disk.eligible ?? readEnvRefs(disk.dir),
    ...(disk.image !== undefined && { image: disk.image }),
    free: await getFreeBytes(disk),
    floor: floor * 1e9,
  });
  inDocker.clear();
  const free = await getFreeBytes(disk);
  if (free >= floor * 1e9) return;
  const low = new DiskLow(
    free,
    floor,
    items.filter(i => i.held && !removed.includes(i))
  );
  if (block) throw low;
  if (!warned) console.error(low.message);
  warned = true;
};
