import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { docker, SandboxError, sandboxConfig, type Box } from './sandbox.ts';
import type { Hub } from './schema.ts';

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

/** What a hub's `sandbox` changes in its run containers, resolved when one starts. */
export const hubBox = (sandbox: HubSandbox, hub: string, data?: string) => async (): Promise<Box> => ({
  config: {
    ...(sandbox.setup && { image: await hubImage(sandboxConfig().image, hub, sandbox.setup) }),
    ...(sandbox.memory && { memory: sandbox.memory }),
    ...(sandbox.cpus && { cpus: String(sandbox.cpus) }),
  },
  env: sandbox.env,
  open: sandbox.network === 'open',
  ...(data && { cache: await hubCache(data, hub) }),
});
