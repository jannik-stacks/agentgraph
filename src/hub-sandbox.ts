import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { docker, inside, SandboxError, sandboxConfig, type Box } from './sandbox.ts';
import type { Hub } from './schema.ts';
import type { BotEvent } from './types.ts';

type HubSandbox = NonNullable<Hub['sandbox']>;

const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

const dockerfile = (base: string) => `FROM ${base}
USER root
COPY --chmod=755 setup /tmp/bothub-setup
RUN /tmp/bothub-setup && rm /tmp/bothub-setup
USER node
`;

const building = new Map<string, Promise<string>>();

/**
 * The image for a hub's `setup` script run on top of `base`: tagged by the base image's id and the script's content,
 * and built only when that tag is missing.
 * @throws SandboxError when the script is missing or the build fails.
 */
export const hubImage = async (base: string, hub: string, setup: string) => {
  const script = await readFile(resolve(hub, setup), 'utf8').catch(() => {
    throw new SandboxError(`sandbox setup ${setup} not found in the hub`);
  });
  const tag = `bothub-sandbox-hub:${hash(await docker(['image', 'inspect', '--format', '{{.Id}}', base]), script)}`;
  const exists = await docker(['image', 'inspect', '--format', '{{.Id}}', tag]).then(
    () => true,
    () => false
  );
  if (exists) return tag;
  const running = building.get(tag);
  if (running) return running;
  const build = (async () => {
    const context = await mkdtemp(join(tmpdir(), 'bothub-image-'));
    try {
      await writeFile(join(context, 'setup'), script);
      await writeFile(join(context, 'Dockerfile'), dockerfile(base));
      await docker(['build', '--progress', 'plain', '--tag', tag, context], 60 * 60_000);
      return tag;
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  })().finally(() => building.delete(tag));
  building.set(tag, build);
  return build;
};

/** The hub's build cache directory under `data`, created when missing: one per hub, kept between runs. */
export const hubCache = async (data: string, hub: string) => {
  const dir = join(data, 'cache', hash(resolve(hub)));
  await mkdir(dir, { recursive: true });
  return dir;
};

/**
 * Where common package managers and build tools keep their caches inside the hub's cache directory. The package stores
 * check their own contents (by checksum or compiler version), so every run of a hub shares them. Cargo rebuilds by
 * source mtime, and every run's code sits at the same path, so its target directory is the `build` one under `target`.
 */
export const cacheEnv = (build = 'shared') => ({
  CARGO_HOME: `${inside.cache}/cargo`,
  CARGO_TARGET_DIR: `${inside.cache}/target/${build}`,
  npm_config_cache: `${inside.cache}/npm`,
  pnpm_config_store_dir: `${inside.cache}/pnpm-store`,
  GOMODCACHE: `${inside.cache}/go/mod`,
  GOCACHE: `${inside.cache}/go/build`,
  PIP_CACHE_DIR: `${inside.cache}/pip`,
});

/**
 * What a hub's `sandbox` changes in its run containers, resolved when one starts; its `env` wins over `cacheEnv`. Runs
 * on the issue or pull request of `event` keep one build directory, which runs on any other never use.
 */
export const hubBox =
  (sandbox: HubSandbox, hub: string, data?: string, event?: Pick<BotEvent, 'repo' | 'number'>) =>
  async (): Promise<Box> => {
    const build = event?.number === undefined ? undefined : hash(event.repo, String(event.number));
    return {
      config: {
        ...(sandbox.setup && { image: await hubImage(sandboxConfig().image, hub, sandbox.setup) }),
        ...(sandbox.memory && { memory: sandbox.memory }),
        ...(sandbox.cpus && { cpus: String(sandbox.cpus) }),
      },
      env: data ? { ...cacheEnv(build), ...sandbox.env } : sandbox.env,
      open: sandbox.network === 'open',
      ...(data && { cache: await hubCache(data, hub) }),
    };
  };
