import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from './mcp-config.ts';
import type { RunSpec } from './types.ts';

/** The internal docker network every run container joins; it has no route out except the proxies on it. */
export const sandboxNetwork = 'bothub-sandbox';

/** The network a hub with `network: open` adds, for a route out without the egress proxy. */
const openNetwork = 'bothub-open';

/** A sandbox that is misconfigured or unavailable. Runs fail with it instead of falling back to the host. */
export class SandboxError extends Error {
  readonly code = 'ESANDBOX';
}

const checks: Record<string, [RegExp, string]> = {
  BOTHUB_SANDBOX_IMAGE: [/^[a-z0-9][a-z0-9._/:@-]*$/i, 'an image reference'],
  BOTHUB_SANDBOX_MEMORY: [/^[1-9][0-9]*[kmg]?$/i, 'a positive size such as 4g'],
  BOTHUB_SANDBOX_CPUS: [/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/, 'a positive number'],
  BOTHUB_SANDBOX_PIDS: [/^[1-9][0-9]*$/, 'a positive integer'],
};

/**
 * The run container settings. Image and resource limits can be set from the environment; the network and every
 * isolation flag cannot.
 * @throws SandboxError on any value it does not accept.
 */
export const sandboxConfig = (env: Record<string, string | undefined> = process.env) => {
  const reject = (message: string) => {
    throw new SandboxError(message);
  };
  for (const [key, [pattern, what]] of Object.entries(checks)) {
    const value = env[key];
    if (value !== undefined && !pattern.test(value)) reject(`${key}="${value}" is not ${what}`);
  }
  return {
    image: env.BOTHUB_SANDBOX_IMAGE ?? 'bothub-sandbox:local',
    llmUrl: env.BOTHUB_SANDBOX_LLM_URL ?? 'http://litellm:4000/v1',
    memory: env.BOTHUB_SANDBOX_MEMORY ?? '4g',
    cpus: env.BOTHUB_SANDBOX_CPUS ?? '1.5',
    pids: env.BOTHUB_SANDBOX_PIDS ?? '512',
  };
};

export type Mount = { src: string; dst: string; readonly?: boolean };

/** What a hub changes in its run containers: the image and limits, extra env, an open network and a cache directory. */
export type Box = {
  config?: Partial<Pick<ReturnType<typeof sandboxConfig>, 'image' | 'memory' | 'cpus'>>;
  env?: Record<string, string>;
  open?: boolean;
  cache?: string;
};

/** Fixed paths inside a run container. */
export const inside = {
  work: '/work',
  home: '/home/agent',
  tmp: '/tmp',
  hub: '/hub',
  data: '/data',
  bothub: '/opt/bothub',
  cache: '/cache',
};

const proxy = 'http://egress:8888';
const direct = 'litellm,ollama.internal,localhost,127.0.0.1';

/**
 * The environment every run container starts with: the allowlisted egress proxy unless the network is `open`, the
 * decision API relay, and npm and git settings.
 */
export const containerEnv = (
  env: Record<string, string | undefined> = process.env,
  open = false
): Record<string, string> => ({
  TMPDIR: inside.tmp,
  ...(!open && {
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: direct,
    no_proxy: direct,
  }),
  BOTHUB_DECIDE_URL: 'http://ollama.internal:11434',
  BOTHUB_DECIDE_MODEL: env.BOTHUB_DECIDE_MODEL ?? 'tev1:0.8b',
  npm_config_update_notifier: 'false',
  npm_config_include: 'dev',
  npm_config_logs_dir: join(inside.tmp, 'npm-logs'),
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
});

const forbidden = ['/', '/run', '/var/run'];

const bind = ({ src, dst, readonly }: Mount) => {
  if (/[,\n"]/.test(src + dst)) throw new SandboxError(`mount path not allowed: ${src}`);
  if (forbidden.includes(src) || forbidden.includes(dst) || /docker\.sock$/.test(src))
    throw new SandboxError(`mount not allowed: ${src} at ${dst}`);
  return ['--mount', `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`];
};

const hostUser = () => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

/**
 * `docker run` for one command in a hardened, throwaway container: read-only root, tmpfs `/tmp` (executable, since
 * tools run what they build there), the host user (never root), no capabilities, no new privileges, resource
 * limits, the internal network and no image pulls. The worktree is `/work` and the working directory, read-only with
 * `readonly`; `home` is mounted as `/home/agent` when given; `stdin` keeps stdin open. `env` is set in argv; `secrets`
 * are passed by name only, so their values come from the docker client's environment (the returned `env`) and never
 * appear in argv. `open` adds a network with a route out; `cache` is a host directory mounted read-write at `/cache`
 * and named by `BOTHUB_CACHE`.
 * @throws SandboxError for a root user or a mount of `/`, `/run`, `/var/run` or a docker socket.
 */
export const dockerRun = ({
  name,
  worktree,
  home,
  mounts = [],
  env,
  secrets = {},
  cmd,
  args,
  config = sandboxConfig(),
  user = hostUser(),
  stdin = false,
  readonly = false,
  open = false,
  cache,
}: {
  name: string;
  worktree: string;
  home?: string | undefined;
  mounts?: Mount[];
  env: Record<string, string>;
  secrets?: Record<string, string>;
  cmd: string;
  args: string[];
  config?: ReturnType<typeof sandboxConfig>;
  user?: string;
  stdin?: boolean;
  readonly?: boolean;
  open?: boolean;
  cache?: string | undefined;
}) => {
  if (!/^[1-9][0-9]*:[0-9]+$/.test(user)) throw new SandboxError(`refusing to run a container as user "${user}"`);
  return {
    cmd: 'docker',
    args: [
      'run',
      '--rm',
      ...(stdin ? ['-i'] : []),
      '--init',
      '--pull',
      'never',
      '--name',
      name,
      '--network',
      sandboxNetwork,
      ...(open ? ['--network', openNetwork] : []),
      '--read-only',
      '--tmpfs',
      `${inside.tmp}:rw,exec,nosuid,nodev,size=1g`,
      '--user',
      user,
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--memory',
      config.memory,
      '--memory-swap',
      config.memory,
      '--cpus',
      config.cpus,
      '--pids-limit',
      config.pids,
      ...bind({ src: worktree, dst: inside.work, readonly }),
      ...(home ? bind({ src: home, dst: inside.home }) : []),
      ...(cache ? bind({ src: cache, dst: inside.cache }) : []),
      ...mounts.flatMap(bind),
      '--workdir',
      inside.work,
      ...Object.entries({ ...env, ...(cache && { BOTHUB_CACHE: inside.cache }) }).flatMap(([key, value]) => [
        '-e',
        `${key}=${value}`,
      ]),
      ...Object.keys(secrets).flatMap(key => ['-e', key]),
      config.image,
      cmd,
      ...args,
    ],
    env: secrets,
  };
};

/**
 * Runs the docker client and resolves its trimmed stdout.
 * @throws SandboxError with the end of its stderr.
 */
export const docker = (args: string[], timeout = 30_000) =>
  new Promise<string>((done, fail) =>
    execFile('docker', args, { timeout, maxBuffer: 64 << 20 }, (error, stdout, stderr) =>
      error
        ? fail(new SandboxError(`docker ${args[0]} ${args[1]}: ${(stderr || error.message).trim().slice(-2000)}`))
        : done(stdout.trim())
    )
  );

/**
 * Checks that docker answers, the sandbox network exists and is internal, and the image is present. With `open`, creates
 * the open network when it is missing.
 * @throws SandboxError naming what is missing.
 */
export const sandboxReady = async (config = sandboxConfig(), open = false) => {
  const internal = await docker(['network', 'inspect', '--format', '{{.Internal}}', sandboxNetwork]);
  if (internal !== 'true') throw new SandboxError(`the ${sandboxNetwork} network is not internal`);
  await docker(['image', 'inspect', '--format', '{{.Id}}', config.image]);
  if (open)
    await docker(['network', 'inspect', openNetwork])
      .catch(() => docker(['network', 'create', openNetwork]))
      .catch(() => docker(['network', 'inspect', openNetwork]));
};

/**
 * A worktree's `.git` file points at its admin dir inside the bare mirror. The mirror is mounted read-only at its
 * host path and the admin dir read-write unless `readonly`, so git works in `/work` while refs and objects stay
 * untouchable.
 */
export const gitMounts = async (worktree: string, readonly = false): Promise<Mount[]> => {
  const dirs = await gitDirs(worktree);
  if (!dirs) return [];
  return [
    { src: dirs.common, dst: dirs.common, readonly: true },
    { src: dirs.admin, dst: dirs.admin, ...(readonly && { readonly }) },
  ];
};

/** A worktree's admin dir and the repository dir it shares, or `undefined` when it is not a linked worktree. */
export const gitDirs = async (worktree: string) => {
  const dotGit = await readFile(join(worktree, '.git'), 'utf8').catch(() => undefined);
  const gitdir = dotGit && /^gitdir: (.+)$/m.exec(dotGit)?.[1]?.trim();
  if (!gitdir) return;
  const admin = resolve(worktree, gitdir);
  const common = resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8').catch(() => '../..')).trim());
  return { admin, common };
};

/**
 * The file in a worktree's admin dir naming the installed dependencies its dirs link to: the install on the first
 * line, then one line per dir.
 */
export const depsMarker = 'bothub-deps';

/**
 * The installed dependencies a worktree links to, mounted read-only at their own path so the links resolve. In a
 * `readonly` worktree its dependency dirs stay writable, since tools keep their caches there.
 */
export const depsMounts = async (worktree: string, readonly = false): Promise<Mount[]> => {
  const dirs = await gitDirs(worktree);
  const marker = dirs ? await readFile(join(dirs.admin, depsMarker), 'utf8').catch(() => '') : '';
  const [entry, ...linked] = marker.split('\n').filter(Boolean);
  if (!entry) return [];
  const scratch = readonly ? linked.map(dir => ({ src: join(worktree, dir), dst: join(inside.work, dir) })) : [];
  return [{ src: entry, dst: entry, readonly: true }, ...scratch];
};

const bothubRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/** Only the code bothub needs to run: never the package root, which can hold local secrets. */
const bothubMounts: Mount[] = ['bin', 'src', 'node_modules', 'package.json'].map(part => ({
  src: join(bothubRoot, part),
  dst: join(inside.bothub, part),
  readonly: true,
}));

const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

/**
 * The bothub MCP server as it runs inside a container: the image's `node` on read-only mounts of bothub's code, the
 * hub (`/hub`) and the run store (`/data/runs`). The rest of the data directory, with its secrets, stays outside.
 */
export const mcpInside = (server: McpServer): { server: McpServer; mounts: Mount[] } => {
  const dir = flag(server.args, '--dir');
  const data = flag(server.args, '--data');
  const swap: [string, string][] = [
    [bothubRoot, inside.bothub],
    ...(dir ? [[dir, inside.hub] as [string, string]] : []),
    ...(data ? [[data, inside.data] as [string, string]] : []),
  ];
  const map = (arg: string) => {
    const hit = swap.find(([from]) => arg === from || arg.startsWith(`${from}/`));
    return hit ? hit[1] + arg.slice(hit[0].length) : arg;
  };
  return {
    server: { ...server, command: 'node', args: server.args.map(map) },
    mounts: [
      ...(dir ? [{ src: dir, dst: inside.hub, readonly: true }] : []),
      ...(data ? [{ src: join(data, 'runs'), dst: join(inside.data, 'runs'), readonly: true }] : []),
    ],
  };
};

/**
 * A run spec as the harness sees it inside a container: `/work` as cwd, the MCP server and the surfacer rewritten for
 * their mounts, plus read-only mounts of bothub's code for the server and harness extensions. The surfacer gets the
 * same read-only hub and run store mounts as the MCP server.
 */
export const specInside = (spec: RunSpec): { spec: RunSpec; mounts: Mount[] } => {
  const mcp = spec.mcp && mcpInside(spec.mcp);
  const surfacer = spec.surfacer && { ...spec.surfacer, hub: inside.hub, data: inside.data };
  const mounts = [
    ...bothubMounts,
    ...(mcp?.mounts ?? []),
    ...(spec.surfacer
      ? [
          { src: spec.surfacer.hub, dst: inside.hub, readonly: true },
          { src: join(spec.surfacer.data, 'runs'), dst: join(inside.data, 'runs'), readonly: true },
        ]
      : []),
  ];
  return {
    spec: { ...spec, cwd: inside.work, ...(mcp && { mcp: mcp.server }), ...(surfacer && { surfacer }) },
    mounts: mounts.filter((m, i) => mounts.findIndex(n => n.dst === m.dst) === i),
  };
};

/** A path into bothub's own code mapped to where it is mounted, for harness args that point at it. */
export const bothubArg = (arg: string) =>
  arg.startsWith(`${bothubRoot}/`) ? inside.bothub + arg.slice(bothubRoot.length) : arg;

/** Every quoted path into bothub's own code in a JSON text mapped to where it is mounted, for inline harness config. */
export const bothubPaths = (json: string) => json.replaceAll(`"${bothubRoot}/`, `"${inside.bothub}/`);

/** A unique container name for a run or script. */
export const containerName = (id: string) =>
  `bothub-${id.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
