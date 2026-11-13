import { getSha } from './hash.ts';
import { parseJson, readDirOrEmpty, readOrUndefined } from './read.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Schema } from 'effect';
import { basename, dirname, join } from 'node:path';
import { makeHostEnv } from './git.ts';
import { isOwnerRunning, ownerId, readStateDir, startHeartbeat, waitForLock } from './owner.ts';

type SandboxSetup = {
  image: string;
  outputs: string[];
  complete: boolean;
  lower?: string;
  key: string;
  mode: 'deps' | 'tree';
  inputs: string;
  layered?: boolean;
};

type SandboxSetupSpec = {
  repo: string;
  origin: string;
  image: string;
  git: string;
  base: string;
  cache: string;
  setup?: string;
  toolchain?: string;
  trusted: string[];
};

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

export const manifest =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.pnpmfile\.cjs|yarn\.lock|\.yarnrc(\.yml)?|\.npmrc|\.nvmrc|\.node-version|Cargo\.toml|Cargo\.lock|rust-toolchain(\.toml)?)$|^(patches|\.yarn\/(patches|releases))\//;

type Skeleton = { paths: string[]; targets: string[]; digest: string };

const git = (dir: string, ...args: string[]) =>
  new Promise<string>((done, fail) =>
    execFile('git', ['--git-dir', dir, ...args], { env: makeHostEnv(), maxBuffer: 256 << 20 }, (e, out) =>
      e ? fail(e) : done(out.trim())
    )
  );

/** @internal */
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
  const targets = entries
    .map(e => e.path)
    .filter(p => {
      const m =
        /^(.*?)(src\/lib\.rs|src\/main\.rs|build\.rs|(src\/bin|benches|examples|tests)\/[^/]+\.rs|(src\/bin|benches|examples|tests)\/[^/]+\/main\.rs)$/.exec(
          p
        );
      return Boolean(m && crates.has(m[1]!));
    });
  const digest = getSha(JSON.stringify([paths.map(e => `${e.meta} ${e.path}`), targets]));
  return { paths: paths.map(e => e.path), targets, digest };
};

export const readSetupInputKey = async (dir: string, rev: string, mode: SandboxSetup['mode']) =>
  mode === 'deps' ? (await readDependencySkeleton(dir, rev)).digest : git(dir, 'rev-parse', `${rev}^{tree}`);

// UNEXPECTED: yarn 1 does not lock its cache writes, and without this its cache fills the small `/tmp`.
export const packageManagerCacheEnv = {
  npm_config_cache: '/cache/npm',
  npm_config_store_dir: '/cache/pnpm',
  YARN_CACHE_FOLDER: '/cache/yarn',
};

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

const asOperator = () => {
  const [uid, gid] = user();
  return `chown ${uid}:${gid} /work && exec setpriv --reuid=${uid} --regid=${gid} --clear-groups sh -c "$1" sh "$2" "$3" "$4" "$5" "$6" "$7" "$8"`;
};

const build = [
  'set -e',
  'export HOME=/tmp TMPDIR=/tmp GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" AGENTGRAPH_BASE="$2"',
  'cd /work && mkdir .agentgraph-env',
  'out=.agentgraph-env',
  'export GIT_DIR="$1" GIT_WORK_TREE=/work GIT_INDEX_FILE=/tmp/index',
  'git read-tree "$2"',
  'if [ "$5" = deps ]; then',
  '  printf "%s\\n" "$6" | sed "/^$/d" | git checkout-index --stdin',
  '  printf "%s\\n" "$7" | sed "/^$/d" | while read -r f; do',
  '    mkdir -p "$(dirname "$f")"; case "$f" in *lib.rs) : > "$f";; *) echo "fn main() {}" > "$f";; esac',
  '  done',
  'else git checkout-index -a; fi',
  'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
  'if [ -n "$3" ]; then (exec 9>/cache/.toolchain.lock && flock 9 && sh -ec "$3") || exit 97; fi',
  'if [ -n "$4" ]; then RUSTUP_AUTO_INSTALL=0 sh -ec "$4" || exit 98; fi',
  'if [ "$5" = deps ] && [ -d target ]; then',
  '  printf "%s\\n" "$6" | grep "Cargo\\.toml$" | while read -r f; do',
  '    sed -n "/^\\[package\\]/,/^\\[/s/^name *= *\\"\\([^\\"]*\\)\\".*/\\1/p" "$f" | head -1',
  '  done | while read -r n; do RUSTUP_AUTO_INSTALL=0 cargo clean --offline -q -p "$n" || true; done',
  'fi',
  'export GIT_DIR="$1" GIT_WORK_TREE=/work GIT_INDEX_FILE=/tmp/index',
  'git ls-files -o -i --exclude-standard --directory > $out/ignored',
  'git ls-files -o --exclude-standard --directory > $out/untracked',
  '{ echo @@ignored; grep -v "^.agentgraph-env/$" $out/ignored || [ "$?" -eq 1 ];',
  '  echo @@untracked; grep -v "^.agentgraph-env/$" $out/untracked || [ "$?" -eq 1 ]; } > $out/listing',
  'mkdir -p $out/data $out/rest && n=0',
  'sed -n "/^@@ignored$/,/^@@untracked$/p" $out/listing | grep "/$" | while read -r d; do',
  '  case "$d" in node_modules/|*/node_modules/|target/|*/target/) mv "${d%/}" "$out/data/$n" || exit 1; n=$((n + 1));;',
  '    *) mkdir -p "$out/rest/$(dirname "$d")" || exit 1; mv "${d%/}" "$out/rest/${d%/}" || exit 1;; esac',
  'done',
  'find /work -mindepth 1 -maxdepth 1 ! -name .agentgraph-env -exec rm -rf {} +',
  'cat $out/listing',
  'echo @@lower',
  '{ du -sk $out 2>/dev/null || true; } | cut -f1',
].join('\n');

const section = (out: string, name: string) => {
  const text = out.split(`@@${name}\n`)[1];
  if (text === undefined) throw new Error(`env build omitted the ${name} section`);
  return text.split(/^@@/m)[0]!.split('\n').filter(Boolean);
};

export const used = () => join(readStateDir(), 'envs');
const holds = () => join(readStateDir(), 'holds');
const writeTimestampFile = (file: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '', { flag: 'a' });
  utimesSync(file, new Date(), new Date());
};
const touch = (key: string) => {
  writeTimestampFile(join(used(), key));
  startHeartbeat();
  writeTimestampFile(join(holds(), key, ownerId));
};
const holdHours = () => Number(process.env.AGENTGRAPH_ENV_HOLD_HOURS || 2);

export const held = (key: string) => {
  const dir = join(holds(), key);
  return readDirOrEmpty(dir).some(
    o =>
      o !== ownerId && isOwnerRunning(`0:${o}`) && Date.now() - statSync(join(dir, o)).mtimeMs < holdHours() * 3_600_000
  );
};

const makeRepoSlug = (repo: string) =>
  repo
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '') || 'repo';

const ifMissing =
  <T>(value: T) =>
  (e: unknown) =>
    /no such (image|volume)/i.test(String((e as { output?: string }).output ?? e)) ? value : Promise.reject(e);

export const DockerLabels = Schema.NullOr(Schema.Record(Schema.String, Schema.String));

const SetupLabels = Schema.Struct({
  'agentgraph.env': Schema.String,
  'agentgraph.outputs': Schema.fromJsonString(Schema.mutable(Schema.Array(Schema.String))),
  'agentgraph.complete': Schema.Literals(['true', 'false']),
  'agentgraph.mode': Schema.Literals(['deps', 'tree']),
  'agentgraph.inputs': Schema.String,
  'agentgraph.layered': Schema.Literals(['true', 'false']),
});

const labels = async (tag: string) => {
  const out = await runDockerCli(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag]).catch(ifMissing(''));
  if (!out) return undefined;
  const at = `image ${tag} labels`;
  return parseJson(DockerLabels, out, at)?.['agentgraph.env'] ? parseJson(SetupLabels, out, at) : undefined;
};

export const makeSetupVolumeName = (key: string) => `agentgraph-lower-${key}`;

export const makeLayerVolumeName = (key: string) => `${makeSetupVolumeName(key)}-c`;

export const parseSetupVolumeKey = (name: string) => name.slice(makeSetupVolumeName('').length).replace(/-c$/, '');

export const isVolumeName = (name: string) => /^\w[\w.-]*$/.test(name);

const parseSetupLabels = (tag: string, l: typeof SetupLabels.Type): SandboxSetup => ({
  image: tag,
  outputs: l['agentgraph.outputs'],
  complete: l['agentgraph.complete'] === 'true',
  lower: makeSetupVolumeName(l['agentgraph.env']),
  key: l['agentgraph.env'],
  mode: l['agentgraph.mode'],
  inputs: l['agentgraph.inputs'],
  layered: l['agentgraph.layered'] === 'true',
});

const building = new Map<string, Promise<SandboxSetup | 'setup' | undefined>>();

export const envVersion = 7;

const hash = (value: unknown) => getSha(JSON.stringify(value), 24);

export const readSandboxSetup = async (
  spec: SandboxSetupSpec
): Promise<{ cache: string; env?: SandboxSetup | undefined }> => {
  const [tree, files, from, skeleton] = await Promise.all([
    git(spec.git, 'rev-parse', `${spec.base}^{tree}`),
    git(spec.git, 'ls-tree', '--name-only', spec.base),
    runDockerCli(['image', 'inspect', '--format', '{{.Id}}', spec.image]),
    readDependencySkeleton(spec.git, spec.base),
  ]);
  const lines = [...makeToolchainSetupCommands(files.split('\n')), ...(spec.toolchain ? [spec.toolchain] : [])].join(
    '\n'
  );
  if (!isVolumeName(spec.cache)) throw new Error(`volume name not allowed: ${spec.cache}`);
  const slug = makeRepoSlug(spec.repo || basename(spec.origin).replace(/\.git$/, ''));
  const cache = `${spec.cache}-${slug}-${hash([spec.repo || spec.origin, from, lines])}`;
  await createCacheVolume(cache);
  touch(cache);
  if (!lines && !spec.setup) return { cache };
  const untrusted = !(await isReachable(spec.git, spec.base, spec.trusted));
  const family = hash([envVersion, cache, spec.setup ?? '', ...(untrusted ? [spec.base] : [])]);
  const wide = join(readStateDir(), 'tree-only', family);
  const one = async (mode: SandboxSetup['mode']) => {
    const inputs = mode === 'deps' ? skeleton.digest : tree;
    const key = hash([family, mode, inputs]);
    const tag = `agentgraph-env/${slug}:${key}`;
    const pending = building.get(tag);
    if (pending) return pending;
    const made = waitForLock(`env-${key}`).then(release =>
      createSandboxSetup(spec, { key, tag, mode, inputs, lines, skeleton, cache, untrusted }).finally(release)
    );
    building.set(tag, made);
    made.catch(() => building.delete(tag));
    return made;
  };
  if (!existsSync(wide)) {
    const env = await one('deps');
    if (env && env !== 'setup') return { cache, env };
    writeTimestampFile(wide);
  }
  const env = await one('tree');
  return { cache, env: env === 'setup' ? undefined : env };
};

const createCacheVolume = (name: string) =>
  runDockerCli(['volume', 'create', '--label', `agentgraph.cache=${name}`, name]);

const createSandboxSetup = async (
  spec: SandboxSetupSpec,
  b: {
    key: string;
    tag: string;
    mode: SandboxSetup['mode'];
    inputs: string;
    lines: string;
    skeleton: Skeleton;
    cache: string;
    untrusted: boolean;
  }
): Promise<SandboxSetup | 'setup' | undefined> => {
  const { key, tag, mode } = b;
  const found = await labels(tag);
  const env = found && parseSetupLabels(tag, found);
  const lower = makeSetupVolumeName(key);
  if (
    env &&
    (await runDockerCli(['volume', 'inspect', lower, ...(env.layered ? [makeLayerVolumeName(key)] : [])]).then(
      () => true,
      ifMissing(false)
    ))
  )
    return (touch(key), env);
  if (await isOverlaid(key)) throw new Error(`environment ${key} is incomplete while a live checkout reads it`);
  if (env) await runDockerCli(['rmi', '-f', tag]).catch(() => '');
  const name = `agentgraph-envbuild-${key}`;
  const clear = () => runDockerCli(['volume', 'rm', '-f', lower, makeLayerVolumeName(key)]).catch(() => '');
  await runDockerCli(['rm', '-f', name]).catch(() => '');
  await clear();
  await runDockerCli(['volume', 'create', '--label', `agentgraph.lower=${key}`, lower]);
  let release: (() => void) | undefined = await waitForLock(`cache-${b.cache}`);
  let layer = '';
  let failed = true;
  try {
    if (b.untrusted || (await isOverlaid(b.cache))) {
      layer = await createBuildLayer(spec.image, b.cache, key);
      release();
      release = undefined;
    }
    const started = Date.now();
    const out = await runDockerCli(
      [
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
        '--mount',
        `type=volume,src=${layer || b.cache},dst=/cache`,
        ...Object.entries(packageManagerCacheEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        '--mount',
        `type=volume,src=${lower},dst=/work`,
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
        mode === 'deps' ? b.skeleton.targets.join('\n') : '',
      ],
      7_200_000
    ).then(
      output => ({ code: 0, output }),
      (e: { code?: number; output?: string; message: string }) => ({
        code: typeof e.code === 'number' ? e.code : -1,
        output: e.output ?? e.message,
      })
    );
    if (out.code === 97 && mode === 'tree') throw new Error(`toolchain exited: ${out.output.trim().slice(-2000)}`);
    if (out.code === 97 || out.code === 98) return mode === 'deps' ? undefined : 'setup';
    if (out.code !== 0) throw new Error(`env build exited ${out.code}: ${out.output.trim().slice(-2000)}`);
    const ignored = section(out.output, 'ignored');
    const outputs = ignored.filter(p => p.endsWith('/')).map(p => p.slice(0, -1));
    const complete = outputs.length === ignored.length && !section(out.output, 'untracked').length;
    const made: SandboxSetup = { image: tag, outputs, complete, lower, key, mode, inputs: b.inputs, layered: !!layer };
    const kb = Number(section(out.output, 'lower')[0]);
    if (!Number.isFinite(kb) || kb < 0) throw new Error('env build omitted its size');
    await runDockerCli([
      'commit',
      '--change',
      `LABEL agentgraph.env=${key} agentgraph.cache=${b.cache} agentgraph.layered=${!!layer} agentgraph.version=${envVersion} agentgraph.lowerkb=${kb} agentgraph.complete=${complete} agentgraph.mode=${mode} agentgraph.inputs=${b.inputs} agentgraph.outputs=${JSON.stringify(JSON.stringify(outputs))}`,
      name,
      tag,
    ]);
    touch(key);
    failed = false;
    console.error(
      `env ${tag} built in ${Math.round((Date.now() - started) / 1000)}s from the ${mode === 'deps' ? 'skeleton' : 'whole tree'}`
    );
    return made;
  } finally {
    await runDockerCli(['rm', '-f', name]).catch(() => '');
    if (layer) await discard([{ name: layer, dst: '' }]);
    if (failed) await clear();
    release?.();
  }
};

const isReachable = async (dir: string, base: string, from: string[]) =>
  (
    await Promise.all(
      from.map(ref =>
        git(dir, 'merge-base', '--is-ancestor', base, ref).then(
          () => true,
          () => false
        )
      )
    )
  ).includes(true);

export const parseDockerLabels = (text = '') =>
  Object.fromEntries(
    text
      .split(',')
      .filter(Boolean)
      .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
  ) as Record<string, string>;

export const isLiveOverlay = (labels: Record<string, string>, lower: string) =>
  (labels['agentgraph.lower'] === lower || labels['agentgraph.env'] === lower) &&
  Boolean(labels['agentgraph.layer']) &&
  isOwnerRunning(labels['agentgraph.layer']!);

const isOverlaid = async (lower: string) =>
  (
    await Promise.all(
      ['lower', 'env'].map(label =>
        runDockerCli(['volume', 'ls', '--filter', `label=agentgraph.${label}=${lower}`, '--format', '{{.Labels}}'])
      )
    )
  )
    .join('\n')
    .split('\n')
    .some(l => isLiveOverlay(parseDockerLabels(l), lower));

const runAsRoot = (image: string, mounts: string[], script: string, timeout?: number) =>
  runDockerCli(
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
      ...mounts.flatMap(m => ['--mount', m]),
      image,
      'sh',
      '-c',
      script,
    ],
    timeout
  );

const createBuildLayer = async (image: string, cache: string, key: string) => {
  if (!(await overlays(image))) throw new Error('an untrusted environment build needs docker overlay volumes');
  const own = makeLayerVolumeName(key);
  const [uid, gid] = user();
  await runDockerCli(['volume', 'create', '--label', `agentgraph.lower=${key}`, own]);
  await runAsRoot(image, [`type=volume,src=${own},dst=/c`], `mkdir /c/upper /c/work && chown ${uid}:${gid} /c/upper`);
  const [c, o] = await mountpoints(cache, own);
  const name = `agentgraph-envbuild-${key}-c`;
  await runDockerCli(['volume', 'rm', '-f', name]).catch(() => '');
  await runDockerCli([
    'volume',
    'create',
    '--label',
    `agentgraph.layer=${startHeartbeat()}`,
    '--label',
    `agentgraph.lower=${cache}`,
    '--label',
    `agentgraph.env=${key}`,
    ...makeOverlayOpts(c!, o!),
    name,
  ]);
  return name;
};

export type SharedMount = { name: string; dst: string; upper?: string };

const deps = /(^|\/)(node_modules|target)$/;

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
const overlays = (image: string) =>
  (overlay ??= (async () => {
    const [lower, upper, over] = ['l', 'u', 'o'].map(s => `agentgraph-probe-${ownerId}-${s}`) as [
      string,
      string,
      string,
    ];
    try {
      await runDockerCli(['volume', 'create', lower]);
      await runDockerCli(['volume', 'create', upper]);
      await runAsRoot(image, [`type=volume,src=${upper},dst=/u`], 'mkdir -p /u/upper /u/work');
      const [l, u] = await mountpoints(lower, upper);
      await runDockerCli(['volume', 'create', ...makeOverlayOpts(l!, u!), over]);
      await runAsRoot(image, [`type=volume,src=${over},dst=/o`], 'touch /o/x');
      return true;
    } catch {
      return false;
    } finally {
      await runDockerCli(['volume', 'rm', '-f', over, upper, lower]).catch(() => '');
    }
  })());

export const createSharedMounts = async (
  from: Pick<SandboxSetup, 'image' | 'outputs' | 'lower' | 'layered'>,
  owner: string,
  dir: string,
  more: string[] = [],
  cache = ''
): Promise<SharedMount[]> => {
  const key = from.lower && parseSetupVolumeKey(from.lower);
  const made = from.lower ? from.outputs.filter(o => deps.test(o)) : [];
  const paths = [...new Set([...made, ...more])];
  const rest = from.outputs.filter(o => !deps.test(o));
  const over = (made.length > 0 || Boolean(cache)) && (await overlays(from.image));
  if (from.layered && cache && !over) throw new Error('a layered environment needs docker overlay volumes');
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
    ...(over && made.length
      ? [
          `for p in /lower/.agentgraph-env /lower/.agentgraph-env/data ${made.map((_, i) => `/lower/.agentgraph-env/data/${i}`).join(' ')}; do [ -d "$p" ] && [ ! -L "$p" ] || { echo "not a directory: $p" >&2; exit 1; }; done`,
        ]
      : []),
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
    await runAsRoot(
      from.image,
      [
        `type=bind,src=${dir},dst=/dst`,
        ...(from.lower && (made.length || rest.length) ? [`type=volume,src=${from.lower},dst=/lower,readonly`] : []),
        ...sharedMounts.map((l, i) => `type=volume,src=${l.name},dst=/u/${i},volume-nocopy`),
        ...(shared ? [`type=volume,src=${shared},dst=/c,volume-nocopy`] : []),
      ],
      script,
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
          `agentgraph.lower=${key}`,
          ...makeOverlayOpts(`${lower}/.agentgraph-env/data/${i}`, upper),
          name,
        ]);
        sharedMounts[i] = { ...sharedMounts[i]!, name, upper: sharedMounts[i]!.name };
      }
    }
    if (shared) {
      const [lower, upper, layer] = await mountpoints(
        cache,
        shared,
        ...(from.layered && key ? [makeLayerVolumeName(key)] : [])
      );
      const release = await waitForLock(`cache-${cache}`);
      await runDockerCli([
        'volume',
        'create',
        ...label,
        '--label',
        `agentgraph.lower=${cache}`,
        ...(layer && key ? ['--label', `agentgraph.env=${key}`] : []),
        ...makeOverlayOpts(layer ? `${layer}/upper:${lower}` : lower!, upper!),
        `${shared}-o`,
      ]).finally(release);
      sharedMounts.push({ name: `${shared}-o`, dst: '/cache', upper: shared });
    }
  } catch (e) {
    await discard([...sharedMounts, ...(shared ? [{ name: shared, dst: '' }] : [])]);
    throw e;
  }
  return sharedMounts;
};

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

export const writeCheckoutOwner = (dir: string) => {
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(`${dir}.owner`, startHeartbeat());
};

export const getCachePath = (data: string, ...parts: string[]) => join(data, 'cache', ...parts);

export const getCheckoutPaths = (data: string, id: string) => {
  const dir = getCachePath(data, 'work', id);
  return {
    dir,
    owner: `${dir}.owner`,
    index: getCachePath(data, 'index', id),
    news: getCachePath(data, 'news', id),
    scratch: getCachePath(data, 'scratch', id),
  };
};

export const findDeadCheckouts = (data: string) => {
  const work = getCachePath(data, 'work');
  const ids = readDirOrEmpty(work).filter(n => !n.endsWith('.owner') && !n.endsWith('.failed'));
  return ids.filter(id => {
    if (existsSync(join(work, `${id}.failed`))) return false;
    const owner = join(work, `${id}.owner`);
    try {
      return !isOwnerRunning(readFileSync(owner, 'utf8').trim(), statSync(owner).mtimeMs);
    } catch (e) {
      return readOrUndefined(e) ?? true;
    }
  });
};

export const removeCheckout = (data: string, id: string) =>
  Promise.all(
    Object.values(getCheckoutPaths(data, id)).map(p =>
      rm(p, { recursive: true, force: true }).catch(e => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e;
      })
    )
  );

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

export const removeOrphanedVolumes = async (timeout = 600_000) => {
  startHeartbeat();
  const dead = (await volumes('agentgraph.layer', timeout))
    .filter(([, owner]) => !isOwnerRunning(owner))
    .map(([name]) => name)
    .sort((a, b) => Number(b.endsWith('-o')) - Number(a.endsWith('-o')));
  if (dead.length) await runDockerCli(['volume', 'rm', '-f', ...dead], timeout);
  return dead.length;
};
