import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api } from '../src/api.ts';
import { openStore } from '../src/store.ts';
import { studioDir } from './studio.ts';

const hubDir = join(import.meta.dirname, '..', 'examples', 'acme-app');

/** Every `/api/...` path the studio source names in a string or template literal, with where it appears. */
const studioPaths = () => {
  const src = join(studioDir, 'src');
  const found = new Map<string, string>();
  for (const file of readdirSync(src, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readFileSync(join(src, file), 'utf8');
    for (const m of text.matchAll(/['"`](\/api\/(?:[^'"`\s$]|\$\{[^}]*\})*)/g))
      found.set(m[1]!, `${relative(studioDir, join(src, file))}:${text.slice(0, m.index).split('\n').length}`);
  }
  return found;
};

const setup = async () => {
  const store = openStore(mkdtempSync(join(tmpdir(), 'bothub-contract-')));
  return { handler: api({ hubDir, store }) };
};

const status = async (handler: ReturnType<typeof api>, path: string) => {
  const response = await handler(new Request(`http://127.0.0.1${path}`, { signal: AbortSignal.timeout(2000) }));
  await response.body?.cancel();
  return response.status;
};

describe('studio and API contract', () => {
  it('leaves the studio on core alone: it fetches no v1 API path', () => {
    expect([...studioPaths()]).toEqual([]);
  });

  it('answers 404 for a path it does not serve', async () => {
    const { handler } = await setup();
    expect(await status(handler, '/api/hub/nothing')).toBe(404);
  });
});
