import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from './mcp-config.ts';
import type { RunSpec } from './types.ts';

/** Where a harness runs: directly on this machine, or in a throwaway container per run. */
export type Sandbox = 'host' | 'docker';

/** The sandbox chosen by `BOTHUB_SANDBOX`; anything but `docker` means the host. */
export const sandboxFrom = (env: Record<string, string | undefined> = process.env): Sandbox =>
  env.BOTHUB_SANDBOX === 'docker' ? 'docker' : 'host';

export type Mount = { src: string; dst: string; readonly?: boolean };

/** Fixed paths inside a run container. */
export const inside = {
  work: '/work',
  home: '/home/agent',
  tmp: '/tmp',
  hub: '/hub',
  data: '/data',
  bothub: '/opt/bothub',
};

/** Container defaults, each overridable from the environment. */
export const sandboxDefaults = (env: Record<string, string | undefined> = process.env) => ({
  image: env.BOTHUB_SANDBOX_IMAGE ?? 'bothub-sandbox:local',
  network: env.BOTHUB_SANDBOX_NETWORK ?? 'bothub-sandbox',
  llmUrl: env.BOTHUB_SANDBOX_LLM_URL ?? 'http://litellm:4000/v1',
  memory: env.BOTHUB_SANDBOX_MEMORY ?? '2g',
  cpus: env.BOTHUB_SANDBOX_CPUS ?? '1.5',
  pids: env.BOTHUB_SANDBOX_PIDS ?? '512',
});

const proxy = 'http://egress:8888';
const direct = 'litellm,ollama-relay,localhost,127.0.0.1';

/**
 * The environment every run container starts with: the allowlisted egress proxy, the decision API relay, and npm
 * and git settings.
 */
export const containerEnv = (env: Record<string, string | undefined> = process.env): Record<string, string> => ({
  TMPDIR: inside.tmp,
  HTTPS_PROXY: proxy,
  HTTP_PROXY: proxy,
  https_proxy: proxy,
  http_proxy: proxy,
  NO_PROXY: direct,
  no_proxy: direct,
  BOTHUB_DECIDE_URL: 'http://ollama-relay:11434',
  BOTHUB_DECIDE_MODEL: env.BOTHUB_DECIDE_MODEL ?? 'tev1:0.8b',
  npm_config_update_notifier: 'false',
  npm_config_include: 'dev',
  npm_config_logs_dir: join(inside.tmp, 'npm-logs'),
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
});

const bind = ({ src, dst, readonly }: Mount) => [
  '--mount',
  `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`,
];

/**
 * `docker run` for one command in a hardened, throwaway container: read-only root, tmpfs `/tmp`, the host user, no
 * capabilities, resource limits and the internal network. The worktree is `/work` and the working directory; `home`
 * is mounted as `/home/agent` when given. `env` is set in argv; `secrets` are passed by name only, so their values
 * come from the docker client's environment (the returned `env`) and never appear in argv.
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
  defaults = sandboxDefaults(),
  user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
}: {
  name: string;
  worktree: string;
  home?: string | undefined;
  mounts?: Mount[];
  env: Record<string, string>;
  secrets?: Record<string, string>;
  cmd: string;
  args: string[];
  defaults?: ReturnType<typeof sandboxDefaults>;
  user?: string;
}) => ({
  cmd: 'docker',
  args: [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    '--network',
    defaults.network,
    '--read-only',
    '--tmpfs',
    `${inside.tmp}:rw,nosuid,nodev,size=1g`,
    '--user',
    user,
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--memory',
    defaults.memory,
    '--memory-swap',
    defaults.memory,
    '--cpus',
    defaults.cpus,
    '--pids-limit',
    defaults.pids,
    ...bind({ src: worktree, dst: inside.work }),
    ...(home ? bind({ src: home, dst: inside.home }) : []),
    ...mounts.flatMap(bind),
    '--workdir',
    inside.work,
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...Object.keys(secrets).flatMap(key => ['-e', key]),
    defaults.image,
    cmd,
    ...args,
  ],
  env: secrets,
});

/**
 * A worktree's `.git` file points at its admin dir inside the bare mirror. The mirror is mounted read-only at its
 * host path and only the admin dir read-write, so git works in `/work` while refs and objects stay untouchable.
 */
export const gitMounts = async (worktree: string): Promise<Mount[]> => {
  const dotGit = await readFile(join(worktree, '.git'), 'utf8').catch(() => undefined);
  const gitdir = dotGit && /^gitdir: (.+)$/m.exec(dotGit)?.[1]?.trim();
  if (!gitdir) return [];
  const admin = resolve(worktree, gitdir);
  const common = resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8').catch(() => '../..')).trim());
  return [
    { src: common, dst: common, readonly: true },
    { src: admin, dst: admin },
  ];
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
 * A run spec as the harness sees it inside a container: `/work` as cwd and the MCP server rewritten for its mounts,
 * plus read-only mounts of bothub's code for the server and harness extensions.
 */
export const specInside = (spec: RunSpec): { spec: RunSpec; mounts: Mount[] } => {
  const mcp = spec.mcp && mcpInside(spec.mcp);
  return {
    spec: { ...spec, cwd: inside.work, ...(mcp && { mcp: mcp.server }) },
    mounts: [...bothubMounts, ...(mcp?.mounts ?? [])],
  };
};

/** A path into bothub's own code mapped to where it is mounted, for harness args that point at it. */
export const bothubArg = (arg: string) =>
  arg.startsWith(`${bothubRoot}/`) ? inside.bothub + arg.slice(bothubRoot.length) : arg;

/** A unique container name for a run or script. */
export const containerName = (id: string) =>
  `bothub-${id.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
