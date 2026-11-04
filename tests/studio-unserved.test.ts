import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { makeUnservedFilter } from '../studio/served.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agi-unserved-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, 'data/stacks-kit/data/cache/work/abc/.git'), { recursive: true });
mkdirSync(join(dir, 'bench/set/hash/arm/case/checkout/.git'), { recursive: true });
symlinkSync(join(dir, 'data'), join(dir, 'link'));
const unserved = makeUnservedFilter([
  { root: join(dir, 'link'), depth: 4 },
  { root: join(dir, 'bench'), depth: Infinity },
]);

const PATHS = [
  ['data/run-1/run.json', false],
  ['link/run-1/run.json', false],
  ['link/stacks-kit/data/run-1/trace.jsonl', false],
  ['data/run-1/tsconfig.json', true],
  ['link/homes/uuid', true],
  ['data/stacks-kit/data/cache/work/abc/kit/tsconfig.json', true],
  ['link/a/b/c/d/e', true],
  ['bench/set/hash/arm/case/r1/data/run-1/run.json', false],
  ['bench/set/hash/arm/case/checkout', true],
  ['bench/set/hash/engine/src/a.ts', true],
  ['bench/set/drive.lock', true],
  ['elsewhere/tsconfig.json', false],
] as const;

it.each(PATHS)('%s is unwatched: %s', (path, skipped) => {
  expect(unserved(join(dir, path))).toBe(skipped);
});
