import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { makeStudioPagesPlugin } from '../studio/plugins.ts';
import { layouts, makeUnservedFilter } from '../studio/served.ts';
import { studioDir } from './studio.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agi-unserved-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, 'data/stacks-kit/data/cache/work/abc/.git'), { recursive: true });
mkdirSync(join(dir, 'bench/set/data/cache/work/abc/.git'), { recursive: true });
symlinkSync(join(dir, 'data'), join(dir, 'link'));
const unserved = makeUnservedFilter([
  { root: join(dir, 'link'), topic: 'data', layout: layouts.data },
  { root: join(dir, 'bench/set/data'), topic: 'bench', layout: layouts.data },
  { root: join(dir, 'tune'), topic: 'results', layout: layouts.tune },
]);

const PATHS = [
  ['data/run-1/run.json', false],
  ['link/run-1/trace.jsonl', false],
  ['tune/repo/work/tune.json', false],
  ['tune/repo/work/iterations.jsonl', false],
  ['link/stacks-kit/data/run-1/run.json', true],
  ['data/run-1/tsconfig.json', true],
  ['link/homes/uuid', true],
  ['link/cache/work', true],
  ['tune/repo/target-shared/debug/deps', true],
  ['bench/set/data/run-1/run.json', false],
  ['bench/set/data/cache/work/abc', true],
  ['elsewhere/tsconfig.json', false],
] as const;

const SERVED = ['run.json', 'trace.jsonl', 'checks.jsonl', 'labels.jsonl', 'set.json', 'log.jsonl'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

it.each(PATHS)('%s is unwatched: %s', (path, skipped) => {
  expect(unserved(join(dir, path))).toBe(skipped);
});

it.each(SERVED)('watches %s in a bench run', name => {
  expect(unserved(join(dir, 'bench/set/data/run-1', name))).toBe(false);
});

it.each(LOCKFILES)('skips the lockfile %s', name => {
  expect(unserved(join(dir, 'bench/set/data/run-1', name))).toBe(true);
});

it('sends a change for a run record but not for a run checkout', async () => {
  const data = join(dir, 'live');
  mkdirSync(join(data, 'run-1'), { recursive: true });
  mkdirSync(join(data, 'cache/work/abc/.git'), { recursive: true });
  vi.stubEnv('AGI_STUDIO_DIR', undefined);
  vi.stubEnv('AGI_STUDIO_BENCH', undefined);
  vi.stubEnv('AGI_STUDIO_TUNE', undefined);
  vi.stubEnv('AGI_STUDIO_DATA', data);
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({
    configFile: false,
    root: data,
    cacheDir: join(dir, 'vite'),
    plugins: [makeStudioPagesPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    logLevel: 'silent',
  });
  const sent: unknown[] = [];
  const paths: string[] = [];
  server.ws.send = (...args: unknown[]) => void sent.push(args);
  server.watcher.on('all', (_event: string, path: string) => void paths.push(path));
  try {
    await vi.waitFor(
      () => {
        writeFileSync(join(data, 'cache/work/abc/tsconfig.json'), '{}');
        writeFileSync(join(data, 'run-1/run.json'), '{}');
        expect(sent).toContainEqual(['agi:changed', { topics: ['data', 'results', 'bench'] }]);
      },
      { timeout: 4000, interval: 200 }
    );
    expect(paths.filter(path => path.includes('/cache/work/'))).toEqual([]);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});
