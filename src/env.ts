import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeHostEnv } from './git.ts';
import { isOwnerRunning, ownerId, readStateDir, startHeartbeat, waitForLock } from './owner.ts';

/**
 * A repo's environment: what the toolchain step and setup made of a base's files. `outputs` are the ignored directories
 * setup made, relative to the checkout root; `complete` says they are everything setup left behind, so a checkout with
 * the same `inputs` needs no setup. They live once in the volume `lower`: dependency directories at
 * `.agentgraph-env/data/<n>` in their order, the rest under `.agentgraph-env/rest`. The image only carries the labels.
 * In `deps` mode setup saw only the skeleton and `inputs` is its digest; in `tree` mode it saw every file and `inputs`
 * is the base tree.
 */
type SandboxSetup = {
  image: string;
  outputs: string[];
  complete: boolean;
  lower?: string;
  key: string;
  mode: 'deps' | 'tree';
  inputs: string;
};

/** What a sandbox setup is built from: `git` is a repo dir holding `base`, `image` the image it starts from. */
type SandboxSetupSpec = {
  repo: string;
  image: string;
  git: string;
  base: string;
  cache: string;
  setup?: string;
  toolchain?: string;
};

/**
 * Shell lines that install the toolchain a repo's root `files` name, run from the repo root with network.
 */
export const makeToolchainSetupCommands = (files: string[]) => {
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

/** Files a package manager or toolchain reads when it installs, so a change to one can change what setup installs. */
export const manifest =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.pnpmfile\.cjs|yarn\.lock|\.yarnrc(\.yml)?|\.npmrc|\.nvmrc|\.node-version|Cargo\.toml|Cargo\.lock|rust-toolchain(\.toml)?)$|^(patches|\.yarn\/(patches|releases))\//;

/** The files setup sees in `deps` mode: `paths` from the base, `stubs` made empty, and a digest over both. */
type Skeleton = { paths: string[]; stubs: string[]; digest: string };

const git = (dir: string, ...args: string[]) =>
  new Promise<string>((done, fail) =>
    execFile('git', ['--git-dir', dir, ...args], { env: makeHostEnv(), maxBuffer: 256 << 20 }, (e, out) =>
      e ? fail(e) : done(out.trim())
    )
  );

/**
 * The skeleton of `rev`: its `manifest` files and ignore rules outside `node_modules`, and the Cargo target files beside
 * a `Cargo.toml` (lib, bins, build script, benches, examples and tests) that setup gets as stubs, so a fetch or
 * dependency build works without the source.
 * @internal
 */
export const readDependencySkeleton = async (dir: string, rev: string): Promise<Skeleton> => {
  const entries = (await git(dir, 'ls-tree', '-r', rev))
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [meta = '', path = ''] = l.split('\t');
      return { meta, path };
    })
    .filter(e => !/(^|\/)node_modules\//.test(e.path));
  const crates = new Set(entries.filter(e => /(^|\/)Cargo\.toml$/.test(e.path)).map(e => e.path.slice(0, -10)));
  const paths = entries.filter(e => manifest.test(e.path) || /(^|\/)\.gitignore$/.test(e.path));
  const stubs = entries
    .map(e => e.path)
    .filter(p => {
      const m =
        /^(.*?)(src\/lib\.rs|src\/main\.rs|build\.rs|(src\/bin|benches|examples|tests)\/[^/]+\.rs|(src\/bin|benches|examples|tests)\/[^/]+\/main\.rs)$/.exec(
          p
        );
      return Boolean(m && crates.has(m[1]!));
    });
  const digest = createHash('sha256')
    .update(JSON.stringify([paths.map(e => `${e.meta} ${e.path}`), stubs]))
    .digest('hex');
  return { paths: paths.map(e => e.path), stubs, digest };
};

/** What `rev` gives setup in `mode`: the skeleton digest or the tree id. */
export const readSetupInputKey = async (dir: string, rev: string, mode: SandboxSetup['mode']) =>
  mode === 'deps' ? (await readDependencySkeleton(dir, rev)).digest : git(dir, 'rev-parse', `${rev}^{tree}`);

/**
 * Where npm, pnpm and yarn keep what they download, shared by every container and sandbox setup build through the cache volume
 * at `/cache`. npm and pnpm lock their own writes; yarn 1 does not, and without this its cache fills the small `/tmp`.
 */
export const packageManagerCacheEnv = {
  npm_config_cache: '/cache/npm',
  npm_config_store_dir: '/cache/pnpm',
  YARN_CACHE_FOLDER: '/cache/yarn',
};

/** Containers keep no log on the docker disk; the runner reads their output as they run. */
export const unlogged = ['--log-driver', 'none'];

export const runDockerCli = (args: string[], timeout = 600_000) =>
  new Promise<string>((done, fail) =>
    execFile('docker', args, { env: makeHostEnv(), timeout, maxBuffer: 256 << 20 }, (error, stdout, stderr) =>
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
  return `chown ${uid}:${gid} /work && exec setpriv --reuid=${uid} --regid=${gid} --clear-groups sh -c "$1" sh "$2" "$3" "$4" "$5" "$6" "$7" "$8"`;
};

/**
 * Builds in the lower volume at `/work`, under its lock, once: the base's files (only the skeleton and its stubs in
 * `deps` mode), the toolchain under the cache lock, setup, then the directories git does not track move to
 * `.agentgraph-env`, dependency directories to `data/<n>` and the rest to `rest`, and the source goes. Every write
 * stays in the volume, so the moves are renames. A later build of the same key finds `done` and prints the listing.
 */
const build = [
  'set -e',
  'export HOME=/tmp TMPDIR=/tmp GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" AGENTGRAPH_BASE="$2"',
  'cd /work && mkdir -p .agentgraph-env && exec 8>.agentgraph-env/lock && flock 8',
  'out=.agentgraph-env',
  'if [ ! -e $out/done ]; then',
  '  find /work -mindepth 1 -maxdepth 1 ! -name .agentgraph-env -exec rm -rf {} +',
  '  rm -rf $out/data $out/rest $out/listing',
  '  export GIT_DIR="$1" GIT_WORK_TREE=/work GIT_INDEX_FILE=/tmp/index',
  '  git read-tree "$2"',
  '  if [ "$5" = deps ]; then',
  '    printf "%s\\n" "$6" | sed "/^$/d" | git checkout-index --stdin',
  '    printf "%s\\n" "$7" | sed "/^$/d" | while read -r f; do',
  '      mkdir -p "$(dirname "$f")"; case "$f" in *lib.rs) : > "$f";; *) echo "fn main() {}" > "$f";; esac',
  '    done',
  '  else git checkout-index -a; fi',
  '  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
  '  if [ -n "$3" ]; then (exec 9>/cache/.toolchain.lock && flock 9 && sh -ec "$3") || exit 97; fi',
  '  if [ -n "$4" ]; then RUSTUP_AUTO_INSTALL=0 sh -ec "$4" || exit 98; fi',
  '  if [ "$5" = deps ] && [ -d target ]; then',
  '    printf "%s\\n" "$6" | grep "Cargo\\.toml$" | while read -r f; do',
  '      sed -n "/^\\[package\\]/,/^\\[/s/^name *= *\\"\\([^\\"]*\\)\\".*/\\1/p" "$f" | head -1',
  '    done | while read -r n; do RUSTUP_AUTO_INSTALL=0 cargo clean --offline -q -p "$n" || true; done',
  '  fi',
  '  export GIT_DIR="$1" GIT_WORK_TREE=/work GIT_INDEX_FILE=/tmp/index',
  '  { echo @@ignored; git ls-files -o -i --exclude-standard --directory | grep -v "^.agentgraph-env/$" || true;',
  '    echo @@untracked; git ls-files -o --exclude-standard --directory | grep -v "^.agentgraph-env/$" || true; } > $out/listing.part',
  '  mkdir -p $out/data $out/rest && n=0',
  '  sed -n "/^@@ignored$/,/^@@untracked$/p" $out/listing.part | grep "/$" | while read -r d; do',
  '    case "$d" in node_modules/|*/node_modules/|target/|*/target/) mv "${d%/}" "$out/data/$n" && n=$((n + 1));;',
  '      *) mkdir -p "$out/rest/$(dirname "$d")" && mv "${d%/}" "$out/rest/${d%/}";; esac',
  '  done || true',
  '  find /work -mindepth 1 -maxdepth 1 ! -name .agentgraph-env -exec rm -rf {} +',
  '  mv $out/listing.part $out/listing && du -sk $out | cut -f1 > $out/kb && touch $out/done',
  'fi',
  'cat $out/listing',
  'echo @@lower',
  'cat $out/kb',
].join('\n');

const section = (out: string, name: string) =>
  (out.split(`@@${name}\n`)[1] ?? '').split(/^@@/m)[0]!.split('\n').filter(Boolean);

export const used = () => join(readStateDir(), 'envs');
const holds = () => join(readStateDir(), 'holds');
const writeTimestampFile = (file: string) => {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '', { flag: 'a' });
    utimesSync(file, new Date(), new Date());
  } catch {}
};
const touch = (key: string) => {
  writeTimestampFile(join(used(), key));
  startHeartbeat();
  writeTimestampFile(join(holds(), key, ownerId));
};
const holdHours = () => Number(process.env.AGENTGRAPH_ENV_HOLD_HOURS || 2);

/** Whether another running runner used the sandbox setup `key` within the hold window; with `prune`, stopped runners' holds are dropped. */
export const held = (key: string, prune = true) => {
  const dir = join(holds(), key);
  let owners: string[] = [];
  try {
    owners = readdirSync(dir);
  } catch {}
  const running = owners.filter(o => isOwnerRunning(`0:${o}`));
  if (prune) for (const owner of owners.filter(o => !running.includes(o))) rmSync(join(dir, owner), { force: true });
  return running.some(o => o !== ownerId && Date.now() - statSync(join(dir, o)).mtimeMs < holdHours() * 3_600_000);
};

const makeImageTag = (repo: string, key: string) =>
  `agentgraph-env/${
    repo
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '') || 'repo'
  }:${key}`;

const labels = async (tag: string) => {
  const out = await runDockerCli(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag]).catch(() => '');
  const l = out ? (JSON.parse(out) as Record<string, string> | null) : null;
  return l?.['agentgraph.env'] ? l : undefined;
};

export const makeSetupVolumeName = (key: string) => `agentgraph-lower-${key}`;

const envOfLabels = (tag: string, l: Record<string, string>): SandboxSetup => ({
  image: tag,
  outputs: JSON.parse(l['agentgraph.outputs'] ?? '[]') as string[],
  complete: l['agentgraph.complete'] === 'true',
  lower: makeSetupVolumeName(l['agentgraph.env']!),
  key: l['agentgraph.env']!,
  mode: l['agentgraph.mode'] === 'deps' ? 'deps' : 'tree',
  inputs: l['agentgraph.inputs'] ?? '',
});

const building = new Map<string, Promise<SandboxSetup | 'setup' | undefined>>();

/** The sandbox setup build format; a sandbox setup of another version is never reused. */
export const envVersion = 6;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

/**
 * The sandbox setup for `spec`: the tagged image when one exists, else one container with open network, committed. Setup first
 * sees only the skeleton; when the toolchain or setup fails there, the build runs again on every file, and later bases
 * of the same toolchain and setup go there first. Throws when the toolchain fails on every file; undefined when setup
 * fails on every file, so setup runs in each checkout as before.
 */
export const readSandboxSetup = async (spec: SandboxSetupSpec): Promise<SandboxSetup | undefined> => {
  const [tree, files, from, skeleton] = await Promise.all([
    git(spec.git, 'rev-parse', `${spec.base}^{tree}`),
    git(spec.git, 'ls-tree', '--name-only', spec.base),
    runDockerCli(['image', 'inspect', '--format', '{{.Id}}', spec.image]),
    readDependencySkeleton(spec.git, spec.base),
  ]);
  const lines = [...makeToolchainSetupCommands(files.split('\n')), ...(spec.toolchain ? [spec.toolchain] : [])].join(
    '\n'
  );
  if (!lines && !spec.setup) return undefined;
  const family = hash([envVersion, from, lines, spec.setup ?? '']);
  const wide = join(readStateDir(), 'tree-only', family);
  const one = async (mode: SandboxSetup['mode']) => {
    const inputs = mode === 'deps' ? skeleton.digest : tree;
    const key = hash([family, mode, inputs]);
    const tag = makeImageTag(spec.repo, key);
    const pending = building.get(tag);
    if (pending) return pending;
    const made = waitForLock(`env-${key}`).then(release =>
      createSandboxSetup(spec, { key, tag, mode, inputs, lines, skeleton }).finally(release)
    );
    building.set(tag, made);
    made.catch(() => building.delete(tag));
    return made;
  };
  if (!existsSync(wide)) {
    const env = await one('deps');
    if (env && env !== 'setup') return env;
    writeTimestampFile(wide);
  }
  const env = await one('tree');
  return env === 'setup' ? undefined : env;
};

const createSandboxSetup = async (
  spec: SandboxSetupSpec,
  b: { key: string; tag: string; mode: SandboxSetup['mode']; inputs: string; lines: string; skeleton: Skeleton }
): Promise<SandboxSetup | 'setup' | undefined> => {
  const { key, tag, mode } = b;
  for (;;) {
    const found = await labels(tag);
    const env = found && envOfLabels(tag, found);
    if (
      env &&
      (await runDockerCli(['volume', 'inspect', env.lower!]).then(
        () => true,
        () => false
      ))
    )
      return (touch(key), env);
    if (env) await runDockerCli(['rmi', '-f', tag]).catch(() => '');
    const name = `agentgraph-envbuild-${key}`;
    await runDockerCli(['volume', 'create', '--label', `agentgraph.lower=${key}`, makeSetupVolumeName(key)]);
    const started = Date.now();
    const args = [
      'run',
      ...unlogged,
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
      ...(spec.cache
        ? [
            '--mount',
            `type=volume,src=${spec.cache},dst=/cache`,
            ...Object.entries(packageManagerCacheEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          ]
        : []),
      '--mount',
      `type=volume,src=${makeSetupVolumeName(key)},dst=/work`,
      spec.image,
      'sh',
      '-c',
      asOperator(),
      'sh',
      build,
      spec.git,
      spec.base,
      b.lines,
      spec.setup ?? '',
      mode,
      mode === 'deps' ? b.skeleton.paths.join('\n') : '',
      mode === 'deps' ? b.skeleton.stubs.join('\n') : '',
    ];
    const out = await runDockerCli(args, 7_200_000).then(
      output => ({ code: 0, output }),
      (e: { code?: number; output?: string; message: string }) => ({
        code: typeof e.code === 'number' ? e.code : -1,
        output: e.output ?? e.message,
      })
    );
    if (/Conflict\. The container name/.test(out.output)) {
      await runDockerCli(['rm', '-f', name]).catch(() => '');
      continue;
    }
    if (out.code !== 0) await runDockerCli(['volume', 'rm', '-f', makeSetupVolumeName(key)]).catch(() => '');
    try {
      if (out.code === 97 && mode === 'tree') throw new Error(`toolchain exited: ${out.output.trim().slice(-2000)}`);
      if (out.code === 97 || out.code === 98) return mode === 'deps' ? undefined : 'setup';
      if (out.code !== 0) throw new Error(`env build exited ${out.code}: ${out.output.trim().slice(-2000)}`);
      const ignored = section(out.output, 'ignored');
      const outputs = ignored.filter(p => p.endsWith('/')).map(p => p.slice(0, -1));
      const complete = outputs.length === ignored.length && !section(out.output, 'untracked').length;
      const env: SandboxSetup = {
        image: tag,
        outputs,
        complete,
        lower: makeSetupVolumeName(key),
        key,
        mode,
        inputs: b.inputs,
      };
      const kb = Number(section(out.output, 'lower')[0]) || 0;
      await runDockerCli([
        'commit',
        '--change',
        `LABEL agentgraph.env=${key} agentgraph.version=${envVersion} agentgraph.lowerkb=${kb} agentgraph.complete=${complete} agentgraph.mode=${mode} agentgraph.inputs=${b.inputs} agentgraph.outputs=${JSON.stringify(JSON.stringify(outputs))}`,
        name,
        tag,
      ]);
      touch(key);
      console.error(
        `env ${tag} built in ${Math.round((Date.now() - started) / 1000)}s from the ${mode === 'deps' ? 'skeleton' : 'whole tree'}`
      );
      return env;
    } finally {
      await runDockerCli(['rm', '-f', name]).catch(() => '');
    }
  }
};

/** A dependency directory of a checkout: the volume `name` at `dst`, and when it is an overlay, the volume `upper` holding its writes. */
export type SharedMount = { name: string; dst: string; upper?: string };

/** Dependency directories, which setup fills and rarely deletes, so a volume can sit at their path. */
const deps = /(^|\/)(node_modules|target)$/;

/**
 * Where setup may put dependencies at `base`: `node_modules` beside each `package.json` and `target` beside each
 * outermost `Cargo.toml`, the shallowest `limit` of them.
 */
export const dependencyDirs = async (gitDir: string, base: string, limit = 64) => {
  const files = (await git(gitDir, 'ls-tree', '-r', '--name-only', base))
    .split('\n')
    .filter(p => p && !/(^|\/)node_modules\//.test(p));
  const findDirsWith = (name: string) =>
    files.filter(p => p === name || p.endsWith(`/${name}`)).map(p => p.slice(0, -name.length));
  const crates = findDirsWith('Cargo.toml');
  const found = [
    ...findDirsWith('package.json').map(d => `${d}node_modules`),
    ...crates.filter(d => !crates.some(o => o !== d && d.startsWith(o))).map(d => `${d}target`),
  ];
  return found.sort((a, b) => a.split('/').length - b.split('/').length).slice(0, limit);
};

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const makeOverlayOpts = (lower: string, upper: string) => [
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
  (await runDockerCli(['volume', 'inspect', '-f', '{{.Mountpoint}}', ...names])).split('\n');

let overlay: Promise<boolean> | undefined;
/** Whether this docker mounts an overlay volume, tried once with `image`. */
const overlays = (image: string) =>
  (overlay ??= (async () => {
    const [lower, upper, over] = ['l', 'u', 'o'].map(s => `agentgraph-probe-${ownerId}-${s}`) as [
      string,
      string,
      string,
    ];
    const run = (mount: string, ...cmd: string[]) =>
      runDockerCli([
        'run',
        ...unlogged,
        '--rm',
        '--pull',
        'never',
        '--network',
        'none',
        '--user',
        '0:0',
        '--mount',
        mount,
        image,
        ...cmd,
      ]);
    try {
      await runDockerCli(['volume', 'create', lower]);
      await runDockerCli(['volume', 'create', upper]);
      await run(`type=volume,src=${upper},dst=/u`, 'mkdir', '-p', '/u/upper', '/u/work');
      const [l, u] = await mountpoints(lower, upper);
      await runDockerCli(['volume', 'create', ...makeOverlayOpts(l!, u!), over]);
      await run(`type=volume,src=${over},dst=/o`, 'touch', '/o/x');
      return true;
    } catch {
      return false;
    } finally {
      await runDockerCli(['volume', 'rm', '-f', over, upper, lower]).catch(() => '');
    }
  })());

/**
 * Volumes for the checkout at `dir` at every dependency directory, so setup never writes one into the checkout. Where
 * the sandbox setup made one, the volume is an overlay over the sandbox setup's `lower` copy that holds only this checkout's writes, or a
 * copy of it where docker cannot mount overlays; elsewhere it starts empty. `more` names directories beyond the sandbox setup's
 * outputs. With `cache`, one more overlay at `/cache` over that shared volume holds the checkout's own writes, so run
 * code never changes what later runs read; without overlays there is none. Every volume carries this process as its
 * owner, so a sweep finds the ones a dead runner left. The sandbox setup's other outputs are copied into `dir`, where a build may
 * delete and remake them.
 */
export const createSharedMounts = async (
  from: Pick<SandboxSetup, 'image' | 'outputs' | 'lower'>,
  owner: string,
  dir: string,
  more: string[] = [],
  cache = ''
): Promise<SharedMount[]> => {
  const made = from.lower ? from.outputs.filter(o => deps.test(o)) : [];
  const paths = [...new Set([...made, ...more])];
  const rest = from.outputs.filter(o => !deps.test(o));
  const over = (made.length > 0 || Boolean(cache)) && (await overlays(from.image));
  const shared = over && cache ? `agentgraph-layer-${owner}-c` : '';
  if (!paths.length && !rest.length && !shared) return [];
  const label = ['--label', `agentgraph.layer=${startHeartbeat()}`, '--label', `agentgraph.owner=${owner}`];
  const sharedMounts: SharedMount[] = paths.map((o, i) => ({
    name: `agentgraph-layer-${owner}-${i}`,
    dst: `/work/${o}`,
  }));
  const [uid, gid] = user();
  const script = [
    'set -e',
    ...sharedMounts.map((_, i) =>
      i >= made.length
        ? `chown ${uid}:${gid} /u/${i}`
        : over
          ? `mkdir -p /u/${i}/upper /u/${i}/work && chown ${uid}:${gid} /u/${i}/upper`
          : `cp -a /lower/.agentgraph-env/data/${i}/. /u/${i}/ && chown ${uid}:${gid} /u/${i}`
    ),
    ...(shared ? [`mkdir -p /c/upper /c/work && chown ${uid}:${gid} /c/upper`] : []),
    ...rest.map(o => {
      const parent = quote(`/dst/${o.split('/').slice(0, -1).join('/')}`);
      return `mkdir -p ${parent} && cp -a ${quote(`/lower/.agentgraph-env/rest/${o}`)} ${parent}/`;
    }),
  ].join('\n');
  try {
    for (const name of [...sharedMounts.map(l => l.name), ...(shared ? [shared] : [])])
      await runDockerCli(['volume', 'create', ...label, name]);
    await runDockerCli(
      [
        'run',
        ...unlogged,
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
        ...(from.lower && (made.length || rest.length)
          ? ['--mount', `type=volume,src=${from.lower},dst=/lower,readonly`]
          : []),
        ...sharedMounts.flatMap((l, i) => ['--mount', `type=volume,src=${l.name},dst=/u/${i},volume-nocopy`]),
        ...(shared ? ['--mount', `type=volume,src=${shared},dst=/c,volume-nocopy`] : []),
        from.image,
        'sh',
        '-c',
        script,
      ],
      3_600_000
    );
    if (over && made.length) {
      const [lower, ...uppers] = await mountpoints(from.lower!, ...sharedMounts.slice(0, made.length).map(l => l.name));
      for (const [i, upper] of uppers.entries()) {
        const name = `${sharedMounts[i]!.name}-o`;
        await runDockerCli([
          'volume',
          'create',
          ...label,
          '--label',
          `agentgraph.lower=${from.lower!.replace('agentgraph-lower-', '')}`,
          ...makeOverlayOpts(`${lower}/.agentgraph-env/data/${i}`, upper),
          name,
        ]);
        sharedMounts[i] = { ...sharedMounts[i]!, name, upper: sharedMounts[i]!.name };
      }
    }
    if (shared) {
      await runDockerCli(['volume', 'create', cache]);
      const [lower, upper] = await mountpoints(cache, shared);
      await runDockerCli(['volume', 'create', ...label, ...makeOverlayOpts(lower!, upper!), `${shared}-o`]);
      sharedMounts.push({ name: `${shared}-o`, dst: '/cache', upper: shared });
    }
  } catch (e) {
    await discard([...sharedMounts, ...(shared ? [{ name: shared, dst: '' }] : [])]);
    throw e;
  }
  return sharedMounts;
};

/** Files a checkout wrote over the shared cache, from its `/cache` overlay; undefined when it has none. */
export const written = async (sharedMounts: SharedMount[], image: string) => {
  const upper = sharedMounts.find(l => l.dst === '/cache')?.upper;
  if (!upper) return undefined;
  const out = await runDockerCli(
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
      '--mount',
      `type=volume,src=${upper},dst=/u,readonly`,
      image,
      'sh',
      '-c',
      'find /u/upper ! -type d | wc -l',
    ],
    120_000
  ).catch(() => '');
  return out.trim() ? Number(out.trim()) : undefined;
};

/** Removes a checkout's dependency volumes, each overlay before the volume holding its writes. */
export const discard = (sharedMounts: SharedMount[], timeout?: number) =>
  sharedMounts.length
    ? runDockerCli(
        [
          'volume',
          'rm',
          '-f',
          ...sharedMounts.map(l => l.name),
          ...sharedMounts.flatMap(l => (l.upper ? [l.upper] : [])),
        ],
        timeout
      ).then(
        () => undefined,
        () => undefined
      )
    : Promise.resolve();

/** Marks the checkout `dir` as this process's, so a sweep in another runner leaves it alone while this one lives. */
export const writeCheckoutOwner = (dir: string) => {
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(`${dir}.owner`, startHeartbeat());
};

/** Removes the checkouts under `data` whose owner is gone, with their index and news dirs. */
export const reap = (data: string) => {
  const work = join(data, 'work');
  let ids: string[] = [];
  try {
    ids = readdirSync(work).filter(n => !n.endsWith('.owner') && !n.endsWith('.failed'));
  } catch {}
  const gone = ids.filter(id => {
    if (existsSync(join(work, `${id}.failed`))) return false;
    const owner = join(work, `${id}.owner`);
    try {
      return !isOwnerRunning(readFileSync(owner, 'utf8').trim(), statSync(owner).mtimeMs);
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
  (
    await runDockerCli(
      ['volume', 'ls', '--filter', `label=${label}`, '--format', `{{.Name}} {{.Label "${label}"}}`],
      timeout
    )
  )
    .split('\n')
    .filter(Boolean)
    .map(l => l.split(' ') as [string, string]);

/** Removes dependency volumes whose owner is gone; a docker that does not answer within `timeout` ms sweeps nothing. */
export const removeOrphanedVolumes = async (timeout = 600_000) => {
  startHeartbeat();
  const dead = (await volumes('agentgraph.layer', timeout).catch(() => []))
    .filter(([, owner]) => !isOwnerRunning(owner))
    .map(([name]) => name)
    .sort((a, b) => Number(b.endsWith('-o')) - Number(a.endsWith('-o')));
  if (dead.length) await runDockerCli(['volume', 'rm', '-f', ...dead], timeout).catch(() => '');
  return dead.length;
};
