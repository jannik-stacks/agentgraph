import { execFile } from 'node:child_process';
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
import { alive, docker, held, live, lowerOf, state, sweep, unlogged, used } from './env.ts';

/**
 * What a cache item is: an Env image with its dependency volume, a dependency volume no image uses, an object the old
 * engine left, or a host build dir.
 */
type Kind = 'env' | 'lower' | 'legacy' | 'tree';

/**
 * One deletable cache thing. `refs` are what removing it names: image tags, volume names or one host path. `bytes` are
 * what removing it frees, `used` its last use in ms, `held` why it must stay now, and `always` that it goes whatever
 * the cap.
 */
export type Item = { kind: Kind; refs: string[]; bytes: number; used: number; held?: string; always?: boolean };

/** Bytes of a size like `60g`, `1.2GB` or `512MB`, in powers of 1000 as docker prints them. */
export const bytes = (size: string) => {
  const m = /^([\d.]+)\s*([kmgt]?)b?$/i.exec(size.trim());
  if (!m) throw new Error(`not a size: ${size}`);
  return Number(m[1]) * 1000 ** ' kmgt'.indexOf(m[2]!.toLowerCase() || ' ');
};

const cap = () => bytes(process.env.AGENTGRAPH_ENV_CAP || '60g');
const lines = (out: string) => out.split('\n').filter(Boolean);
const ask = (args: string[], timeout?: number) => docker(args, timeout).catch(() => '');
const pins = () => join(state(), 'pins');

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

const skipped = new Set(['.attic', 'data', 'forge', '.git', 'node_modules']);

/**
 * Score trees beside a `case.json` and `target-shared` dirs holding `CACHEDIR.TAG`, at most `depth` levels under
 * `root`. Records, run data and git dirs are never entered.
 */
export const trees = (root: string, depth = 5): string[] => {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const here = new Set(entries.map(e => e.name));
  return entries
    .filter(e => e.isDirectory() && !skipped.has(e.name) && !e.name.endsWith('.git'))
    .flatMap(e => {
      const at = join(root, e.name);
      if (e.name === 'tree') return here.has('case.json') ? [at] : [];
      if (e.name === 'target-shared') return existsSync(join(at, 'CACHEDIR.TAG')) ? [at] : [];
      return depth > 1 ? trees(at, depth - 1) : [];
    });
};

const busy = (path: string) => {
  const pid = Number((existsSync(`${path}.lock`) && readFileSync(`${path}.lock`, 'utf8')) || 0);
  return pid > 0 && pid !== process.pid && alive(pid);
};

const du = (path: string) =>
  new Promise<number>(done =>
    execFile('du', ['-sk', path], { timeout: 600_000 }, (e, out) => done(e ? 0 : Number(out.split('\t')[0]) * 1024))
  );

/** Sizes of docker volumes, read by one container that mounts them all read-only. */
const sizes = async (names: string[]) => {
  if (!names.length) return new Map<string, number>();
  const out = await ask(
    [
      'run',
      ...unlogged,
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--user',
      '0:0',
      '--cap-drop=ALL',
      '--cap-add=DAC_READ_SEARCH',
      ...names.flatMap((n, i) => ['--mount', `type=volume,src=${n},dst=/v/${i},readonly`]),
      process.env.AGENTGRAPH_IMAGE || 'agentgraph-sandbox:local',
      'du',
      '-sk',
      ...names.map((_, i) => `/v/${i}`),
    ],
    1_800_000
  );
  return new Map(
    lines(out).map(l => {
      const [kb = '0', path = ''] = l.split('\t');
      return [names[Number(path.slice(3))] ?? '', Number(kb) * 1024] as const;
    })
  );
};

const legacyVolume = /^bothub-(layer-.+|lower-.+|cache|cache-envtest|build-cache|npm-cache)$/;
const isData = (name: string, labels: Record<string, string>) =>
  name.startsWith('bothub_') || Object.keys(labels).some(k => k.startsWith('com.docker.compose.'));
const labelsOf = (text = '') =>
  Object.fromEntries(
    text
      .split(',')
      .filter(Boolean)
      .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
  ) as Record<string, string>;

/**
 * Every cache item agentgraph and the old engine left in docker, and the host build dirs under `roots`. Only our names
 * count; compose objects and `bothub_*` volumes are data and never appear. With `measure`, volumes without a recorded
 * size are measured; otherwise they count 0 bytes.
 */
export const inventory = async (o: { roots?: string[]; measure?: boolean } = {}): Promise<Item[]> => {
  const tagsOf = new Map<string, string[]>();
  for (const l of lines(await ask(['image', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']))) {
    const [id = '', tag = ''] = l.split(' ');
    if (/^(agentgraph|bothub)-env\//.test(tag)) tagsOf.set(id, [...(tagsOf.get(id) ?? []), tag]);
  }
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
    .filter(v => !isData(v.name, v.labels));
  const overlaid = (key: string) =>
    vols.some(
      v => v.labels['agentgraph.lower'] === key && v.labels['agentgraph.layer'] && live(v.labels['agentgraph.layer'])
    );
  const names = new Set(vols.map(v => v.name));
  const items: Item[] = [];
  const keys = new Set<string>();
  const inspected = tagsOf.size
    ? lines(
        await ask(['image', 'inspect', '--format', '{{.Id}} {{.Created}} {{json .Config.Labels}}', ...tagsOf.keys()])
      )
    : [];
  for (const l of inspected) {
    const [id = '', created = '', ...rest] = l.split(' ');
    const labels = (JSON.parse(rest.join(' ') || 'null') ?? {}) as Record<string, string>;
    const tags = tagsOf.get(id) ?? [];
    if (!tags.length || isData('', labels)) continue;
    const top = Number(lines(await ask(['history', '--human=false', '--format', '{{.Size}}', id]))[0]) || 0;
    const key = labels['agentgraph.env'];
    const stamp = key && existsSync(join(used(), key)) ? statSync(join(used(), key)).mtimeMs : Date.parse(created) || 0;
    if (key) keys.add(key);
    items.push({
      kind: key ? 'env' : 'legacy',
      refs: [...tags, ...(key && names.has(lowerOf(key)) ? [lowerOf(key)] : [])],
      bytes: top + (Number(labels['agentgraph.lowerkb']) || 0) * 1024,
      used: stamp,
      ...((tags.some(t => runImages.has(t)) || runImages.has(id)) && { held: 'container' }),
      ...(key && overlaid(key) && { held: 'live checkout' }),
      ...(key && held(key, false) && { held: 'recent use' }),
    });
  }
  const loose = vols.filter(
    v =>
      (v.name.startsWith('agentgraph-lower-') && !keys.has(v.name.slice('agentgraph-lower-'.length))) ||
      legacyVolume.test(v.name)
  );
  const measured = o.measure ? await sizes(loose.map(v => v.name)) : new Map<string, number>();
  for (const v of loose) {
    const key = v.name.slice('agentgraph-lower-'.length);
    const lower = v.name === lowerOf(key);
    items.push({
      kind: lower ? 'lower' : 'legacy',
      refs: [v.name],
      bytes: measured.get(v.name) ?? 0,
      used: 0,
      ...((lower || v.name.startsWith('bothub-layer-')) && { always: true }),
      ...(mounted.has(v.name) ? { held: 'container' } : lower && overlaid(key) && { held: 'live checkout' }),
    });
  }
  for (const path of (o.roots ?? []).flatMap(root => trees(root))) {
    const score = basename(path) === 'tree';
    items.push({
      kind: 'tree',
      refs: [path],
      bytes: await du(path),
      used: statSync(path).mtimeMs,
      ...(score && { always: true }),
      ...(busy(path) && { held: 'busy' }),
    });
  }
  const active = unexpired();
  return items.map(i => {
    const p = !i.held && active.find(p => i.refs.some(p.test));
    return p ? { ...i, held: `pin ${p.name}` } : i;
  });
};

/**
 * Which items to remove: every unheld `always` item, then unheld items oldest first, the old engine's first, while the
 * counted cache is over `limit` or free space is under `floor`.
 */
export const plan = (items: Item[], o: { limit: number; free: number; floor: number }) => {
  const open = items.filter(i => !i.held);
  const chosen = open.filter(i => i.always);
  let total = items.filter(i => !i.always).reduce((n, i) => n + i.bytes, 0);
  let free = o.free + chosen.reduce((n, i) => n + i.bytes, 0);
  const rest = open
    .filter(i => !i.always)
    .sort((a, b) => Number(b.kind === 'legacy') - Number(a.kind === 'legacy') || a.used - b.used);
  for (const i of rest) {
    if (total <= o.limit && free >= o.floor) break;
    chosen.push(i);
    total -= i.bytes;
    free += i.bytes;
  }
  return chosen;
};

const remove = async (i: Item) => {
  if (i.kind === 'tree') return (rmSync(i.refs[0]!, { recursive: true, force: true }), true);
  const ok = (args: string[]) =>
    docker(args).then(
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
  const removed: Item[] = [];
  for (const i of plan(items, { limit: o.limit ?? cap(), free: o.free ?? Infinity, floor: o.floor ?? 0 }))
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
  const free = docker(
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

const reasonOf = (free: number, need: number, kept: Item[]) => {
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

/** Too little free disk to start more work, with what holds the cache that is left. */
export class DiskLow extends Error {
  readonly held: Item[];
  constructor(free: number, need: number, held: Item[]) {
    super(reasonOf(free, need, held));
    this.held = held;
  }
}

/**
 * Makes sure `disk` has `min` GB free (`AGENTGRAPH_MIN_FREE_GB`, 40): below it, sweeps dead runners' volumes and
 * collects cache, also under `AGENTGRAPH_GC_ROOTS`, then throws `DiskLow` if that was not enough. It never stops a
 * running container.
 */
export const room = async (disk: Disk, min = Number(process.env.AGENTGRAPH_MIN_FREE_GB || 40)) => {
  if ((await freeOf(disk)) >= min * 1e9) return;
  inDocker.clear();
  await sweep(60_000);
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
