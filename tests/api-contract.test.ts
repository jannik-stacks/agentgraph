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
  const run = await store.create({
    workflow: 'w',
    job: 'j',
    harness: 'opencode',
    event: {
      id: 'e',
      ts: '2026-10-12T00:00:00.000Z',
      source: 'cli',
      trigger: 'issue_comment',
      repo: 'acme/app',
      actor: { login: 'morgan', association: 'OWNER' },
    },
  });
  await store.update(run.id, { status: 'succeeded', endedAt: new Date().toISOString() });
  return { handler: api({ hubDir, store, pollMs: 5 }), runId: run.id };
};

const status = async (handler: ReturnType<typeof api>, path: string) => {
  const response = await handler(new Request(`http://127.0.0.1${path}`, { signal: AbortSignal.timeout(2000) }));
  await response.body?.cancel();
  return response.status;
};

describe('studio and API contract', () => {
  it('finds the API paths the studio fetches', () => {
    const paths = [...studioPaths().keys()];
    expect(paths).toContain('/api/hub');
    expect(paths).toContain('/api/stream');
    expect(paths).toContain('/api/info');
  });

  it('serves every API path the studio fetches', async () => {
    const { handler, runId } = await setup();
    const unserved: string[] = [];
    for (const [path, at] of studioPaths()) {
      const concrete = path.replace(/\$\{[^}]*\}/g, runId);
      if ((await status(handler, concrete)) === 404) unserved.push(`${at} ${path}`);
    }
    expect(unserved).toEqual([]);
  });

  it('answers 404 for a path it does not serve', async () => {
    const { handler } = await setup();
    expect(await status(handler, '/api/hub/nothing')).toBe(404);
  });
});
