import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheEnv, hubBox, hubCache, hubImage } from '../src/hub-sandbox.ts';
import { SandboxError } from '../src/sandbox.ts';
import { temp } from './kit.ts';

describe('hubBox', () => {
  it('keeps the base image without a setup script, and one cache per hub', async () => {
    const data = temp('hub-sandbox');
    const sandbox = { env: { CARGO_TARGET_DIR: '/work/target' }, network: 'open' as const, memory: '10g', cpus: 8 };
    const box = await hubBox(sandbox, '/hubs/a', data)();
    expect(box).toEqual({
      config: { memory: '10g', cpus: '8' },
      env: { ...cacheEnv, CARGO_TARGET_DIR: '/work/target' },
      open: true,
      cache: await hubCache(data, '/hubs/a'),
    });
    expect(existsSync(box.cache!)).toBe(true);
    expect(await hubCache(data, '/hubs/b')).not.toBe(box.cache);
    expect(await hubBox({ env: {}, network: 'allowlist' }, '/hubs/a')()).toEqual({ config: {}, env: {}, open: false });
  });

  it('fails as a sandbox error on a setup script it cannot find', async () => {
    const hub = temp('hub-sandbox');
    await expect(hubImage('bothub-sandbox:local', hub, join('sandbox', 'setup.sh'))).rejects.toThrow(SandboxError);
  });
});
