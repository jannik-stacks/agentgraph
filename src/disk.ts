import { execFile } from 'node:child_process';
import { makeHostEnv } from './git.ts';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { runDockerCli, envVersion, held, makeSetupVolumeName, removeOrphanedVolumes, unlogged, used } from './env.ts';
import { isLockedByOtherProcess, isOwnerRunning, readStateDir } from './owner.ts';

/** What a cache item is: a sandbox setup image with its dependency volume, a dependency volume no image uses, or a host build dir. */
type Kind = 'env' | 'lower' | 'tree';

/**
 * One deletable cache thing. `refs` are what removing it names: image tags, volume names or one host path. `bytes` are
 * what removing it frees, `used` its last use in ms, `held` why it must stay now, `always` that it goes whatever the
 * cap, and `gone` why a sandbox setup can never be reused.
 */
export type DiskCacheEntry = {
  kind: Kind;
  refs: string[];
  bytes: number;
  used: number;
  held?: string;
  always?: boolean;
  gone?: string;
};

/** Bytes of a size like `60g`, `1.2GB` or `512MB`, in powers of 1000 as docker prints them. */
export const parseByteSize = (size: string) => {
  const m = /^([\d.]+)\s*([kmgt]?)b?$/i.exec(size.trim());
  if (!m) throw new Error(`not a size: ${size}`);
  return Number(m[1]) * 1000 ** ' kmgt'.indexOf(m[2]!.toLowerCase() || ' ');
};

const cap = () => parseByteSize(process.env.AGENTGRAPH_ENV_CAP || '60g');
const lines = (out: string) => out.split('\n').filter(Boolean);
const ask = (args: string[], timeout?: number) => runDockerCli(args, timeout).catch(() => '');
const pins = () => join(readStateDir(), 'pins');

/** Holds every cache item one of the `match` globs names, for `days`. */
export const pin = (name: string, match: string[], days: number) => {
  mkdirSync(pins(), { recursive: true });
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  writeFileSync(join(pins(), `${name}.json`), `${JSON.stringify({ match, until })}\n`);
};

export const unpin = (name: string) => rmSync(join(pins(), `${name}.json`), { force: true });

const unexpired = () => {
  let files: string[] = [];
  try {
    files = readdirSync(pins()).filter(f => f.endsWith('.json'));
  } catch {}
  return files.flatMap(f => {
    try {
      const p = JSON.parse(readFileSync(join(pins(), f), 'utf8')) as { match: string[]; until: string };
      if (!(Date.parse(p.until) > Date.now())) return [];
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
    } catch {
      return [];
    }
  });
};

const skipped = new Set(['data', 'forge', 'hub', 'engine', 'cases', 'done', 'logs', 'node_modules']);

/**
 * Score trees beside a `case.json` and `target-shared` dirs holding `CACHEDIR.TAG`, at most `depth` levels under
 * `root`. Records, run data, hidden dirs (attic, result cache, git) and a bench's engine, cases and logs are never
 * entered.
 */
export const findBuildDirs = (root: string, depth = 5): string[] => {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
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
  new Promise<number>(done =>
    execFile('du', ['-sk', path], { env: makeHostEnv(), timeout: 600_000 }, (e, out) =>
      done(e ? 0 : Number(out.split('\t')[0]) * 1024)
    )
  );

/** Unique bytes of each image by id and bytes of each volume by name, as `docker system df` counts them. */
const usage = async () => {
  const size = (s = '') => {
    try {
      return parseByteSize(s);
    } catch {
      return 0;
    }
  };
  let df: { Images?: { ID: string; UniqueSize: string }[]; Volumes?: { Name: string; Size: string }[] } = {};
  try {
    df = JSON.parse((await ask(['system', 'df', '-v', '--format', 'json'])) || '{}');
  } catch {}
  return {
    images: new Map((df.Images ?? []).map(i => [i.ID, size(i.UniqueSize)])),
    volumes: new Map((df.Volumes ?? []).map(v => [v.Name, size(v.Size)])),
  };
};

const isData = (labels: Record<string, string>) => Object.keys(labels).some(k => k.startsWith('com.docker.compose.'));
const labelsOf = (text = '') =>
  Object.fromEntries(
    text
      .split(',')
      .filter(Boolean)
      .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
  ) as Record<string, string>;

/**
 * Every cache item agentgraph left in docker, and the host build dirs under `roots`. Only our names count; compose
 * objects are data and never appear. Volumes without a recorded size count 0 bytes unless `measure`.
 */
export const inventory = async (o: { roots?: string[]; measure?: boolean } = {}): Promise<DiskCacheEntry[]> => {
  const df = usage();
  const tagsOf = new Map<string, string[]>();
  const others = new Set<string>();
  for (const l of lines(await ask(['image', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']))) {
    const [id = '', tag = ''] = l.split(' ');
    if (tag.startsWith('agentgraph-env/')) tagsOf.set(id, [...(tagsOf.get(id) ?? []), tag]);
    else if (!tag.includes('<none>')) others.add(id);
  }
  const bases = others.size
    ? lines(await ask(['image', 'inspect', '--format', '{{json .RootFS.Layers}}', ...others])).map(
        l => JSON.parse(l) as string[]
      )
    : [];
  const gone = (labels: Record<string, string>, layers: string[]) =>
    labels['agentgraph.version'] && labels['agentgraph.version'] !== String(envVersion)
      ? 'old version'
      : bases.length && !bases.some(b => b.length === layers.length - 1 && b.every((x, i) => x === layers[i]))
        ? 'base replaced'
        : undefined;
  const containers = lines(await ask(['ps', '-a', '--no-trunc', '--format', '{{.Image}}|{{.Mounts}}'])).map(l =>
    l.split('|')
  );
  const runImages = new Set(containers.map(([image]) => image));
  const mounted = new Set(containers.flatMap(([, mounts = '']) => mounts.split(',')));
  const vols = lines(await ask(['volume', 'ls', '--format', '{{.Name}}\t{{.Labels}}']))
    .map(l => {
      const [name = '', labels] = l.split('\t');
      return { name, labels: labelsOf(labels) };
    })
    .filter(v => !isData(v.labels));
  const overlaid = (key: string) =>
    vols.some(
      v =>
        v.labels['agentgraph.lower'] === key &&
        v.labels['agentgraph.layer'] &&
        isOwnerRunning(v.labels['agentgraph.layer'])
    );
  const names = new Set(vols.map(v => v.name));
  const items: DiskCacheEntry[] = [];
  const keys = new Set<string>();
  const inspected = tagsOf.size
    ? lines(
        await ask([
          'image',
          'inspect',
          '--format',
          '{{.Id}} {{.Created}} {{json .RootFS.Layers}} {{json .Config.Labels}}',
          ...tagsOf.keys(),
        ])
      )
    : [];
  for (const l of inspected) {
    const [id = '', created = '', layers = '[]', ...rest] = l.split(' ');
    const labels = (JSON.parse(rest.join(' ') || 'null') ?? {}) as Record<string, string>;
    const key = labels['agentgraph.env'];
    const tags = tagsOf.get(id) ?? [];
    if (!key || !tags.length || isData(labels)) continue;
    const why = gone(labels, JSON.parse(layers) as string[]);
    const unique = (await df).images.get(id) ?? 0;
    const lastUsedMs = existsSync(join(used(), key)) ? statSync(join(used(), key)).mtimeMs : Date.parse(created) || 0;
    keys.add(key);
    items.push({
      kind: 'env',
      refs: [...tags, ...(names.has(makeSetupVolumeName(key)) ? [makeSetupVolumeName(key)] : [])],
      bytes: unique + (Number(labels['agentgraph.lowerkb']) || 0) * 1024,
      used: lastUsedMs,
      ...(why && { always: true, gone: why }),
      ...((tags.some(t => runImages.has(t)) || runImages.has(id)) && { held: 'container' }),
      ...(overlaid(key) && { held: 'live checkout' }),
      ...(held(key, false) && { held: 'recent use' }),
    });
  }
  const measured = o.measure ? (await df).volumes : new Map<string, number>();
  for (const v of vols) {
    const key = v.name.slice('agentgraph-lower-'.length);
    if (v.name !== makeSetupVolumeName(key) || keys.has(key)) continue;
    items.push({
      kind: 'lower',
      refs: [v.name],
      bytes: measured.get(v.name) ?? 0,
      used: 0,
      always: true,
      ...(mounted.has(v.name) ? { held: 'container' } : overlaid(key) && { held: 'live checkout' }),
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
  const active = unexpired();
  return items.map(i => {
    const p = !i.held && active.find(p => i.refs.some(p.test));
    return p ? { ...i, held: `pin ${p.name}` } : i;
  });
};

/**
 * Which items to remove: every unheld `always` item, then unheld items oldest first, while the counted cache is over
 * `limit` or free space is under `floor`.
 * @internal
 */
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
      () => false
    );
  const tags = i.refs.filter(r => r.includes(':'));
  if (tags.length && !(await ok(['rmi', ...tags]))) return false;
  for (const v of i.refs.filter(r => !r.includes(':'))) if (!(await ok(['volume', 'rm', v]))) return false;
  return true;
};

/**
 * Removes what `plan` picks, past `limit` bytes of counted cache (`AGENTGRAPH_ENV_CAP`, 60g) and below `floor` free
 * bytes. Docker refuses anything a container still uses, and that item stays. `dry` removes nothing.
 */
export const collect = async (
  o: { limit?: number; dry?: boolean; roots?: string[]; measure?: boolean; free?: number; floor?: number } = {}
) => {
  const items = await inventory(o);
  const removed: DiskCacheEntry[] = [];
  for (const i of pickCacheRemovals(items, { limit: o.limit ?? cap(), free: o.free ?? Infinity, floor: o.floor ?? 0 }))
    if (o.dry || (await remove(i))) removed.push(i);
  return { removed, items };
};

/** Where room() measures: the data dir on this host, and through `volume` and `image`, the disk docker writes to. */
export type Disk = { dir: string; image?: string; volume?: string };

const inDocker = new Map<string, { at: number; free: Promise<number> }>();

/** Free bytes of the docker disk holding `volume`, measured at most once a minute. */
const dockerFree = (image: string, volume: string) => {
  const key = `${image} ${volume}`;
  const hit = inDocker.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.free;
  const free = runDockerCli(
    [
      'run',
      ...unlogged,
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--cap-drop=ALL',
      '--mount',
      `type=volume,src=${volume},dst=/disk,readonly`,
      image,
      'df',
      '-Pk',
      '/disk',
    ],
    60_000
  ).then(
    out => Number(out.split('\n').at(-1)?.trim().split(/\s+/)[3] ?? NaN) * 1024 || Infinity,
    () => Infinity
  );
  inDocker.set(key, { at: Date.now(), free });
  return free;
};

/** Free bytes where `disk` writes, the smaller of the host dir and the docker disk. */
const freeOf = async ({ dir, image, volume }: Disk) => {
  let host = Infinity;
  try {
    const s = statfsSync(dir);
    host = s.bavail * s.bsize;
  } catch {}
  return Math.min(host, image && volume ? await dockerFree(image, volume) : Infinity);
};

const gb = (b: number) => (b / 1e9).toFixed(1);

const reasonOf = (free: number, need: number, kept: DiskCacheEntry[]) => {
  const by = new Map<string, number>();
  for (const i of kept) by.set(i.held!, (by.get(i.held!) ?? 0) + i.bytes);
  const pinned = [...by.keys()].filter(r => r.startsWith('pin ')).map(r => r.slice(4));
  return [
    `disk low: ${gb(free)} GB free, need ${need} GB.`,
    kept.length
      ? `Held cache ${gb(kept.reduce((n, i) => n + i.bytes, 0))} GB (${[...by].map(([r, b]) => `${r} ${gb(b)} GB`).join(', ')}).`
      : 'No cache is left to collect; the rest is data.',
    `Free it: node bin/env.ts collect --dry-run${pinned.length ? `, then node bin/env.ts unpin ${pinned.join(' ')}` : ''}`,
  ].join(' ');
};

/**
 * Too little free disk to start more work, with what holds the cache that is left.
 * @internal
 */
export class DiskLow extends Error {
  readonly held: DiskCacheEntry[];
  constructor(free: number, need: number, held: DiskCacheEntry[]) {
    super(reasonOf(free, need, held));
    this.held = held;
  }
}

/**
 * Makes sure `disk` has `min` GB free (`AGENTGRAPH_MIN_FREE_GB`, 40): below it, sweeps dead runners' volumes and
 * collects cache, also under `AGENTGRAPH_GC_ROOTS`, then throws `DiskLow` if that was not enough. It never stops a
 * running container.
 */
export const ensureFreeDisk = async (disk: Disk, min = Number(process.env.AGENTGRAPH_MIN_FREE_GB || 40)) => {
  if ((await freeOf(disk)) >= min * 1e9) return;
  inDocker.clear();
  await removeOrphanedVolumes(60_000);
  const roots = (process.env.AGENTGRAPH_GC_ROOTS ?? '').split(':').filter(Boolean);
  const { items, removed } = await collect({ roots, free: await freeOf(disk), floor: min * 1e9 });
  inDocker.clear();
  const free = await freeOf(disk);
  if (free < min * 1e9)
    throw new DiskLow(
      free,
      min,
      items.filter(i => i.held && !removed.includes(i))
    );
};
