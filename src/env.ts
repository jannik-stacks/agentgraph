import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A repo's environment at one base: an image holding the base files plus what the toolchain step and setup made of
 * them. `outputs` are the ignored directories setup made, relative to the checkout root; `complete` says they are
 * everything setup left behind, so a checkout of the same files needs no setup. The dependency directories among the
 * outputs live once in the volume `lower`, at `data/<n>` in their order, not in the image.
 */
export type Env = { image: string; outputs: string[]; complete: boolean; lower?: string };

/** What an Env is built from: `git` is a repo dir holding `base`, `image` the image it starts from. */
export type EnvSpec = {
  repo: string;
  image: string;
  git: string;
  base: string;
  cache: string;
  setup?: string;
  toolchain?: string;
};

/** Shell lines that install the toolchain a repo's root `files` name, run from the repo root with network. */
export const toolchainOf = (files: string[]) => {
  const has = (...names: string[]) => names.some(name => files.includes(name));
  const pinned = has('rust-toolchain', 'rust-toolchain.toml');
  if (!pinned && !has('Cargo.toml')) return [];
  return [
    'command -v rustup >/dev/null || rustup-init -y -q --no-modify-path --default-toolchain none --profile minimal',
    pinned ? 'rustup toolchain install' : 'rustup default stable',
    'rustup component add clippy rustfmt',
    ...(has('Cargo.toml') ? [has('Cargo.lock') ? 'cargo fetch --locked' : 'cargo fetch'] : []),
  ];
};

/** Files whose change can change what setup installs. */
export const manifest =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|Cargo\.toml|Cargo\.lock|rust-toolchain(\.toml)?)$/;

const docker = (args: string[], timeout = 600_000) =>
  new Promise<string>((done, fail) =>
    execFile('docker', args, { timeout, maxBuffer: 256 << 20 }, (error, stdout, stderr) =>
      error
        ? fail(
            Object.assign(
              new Error(`docker ${args[0]}: ${`${stdout}${stderr}`.trim().slice(-2000) || error.message}`),
              { code: error.code, output: `${stdout}${stderr}` }
            )
          )
        : done(stdout.trim())
    )
  );

const user = () => [process.getuid?.() ?? 1000, process.getgid?.() ?? 1000];

/** The build: as root only to hand `/work` to the operator, then the rest as the operator. */
const asOperator = () => {
  const [uid, gid] = user();
  return `mkdir -p /work && chown ${uid}:${gid} /work /lower && exec setpriv --reuid=${uid} --regid=${gid} --clear-groups sh -c "$1" sh "$2" "$3" "$4" "$5"`;
};

/**
 * Base files into `/work`, the toolchain under the cache lock, setup, then the directories git does not track; the
 * dependency directories among them move to `/lower/data/<n>`.
 */
const build = [
  'set -e',
  'export HOME=/tmp TMPDIR=/tmp GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" AGENTGRAPH_BASE="$2"',
  'cd /work',
  'git --git-dir="$1" archive "$2" | tar -x -C /work',
  'if [ -n "$3" ]; then (exec 9>/cache/.toolchain.lock && flock 9 && sh -ec "$3") || exit 97; fi',
  'if [ -n "$4" ]; then sh -ec "$4" || exit 98; fi',
  'export GIT_DIR="$1" GIT_WORK_TREE=/work GIT_INDEX_FILE=/tmp/index',
  'git read-tree "$2"',
  'echo @@ignored',
  'git ls-files -o -i --exclude-standard --directory',
  'echo @@untracked',
  'git ls-files -o --exclude-standard --directory',
  'rm -rf /lower/data && mkdir /lower/data && n=0',
  'git ls-files -o -i --exclude-standard --directory | grep -E "(^|/)(node_modules|target)/$" | while read -r d; do',
  '  mv "/work/${d%/}" "/lower/data/$n" && n=$((n + 1))',
  'done',
  'echo @@lower',
  'du -sk /lower/data | cut -f1',
].join('\n');

const section = (out: string, name: string) =>
  (out.split(`@@${name}\n`)[1] ?? '').split(/^@@/m)[0]!.split('\n').filter(Boolean);

/** Where runners keep what must outlive them: Env last-use stamps and owner heartbeats. */
const state = () => process.env.AGENTGRAPH_STATE || join(homedir(), '.cache', 'agentgraph');
const used = () => join(state(), 'envs');
const owners = () => join(state(), 'owners');
const stamp = (file: string) => {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '', { flag: 'a' });
    utimesSync(file, new Date(), new Date());
  } catch {}
};
const touch = (key: string) => stamp(join(used(), key));

export const ownerId = () => randomBytes(6).toString('hex');

/** This process as an owner of volumes and checkouts; pids repeat across container restarts, so it is random. */
const self = ownerId();
let beating: NodeJS.Timeout | undefined;

/** Marks this process alive for other runners' sweeps, every 30 s while it runs; answers its `pid:owner` label. */
export const beat = () => {
  stamp(join(owners(), self));
  if (!beating) (beating = setInterval(() => stamp(join(owners(), self)), 30_000)).unref();
  return `${process.pid}:${self}`;
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Whether the `pid:owner` label's process still runs: its heartbeat is under two minutes old, or, when this runner
 * cannot see that heartbeat, its pid lives.
 */
export const live = (label: string) => {
  const [pid, owner = ''] = label.split(':');
  if (owner === self) return true;
  try {
    return Date.now() - statSync(join(owners(), owner || '-')).mtimeMs < 120_000;
  } catch {
    return Boolean(Number(pid)) && alive(Number(pid));
  }
};

const tagOf = (repo: string, key: string) =>
  `agentgraph-env/${
    repo
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '') || 'repo'
  }:${key}`;

const labels = async (tag: string) => {
  const out = await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag]).catch(() => '');
  const l = out ? (JSON.parse(out) as Record<string, string> | null) : null;
  return l?.['agentgraph.env'] ? l : undefined;
};

const lowerOf = (key: string) => `agentgraph-lower-${key}`;

const envOfLabels = (tag: string, l: Record<string, string>): Env => {
  const outputs = JSON.parse(l['agentgraph.outputs'] ?? '[]') as string[];
  return {
    image: tag,
    outputs,
    complete: l['agentgraph.complete'] === 'true',
    ...(outputs.some(o => deps.test(o)) && { lower: lowerOf(l['agentgraph.env']!) }),
  };
};

const building = new Map<string, Promise<Env | undefined>>();

/**
 * The Env for `spec`: the tagged image when one exists, else one container on the base's files with open network,
 * committed. Throws when the toolchain fails; undefined when setup fails, so setup runs in each checkout as before.
 */
export const envOf = async (spec: EnvSpec): Promise<Env | undefined> => {
  const git = (...args: string[]) =>
    new Promise<string>((done, fail) =>
      execFile('git', ['--git-dir', spec.git, ...args], { maxBuffer: 64 << 20 }, (e, out) =>
        e ? fail(e) : done(out.trim())
      )
    );
  const [tree, files, from] = await Promise.all([
    git('rev-parse', `${spec.base}^{tree}`),
    git('ls-tree', '--name-only', spec.base),
    docker(['image', 'inspect', '--format', '{{.Id}}', spec.image]),
  ]);
  const lines = [...toolchainOf(files.split('\n')), ...(spec.toolchain ? [spec.toolchain] : [])].join('\n');
  if (!lines && !spec.setup) return undefined;
  const key = createHash('sha256')
    .update(JSON.stringify([4, from, tree, lines, spec.setup ?? '']))
    .digest('hex')
    .slice(0, 24);
  const tag = tagOf(spec.repo, key);
  const pending = building.get(tag);
  if (pending) return pending;
  const made = (async () => {
    for (;;) {
      const found = await labels(tag);
      const env = found && envOfLabels(tag, found);
      if (
        env &&
        (!env.lower ||
          (await docker(['volume', 'inspect', env.lower]).then(
            () => true,
            () => false
          )))
      )
        return (touch(key), env);
      if (env) await docker(['rmi', '-f', tag]).catch(() => '');
      const name = `agentgraph-envbuild-${key}`;
      await docker(['volume', 'create', '--label', `agentgraph.lower=${key}`, lowerOf(key)]);
      const started = Date.now();
      const args = [
        'run',
        '--init',
        '--pull',
        'never',
        '--name',
        name,
        '--label',
        'agentgraph.envbuild=1',
        '--network',
        'bridge',
        '--user',
        '0:0',
        '--cap-drop=ALL',
        '--cap-add=CHOWN',
        '--cap-add=SETUID',
        '--cap-add=SETGID',
        '--security-opt',
        'no-new-privileges=true',
        '--tmpfs',
        '/tmp:rw,exec,nosuid,nodev,size=4g',
        '--memory',
        '8g',
        '--mount',
        `type=bind,src=${spec.git},dst=${spec.git},readonly`,
        ...(spec.cache ? ['--mount', `type=volume,src=${spec.cache},dst=/cache`] : []),
        '--mount',
        `type=volume,src=${lowerOf(key)},dst=/lower`,
        spec.image,
        'sh',
        '-c',
        asOperator(),
        'sh',
        build,
        spec.git,
        spec.base,
        lines,
        spec.setup ?? '',
      ];
      const out = await docker(args, 7_200_000).then(
        output => ({ code: 0, output }),
        (e: { code?: number; output?: string; message: string }) => ({
          code: typeof e.code === 'number' ? e.code : -1,
          output: e.output ?? e.message,
        })
      );
      if (/Conflict\. The container name/.test(out.output)) {
        const running = await docker(['container', 'inspect', '--format', '{{.State.Running}}', name]).catch(() => '');
        if (running === 'true') await new Promise(r => setTimeout(r, 5000));
        else await docker(['rm', '-f', name]).catch(() => '');
        continue;
      }
      const keep = out.code === 0 && section(out.output, 'ignored').some(p => deps.test(p.slice(0, -1)));
      if (!keep) await docker(['volume', 'rm', '-f', lowerOf(key)]).catch(() => '');
      try {
        if (out.code === 97) throw new Error(`toolchain exited: ${out.output.trim().slice(-2000)}`);
        if (out.code === 98) return undefined;
        if (out.code !== 0) throw new Error(`env build exited ${out.code}: ${out.output.trim().slice(-2000)}`);
        const ignored = section(out.output, 'ignored');
        const outputs = ignored.filter(p => p.endsWith('/')).map(p => p.slice(0, -1));
        const complete = outputs.length === ignored.length && !section(out.output, 'untracked').length;
        const env = { image: tag, outputs, complete, ...(keep && { lower: lowerOf(key) }) };
        await docker([
          'commit',
          '--change',
          `LABEL agentgraph.env=${key} agentgraph.lowerkb=${Number(section(out.output, 'lower')[0]) || 0} agentgraph.complete=${complete} agentgraph.outputs=${JSON.stringify(JSON.stringify(outputs))}`,
          name,
          tag,
        ]);
        touch(key);
        console.error(`env ${tag} built in ${Math.round((Date.now() - started) / 1000)}s`);
        return env;
      } finally {
        await docker(['rm', '-f', name]).catch(() => '');
      }
    }
  })();
  building.set(tag, made);
  made.catch(() => building.delete(tag));
  return made;
};
/** A dependency directory of a checkout: the volume `name` at `dst`, and when it is an overlay, the volume `upper` holding its writes. */
export type Layer = { name: string; dst: string; upper?: string };

/** Dependency directories, which setup fills and rarely deletes, so a volume can sit at their path. */
const deps = /(^|\/)(node_modules|target)$/;

/**
 * Where setup may put dependencies at `base`: `node_modules` beside each `package.json` and `target` beside each
 * outermost `Cargo.toml`, the shallowest `limit` of them.
 */
export const dependencyDirs = (git: string, base: string, limit = 64) =>
  new Promise<string[]>((done, fail) =>
    execFile('git', ['--git-dir', git, 'ls-tree', '-r', '--name-only', base], { maxBuffer: 256 << 20 }, (e, out) => {
      if (e) return fail(e);
      const files = out.split('\n').filter(p => p && !/(^|\/)node_modules\//.test(p));
      const dirsOf = (name: string) =>
        files.filter(p => p === name || p.endsWith(`/${name}`)).map(p => p.slice(0, -name.length));
      const crates = dirsOf('Cargo.toml');
      const found = [
        ...dirsOf('package.json').map(d => `${d}node_modules`),
        ...crates.filter(d => !crates.some(o => o !== d && d.startsWith(o))).map(d => `${d}target`),
      ];
      done(found.sort((a, b) => a.split('/').length - b.split('/').length).slice(0, limit));
    })
  );

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const overlayOf = (lower: string, upper: string) => [
  '--driver',
  'local',
  '--opt',
  'type=overlay',
  '--opt',
  'device=overlay',
  '--opt',
  `o=lowerdir=${lower},upperdir=${upper}/upper,workdir=${upper}/work`,
];
const mountpoints = async (...names: string[]) =>
  (await docker(['volume', 'inspect', '-f', '{{.Mountpoint}}', ...names])).split('\n');

let overlay: Promise<boolean> | undefined;
/** Whether this docker mounts an overlay volume, tried once with `image`. */
const overlays = (image: string) =>
  (overlay ??= (async () => {
    const [lower, upper, over] = ['l', 'u', 'o'].map(s => `agentgraph-probe-${self}-${s}`) as [string, string, string];
    const run = (mount: string, ...cmd: string[]) =>
      docker(['run', '--rm', '--pull', 'never', '--network', 'none', '--user', '0:0', '--mount', mount, image, ...cmd]);
    try {
      await docker(['volume', 'create', lower]);
      await docker(['volume', 'create', upper]);
      await run(`type=volume,src=${upper},dst=/u`, 'mkdir', '-p', '/u/upper', '/u/work');
      const [l, u] = await mountpoints(lower, upper);
      await docker(['volume', 'create', ...overlayOf(l!, u!), over]);
      await run(`type=volume,src=${over},dst=/o`, 'touch', '/o/x');
      return true;
    } catch {
      return false;
    } finally {
      await docker(['volume', 'rm', '-f', over, upper, lower]).catch(() => '');
    }
  })());

/**
 * Volumes for the checkout at `dir` at every dependency directory, so setup never writes one into the checkout. Where
 * the Env made one, the volume is an overlay over the Env's `lower` copy that holds only this checkout's writes, or a
 * copy of it where docker cannot mount overlays; elsewhere it starts empty. `more` names directories beyond the Env's
 * outputs. Every volume carries this process as its owner, so a sweep finds the ones a dead runner left. The Env's
 * other outputs are copied into `dir`, where a build may delete and remake them.
 */
export const layer = async (
  from: Pick<Env, 'image' | 'outputs' | 'lower'>,
  owner: string,
  dir: string,
  more: string[] = []
): Promise<Layer[]> => {
  const made = from.lower ? from.outputs.filter(o => deps.test(o)) : [];
  const paths = [...new Set([...made, ...more])];
  const rest = from.outputs.filter(o => !deps.test(o));
  if (!paths.length && !rest.length) return [];
  const over = made.length > 0 && (await overlays(from.image));
  const label = ['--label', `agentgraph.layer=${beat()}`, '--label', `agentgraph.owner=${owner}`];
  const layers: Layer[] = paths.map((o, i) => ({ name: `agentgraph-layer-${owner}-${i}`, dst: `/work/${o}` }));
  const [uid, gid] = user();
  const script = [
    'set -e',
    ...layers.map((_, i) =>
      i >= made.length
        ? `chown ${uid}:${gid} /u/${i}`
        : over
          ? `mkdir -p /u/${i}/upper /u/${i}/work && chown ${uid}:${gid} /u/${i}/upper`
          : `cp -a /lower/data/${i}/. /u/${i}/ && chown ${uid}:${gid} /u/${i}`
    ),
    ...rest.map(o => {
      const parent = quote(`/dst/${o.split('/').slice(0, -1).join('/')}`);
      return `mkdir -p ${parent} && cp -a ${quote(`/work/${o}`)} ${parent}/`;
    }),
  ].join('\n');
  try {
    for (const l of layers) await docker(['volume', 'create', ...label, l.name]);
    await docker(
      [
        'run',
        '--rm',
        '--pull',
        'never',
        '--network',
        'none',
        '--user',
        '0:0',
        '--cap-drop=ALL',
        '--cap-add=CHOWN',
        '--cap-add=DAC_OVERRIDE',
        '--cap-add=FOWNER',
        '--security-opt',
        'no-new-privileges=true',
        '--mount',
        `type=bind,src=${dir},dst=/dst`,
        ...(made.length ? ['--mount', `type=volume,src=${from.lower},dst=/lower,readonly`] : []),
        ...layers.flatMap((l, i) => ['--mount', `type=volume,src=${l.name},dst=/u/${i},volume-nocopy`]),
        from.image,
        'sh',
        '-c',
        script,
      ],
      3_600_000
    );
    if (over) {
      const [lower, ...uppers] = await mountpoints(from.lower!, ...layers.slice(0, made.length).map(l => l.name));
      for (const [i, upper] of uppers.entries()) {
        const name = `${layers[i]!.name}-o`;
        await docker([
          'volume',
          'create',
          ...label,
          '--label',
          `agentgraph.lower=${from.lower!.replace('agentgraph-lower-', '')}`,
          ...overlayOf(`${lower}/data/${i}`, upper),
          name,
        ]);
        layers[i] = { ...layers[i]!, name, upper: layers[i]!.name };
      }
    }
  } catch (e) {
    await discard(layers);
    throw e;
  }
  return layers;
};

/** Removes a checkout's dependency volumes, each overlay before the volume holding its writes. */
export const discard = (layers: Layer[], timeout?: number) =>
  layers.length
    ? docker(
        ['volume', 'rm', '-f', ...layers.map(l => l.name), ...layers.flatMap(l => (l.upper ? [l.upper] : []))],
        timeout
      ).then(
        () => undefined,
        () => undefined
      )
    : Promise.resolve();

/** Marks the checkout `dir` as this process's, so a sweep in another runner leaves it alone while this one lives. */
export const mark = (dir: string) => {
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(`${dir}.owner`, beat());
};

/** Removes the checkouts under `data` whose owner is gone, with their index and news dirs. */
export const reap = (data: string) => {
  const work = join(data, 'work');
  let ids: string[] = [];
  try {
    ids = readdirSync(work).filter(n => !n.endsWith('.owner'));
  } catch {}
  const gone = ids.filter(id => {
    try {
      return !live(readFileSync(join(work, `${id}.owner`), 'utf8').trim());
    } catch {
      return true;
    }
  });
  for (const id of gone)
    for (const p of [join(work, id), join(work, `${id}.owner`), join(data, 'index', id), join(data, 'news', id)])
      rmSync(p, { recursive: true, force: true });
  return gone.length;
};

const volumes = async (label: string, timeout?: number) =>
  (await docker(['volume', 'ls', '--filter', `label=${label}`, '--format', `{{.Name}} {{.Label "${label}"}}`], timeout))
    .split('\n')
    .filter(Boolean)
    .map(l => l.split(' ') as [string, string]);

/** Removes dependency volumes whose owner is gone; a docker that does not answer within `timeout` ms sweeps nothing. */
export const sweep = async (timeout = 600_000) => {
  beat();
  const dead = (await volumes('agentgraph.layer', timeout).catch(() => []))
    .filter(([, owner]) => !live(owner))
    .map(([name]) => name)
    .sort((a, b) => Number(b.endsWith('-o')) - Number(a.endsWith('-o')));
  if (dead.length) await docker(['volume', 'rm', '-f', ...dead], timeout).catch(() => '');
  return dead.length;
};

/** Bytes of a size like `60g`, `1.2GB` or `512MB`, in powers of 1000 as docker prints them. */
export const bytes = (size: string) => {
  const m = /^([\d.]+)\s*([kmgt]?)b?$/i.exec(size.trim());
  if (!m) throw new Error(`not a size: ${size}`);
  return Number(m[1]) * 1000 ** ' kmgt'.indexOf(m[2]!.toLowerCase() || ' ');
};

/** Env images with their size in bytes, their dependency volume's included, and their last use, the oldest first. */
export const envs = async () => {
  const tags = (
    await docker(['image', 'ls', '--filter', 'label=agentgraph.env', '--format', '{{.Repository}}:{{.Tag}}']).catch(
      () => ''
    )
  )
    .split('\n')
    .filter(Boolean);
  const out = tags.length
    ? await docker([
        'image',
        'inspect',
        '--format',
        '{{index .RepoTags 0}} {{.Size}} {{index .Config.Labels "agentgraph.lowerkb"}}',
        ...tags,
      ]).catch(() => '')
    : '';
  const times = new Map<string, number>();
  try {
    for (const key of readdirSync(used())) times.set(key, statSync(join(used(), key)).mtimeMs);
  } catch {}
  return out
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [image = '', size = '0', kb = '0'] = l.split(' ');
      const b = Number(size) + (Number(kb) || 0) * 1024;
      return { image, size: `${(b / 1e9).toFixed(1)}GB`, bytes: b, used: times.get(image.split(':')[1] ?? '') ?? 0 };
    })
    .sort((a, b) => a.used - b.used);
};

const cap = () => bytes(process.env.AGENTGRAPH_ENV_CAP || '60g');

/**
 * Removes the least recently used Env images and their dependency volumes until they fit in `limit` bytes, never one
 * a running container or a live checkout uses, then any dependency volume whose image is gone and no checkout uses.
 */
export const evict = async (limit = cap(), dry = false) => {
  const all = await envs();
  const running = new Set((await docker(['ps', '--format', '{{.Image}}']).catch(() => '')).split('\n').filter(Boolean));
  const layered = await volumes('agentgraph.lower').catch(() => []);
  const owners = new Map((await volumes('agentgraph.layer').catch(() => [])).map(([name, owner]) => [name, owner]));
  const inUse = (key: string) => layered.some(([name, k]) => k === key && live(owners.get(name) ?? ''));
  let total = all.reduce((sum, e) => sum + e.bytes, 0);
  const removed: string[] = [];
  for (const e of all) {
    if (total <= limit) break;
    if (running.has(e.image) || inUse(e.image.split(':')[1] ?? '')) continue;
    if (
      dry ||
      (await docker(['rmi', e.image]).then(
        () => true,
        () => false
      ))
    ) {
      removed.push(e.image);
      total -= e.bytes;
    }
  }
  const kept = new Set(all.filter(e => !removed.includes(e.image)).map(e => e.image.split(':')[1]));
  const orphans = layered.filter(([name, key]) => name === lowerOf(key) && !kept.has(key) && !inUse(key));
  if (!dry) for (const [name] of orphans) await docker(['volume', 'rm', name]).catch(() => '');
  return [...removed, ...orphans.map(([name]) => name)];
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

/** Free gigabytes where `disk` writes, the smaller of the host dir and the docker disk. */
const freeGb = async ({ dir, image, volume }: Disk) => {
  let host = Infinity;
  try {
    const s = statfsSync(dir);
    host = s.bavail * s.bsize;
  } catch {}
  return Math.min(host, image && volume ? await dockerFree(image, volume) : Infinity) / 1e9;
};

/**
 * Makes sure `disk` has `AGENTGRAPH_MIN_FREE_GB` (40) free: below it, sweeps and evicts Envs past `AGENTGRAPH_ENV_CAP`, then
 * throws `disk low` if that was not enough.
 */
export const room = async (disk: Disk, min = Number(process.env.AGENTGRAPH_MIN_FREE_GB || 40)) => {
  if ((await freeGb(disk)) >= min) return;
  inDocker.clear();
  await sweep(60_000);
  await evict();
  const gb = await freeGb(disk);
  if (gb < min) throw new Error(`disk low: ${gb.toFixed(1)} GB free, AGENTGRAPH_MIN_FREE_GB is ${min}`);
};
