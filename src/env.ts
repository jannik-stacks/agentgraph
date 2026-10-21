import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A repo's environment at one base: an image holding the base files plus what the toolchain step and setup made of
 * them. `outputs` are the ignored directories setup made, relative to the checkout root; `complete` says they are
 * everything setup left behind, so a checkout of the same files needs no setup.
 */
export type Env = { image: string; outputs: string[]; complete: boolean };

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
  return `mkdir -p /work && chown ${uid}:${gid} /work && exec setpriv --reuid=${uid} --regid=${gid} --clear-groups sh -c "$1" sh "$2" "$3" "$4" "$5"`;
};

/** Base files into `/work`, the toolchain under the cache lock, setup, then the directories git does not track. */
const build = [
  'set -e',
  'export HOME=/tmp TMPDIR=/tmp GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" BOTHUB_BASE="$2"',
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
].join('\n');

const section = (out: string, name: string) =>
  (out.split(`@@${name}\n`)[1] ?? '').split(/\n@@/)[0]!.split('\n').filter(Boolean);

const used = () => join(homedir(), '.cache', 'bothub', 'envs');
const touch = (key: string) => {
  try {
    mkdirSync(used(), { recursive: true });
    const file = join(used(), key);
    writeFileSync(file, '', { flag: 'a' });
    utimesSync(file, new Date(), new Date());
  } catch {}
};

const tagOf = (repo: string, key: string) =>
  `bothub-env/${
    repo
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '') || 'repo'
  }:${key}`;

const labels = async (tag: string) => {
  const out = await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag]).catch(() => '');
  const l = out ? (JSON.parse(out) as Record<string, string> | null) : null;
  return l?.['bothub.env'] ? l : undefined;
};

const envOfLabels = (tag: string, l: Record<string, string>): Env => ({
  image: tag,
  outputs: JSON.parse(l['bothub.outputs'] ?? '[]') as string[],
  complete: l['bothub.complete'] === 'true',
});

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
    .update(JSON.stringify([2, from, tree, lines, spec.setup ?? '']))
    .digest('hex')
    .slice(0, 24);
  const tag = tagOf(spec.repo, key);
  const pending = building.get(tag);
  if (pending) return pending;
  const made = (async () => {
    for (;;) {
      const found = await labels(tag);
      if (found) return (touch(key), envOfLabels(tag, found));
      const name = `bothub-envbuild-${key}`;
      const started = Date.now();
      const args = [
        'run',
        '--init',
        '--pull',
        'never',
        '--name',
        name,
        '--label',
        'bothub.envbuild=1',
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
      try {
        if (out.code === 97) throw new Error(`toolchain exited: ${out.output.trim().slice(-2000)}`);
        if (out.code === 98) return undefined;
        if (out.code !== 0) throw new Error(`env build exited ${out.code}: ${out.output.trim().slice(-2000)}`);
        const ignored = section(out.output, 'ignored');
        const outputs = ignored.filter(p => p.endsWith('/')).map(p => p.slice(0, -1));
        const complete = outputs.length === ignored.length && !section(out.output, 'untracked').length;
        const env = { image: tag, outputs, complete };
        await docker([
          'commit',
          '--change',
          `LABEL bothub.env=${key} bothub.complete=${complete} bothub.outputs=${JSON.stringify(JSON.stringify(outputs))}`,
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

/** A seed: a named volume that holds a copy of the Env's output at `dst`. */
export type Seed = { name: string; dst: string };

/** Dependency directories, which setup fills and rarely deletes, so a volume can sit at their path. */
const deps = /(^|\/)(node_modules|target)$/;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Copies the Env's outputs for the checkout at `dir`: dependency directories into fresh volumes for `owner`,
 * labelled with this process so a sweep finds the ones a dead process left, and the rest into `dir`, where a build
 * may delete and remake them.
 */
export const seed = async (env: Env, owner: string, dir: string): Promise<Seed[]> => {
  const seeds = env.outputs
    .filter(o => deps.test(o))
    .map((o, i) => ({ name: `bothub-seed-${owner}-${i}`, dst: `/work/${o}` }));
  const rest = env.outputs.filter(o => !deps.test(o));
  if (!env.outputs.length) return seeds;
  for (const s of seeds)
    await docker([
      'volume',
      'create',
      '--label',
      `bothub.seed=${process.pid}`,
      '--label',
      `bothub.owner=${owner}`,
      s.name,
    ]);
  const [uid, gid] = user();
  const script = [
    'set -e',
    ...seeds.map((s, i) => `cp -a ${quote(`${s.dst}/.`)} /seed/${i}/ && chown ${uid}:${gid} /seed/${i}`),
    ...rest.map(o => {
      const parent = quote(`/dst/${o.split('/').slice(0, -1).join('/')}`);
      return `mkdir -p ${parent} && cp -a ${quote(`/work/${o}`)} ${parent}/`;
    }),
  ].join('\n');
  try {
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
        ...seeds.flatMap((s, i) => ['--mount', `type=volume,src=${s.name},dst=/seed/${i},volume-nocopy`]),
        env.image,
        'sh',
        '-c',
        script,
      ],
      3_600_000
    );
  } catch (e) {
    await drop(seeds);
    throw e;
  }
  return seeds;
};

export const drop = (seeds: Seed[]) =>
  seeds.length
    ? docker(['volume', 'rm', '-f', ...seeds.map(s => s.name)]).then(
        () => undefined,
        () => undefined
      )
    : Promise.resolve();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Removes seeds whose process is gone. Docker refuses volumes a container still uses. */
export const sweep = async () => {
  const out = await docker([
    'volume',
    'ls',
    '--filter',
    'label=bothub.seed',
    '--format',
    '{{.Name}} {{.Label "bothub.seed"}}',
  ]).catch(() => '');
  const dead = out
    .split('\n')
    .map(l => l.split(' '))
    .filter(([name, pid]) => name && Number(pid) && !alive(Number(pid)))
    .map(([name]) => ({ name: name!, dst: '' }));
  await drop(dead);
  return dead.length;
};

/** Env images with the time each was last used, the oldest first. */
export const envs = async () => {
  const out = await docker([
    'image',
    'ls',
    '--filter',
    'label=bothub.env',
    '--format',
    '{{.Repository}}:{{.Tag}} {{.Size}}',
  ]).catch(() => '');
  const times = new Map<string, number>();
  try {
    for (const key of readdirSync(used())) times.set(key, statSync(join(used(), key)).mtimeMs);
  } catch {}
  return out
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [image = '', size = ''] = l.split(' ');
      return { image, size, used: times.get(image.split(':')[1] ?? '') ?? 0 };
    })
    .sort((a, b) => a.used - b.used);
};

/** Removes Env images unused for `days`; docker keeps any a container still uses. */
export const prune = async (days: number, dry = false) => {
  const old = (await envs()).filter(e => e.used < Date.now() - days * 86_400_000);
  const removed: string[] = [];
  for (const e of old)
    if (
      dry ||
      (await docker(['rmi', e.image]).then(
        () => true,
        () => false
      ))
    )
      removed.push(e.image);
  return removed;
};

export const ownerId = () => randomBytes(6).toString('hex');
